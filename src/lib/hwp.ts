/**
 * HWP / HWPX 텍스트 추출기.
 *
 * RAG 인덱싱용 순수 텍스트만 뽑습니다. 서식·레이아웃·이미지는 다루지 않습니다.
 *
 * 두 포맷을 모두 지원합니다:
 *  - .hwp   HWP 5.0 바이너리 (MS CFB 컨테이너 + 레코드 스트림)
 *  - .hwpx  한글 2014+ 개방형 포맷 (ZIP + XML) — 훨씬 단순하고 안정적
 *
 * 외부 HWP 파서 패키지(hwp.js v0.0.3)를 쓰지 않고 직접 구현한 이유:
 * 해당 패키지는 4년간 미유지보수 상태이고 파싱과 무관한 DOM 뷰어를 함께
 * 번들합니다. HWP 지원은 이 제품의 핵심 차별점이라 방치된 외부 패키지에
 * 의존하지 않고, 그 패키지가 쓰는 것과 동일한 저수준 라이브러리
 * (cfb, pako)로 필요한 부분만 구현합니다.
 */

import * as CFB from 'cfb';
import { inflate, inflateRaw } from 'pako';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';

// ── HWP 5.0 레코드 태그 ──────────────────────────────────────
// 참고: 한글과컴퓨터 「한/글 문서 파일 형식」 공개 문서
const HWPTAG_BEGIN = 0x10;
const HWPTAG_PARA_HEADER = HWPTAG_BEGIN + 50; // 66 문단 헤더
const HWPTAG_PARA_TEXT = HWPTAG_BEGIN + 51; // 67 문단 텍스트
const HWPTAG_CTRL_HEADER = HWPTAG_BEGIN + 55; // 71 컨트롤 헤더
const HWPTAG_LIST_HEADER = HWPTAG_BEGIN + 56; // 72 문단 리스트 헤더 (표에서는 셀 하나)
const HWPTAG_TABLE = HWPTAG_BEGIN + 61; // 77 표 정보

/** FileHeader 속성 플래그의 압축 여부 비트 */
const FLAG_COMPRESSED = 0x01;

export class HwpParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HwpParseError';
  }
}

// ── HWP 5.0 (바이너리) ───────────────────────────────────────

interface HwpRecord {
  tagId: number;
  payload: Uint8Array;
  children: HwpRecord[];
}

/**
 * HWP 레코드 스트림을 트리로 파싱한다.
 *
 * 레코드 헤더는 4바이트 리틀엔디언 비트필드:
 *   [0..9]   tagID (10bit)
 *   [10..19] level (10bit) — 이 값으로 부모-자식 관계가 정해진다
 *   [20..31] size  (12bit) — 0xFFF이면 뒤따르는 4바이트가 실제 크기
 *
 * 표는 CTRL_HEADER(level N) 아래에 TABLE, LIST_HEADER(셀 선언), 셀 내용
 * PARA_HEADER가 모두 level N+1 형제로 나열된다. LIST_HEADER가 부모가 아니라
 * "뒤따르는 N개 문단이 이 셀"이라고 선언하는 방식이다 (renderTable 참조).
 */
function parseRecordTree(data: Uint8Array): HwpRecord[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const roots: HwpRecord[] = [];
  // stack[n] = 현재 level n인 레코드
  const stack: HwpRecord[] = [];
  let pos = 0;

  while (pos + 4 <= data.length) {
    const header = view.getUint32(pos, true);
    pos += 4;

    const tagId = header & 0x3ff;
    const level = (header >> 10) & 0x3ff;
    let size = (header >> 20) & 0xfff;

    if (size === 0xfff) {
      if (pos + 4 > data.length) break;
      size = view.getUint32(pos, true);
      pos += 4;
    }

    if (pos + size > data.length) break;

    const record: HwpRecord = {
      tagId,
      payload: data.subarray(pos, pos + size),
      children: [],
    };

    const parent = stack[level - 1];
    if (level === 0 || !parent) {
      roots.push(record);
    } else {
      parent.children.push(record);
    }

    stack[level] = record;
    stack.length = level + 1;

    pos += size;
  }

  return roots;
}

/**
 * 8 wchar(=16바이트)를 차지하는 제어 문자 코드.
 *
 * HWP 5.0 스펙상 제어 문자는 세 종류다:
 *   - CHAR     (1 wchar): 0, 10, 13, 24~31
 *   - INLINE   (8 wchar): 4~9, 19, 20        ← 탭(9)도 여기 포함
 *   - EXTENDED (8 wchar): 1~3, 11, 12, 14~18, 21~23
 *
 * INLINE과 EXTENDED는 자기 자신 1 wchar를 포함해 총 8 wchar를 차지하므로
 * 읽은 뒤 7 wchar(14바이트)를 더 건너뛰어야 한다. 건너뛰지 않으면 이후
 * 바이트 정렬이 어긋나 본문 전체가 깨진다.
 */
const WIDE_CONTROL_CODES = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
]);
const WIDE_CONTROL_SKIP_BYTES = 14;

/** PARA_TEXT 레코드는 UTF-16LE 문자열이며 중간에 제어 문자가 섞여 있다. */
function decodeParaText(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: string[] = [];
  let i = 0;

  while (i + 2 <= bytes.length) {
    const code = view.getUint16(i, true);
    i += 2;

    if (code > 31) {
      out.push(String.fromCharCode(code));
      continue;
    }

    // 탭은 폭이 넓은 컨트롤이지만 본문에서는 의미가 있으므로 문자로 남긴다
    if (code === 9) out.push('\t');
    // 줄바꿈(10) / 문단 구분(13)
    else if (code === 10 || code === 13) out.push('\n');
    // 묶음 빈칸(30) / 고정폭 빈칸(31)
    else if (code === 30 || code === 31) out.push(' ');

    if (WIDE_CONTROL_CODES.has(code)) {
      i += WIDE_CONTROL_SKIP_BYTES;
    }
  }

  return out.join('');
}

// ── 표 복원 ──────────────────────────────────────────────────

/**
 * CTRL_HEADER의 컨트롤 ID. 4바이트에 역순으로 저장돼 있다.
 * 표는 "tbl " 이다.
 */
function readCtrlId(payload: Uint8Array): string {
  if (payload.length < 4) return '';
  return String.fromCharCode(payload[3], payload[2], payload[1], payload[0]);
}

/**
 * 표 셀의 위치·병합 정보.
 *
 * LIST_HEADER 본문 바이트 배치 (실제 공문서로 실측 확인):
 *   0  INT32   문단 수
 *   4  UINT32  속성
 *   8  UINT16  열 주소 (0부터)
 *   10 UINT16  행 주소 (0부터)
 *   12 UINT16  열 병합 수
 *   14 UINT16  행 병합 수
 */
interface TableCell {
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
  text: string;
}

/** LIST_HEADER가 선언하는, 이 셀에 속한 문단 개수 */
function readParagraphCount(payload: Uint8Array): number {
  if (payload.length < 4) return 1;
  const count = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength
  ).getInt32(0, true);
  return count > 0 ? count : 1;
}

function readCellPosition(payload: Uint8Array): Omit<TableCell, 'text'> | null {
  if (payload.length < 16) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    col: view.getUint16(8, true),
    row: view.getUint16(10, true),
    colSpan: Math.max(1, view.getUint16(12, true)),
    rowSpan: Math.max(1, view.getUint16(14, true)),
  };
}

/** 표를 마크다운 표로 렌더링한다. 열 머리글이 각 값과 함께 읽히도록. */
function renderTable(ctrlHeader: HwpRecord): string {
  const tableInfo = ctrlHeader.children.find((c) => c.tagId === HWPTAG_TABLE);
  if (!tableInfo || tableInfo.payload.length < 8) return renderChildren(ctrlHeader.children);

  const infoView = new DataView(
    tableInfo.payload.buffer,
    tableInfo.payload.byteOffset,
    tableInfo.payload.byteLength
  );
  const rowCount = infoView.getUint16(4, true);
  const colCount = infoView.getUint16(6, true);

  if (rowCount === 0 || colCount === 0 || rowCount > 500 || colCount > 100) {
    // 값이 비상식적이면 표로 취급하지 않고 본문처럼 이어붙인다
    return renderChildren(ctrlHeader.children);
  }

  // LIST_HEADER와 셀 내용은 부모-자식이 아니라 형제로 나열된다.
  // LIST_HEADER가 "뒤따르는 N개 문단이 이 셀"이라고 선언하는 구조라
  // 순서대로 훑으면서 다음 LIST_HEADER 전까지를 해당 셀의 내용으로 묶는다.
  const cells: TableCell[] = [];
  const children = ctrlHeader.children;

  for (let i = 0; i < children.length; i++) {
    if (children[i].tagId !== HWPTAG_LIST_HEADER) continue;

    const position = readCellPosition(children[i].payload);
    if (!position) continue;

    const paragraphCount = readParagraphCount(children[i].payload);
    const content: HwpRecord[] = [];
    let consumed = 0;
    let j = i + 1;

    while (j < children.length && children[j].tagId !== HWPTAG_LIST_HEADER) {
      content.push(children[j]);
      if (children[j].tagId === HWPTAG_PARA_HEADER) {
        consumed++;
        if (consumed >= paragraphCount) {
          j++;
          break;
        }
      }
      j++;
    }

    cells.push({
      ...position,
      // 셀 안의 줄바꿈은 표 한 칸에 들어가야 하므로 공백으로 바꾼다
      text: renderChildren(content).replace(/\s+/g, ' ').trim(),
    });

    i = j - 1;
  }

  if (cells.length === 0) return '';

  // 병합된 셀은 차지하는 자리를 모두 채워 열이 밀리지 않게 한다
  const grid: string[][] = Array.from({ length: rowCount }, () =>
    Array.from({ length: colCount }, () => '')
  );
  for (const cell of cells) {
    for (let r = cell.row; r < Math.min(cell.row + cell.rowSpan, rowCount); r++) {
      for (let c = cell.col; c < Math.min(cell.col + cell.colSpan, colCount); c++) {
        // 병합된 나머지 칸은 비워 두고 시작 칸에만 내용을 넣는다
        grid[r][c] = r === cell.row && c === cell.col ? cell.text : '';
      }
    }
  }

  const escape = (value: string) => value.replace(/\|/g, '\\|');
  const toRow = (values: string[]) => `| ${values.map(escape).join(' | ')} |`;

  const lines = [toRow(grid[0]), `|${' --- |'.repeat(colCount)}`];
  for (let r = 1; r < rowCount; r++) lines.push(toRow(grid[r]));

  return lines.join('\n');
}

/** 레코드 트리를 훑어 본문 텍스트를 만든다 */
function renderChildren(records: HwpRecord[]): string {
  const parts: string[] = [];

  for (const record of records) {
    if (record.tagId === HWPTAG_PARA_TEXT) {
      parts.push(decodeParaText(record.payload));
      continue;
    }

    if (record.tagId === HWPTAG_CTRL_HEADER && readCtrlId(record.payload) === 'tbl ') {
      const table = renderTable(record);
      if (table) parts.push(table);
      continue;
    }

    if (record.children.length > 0) {
      const nested = renderChildren(record.children);
      if (nested) parts.push(nested);
    }
  }

  return parts.join('\n');
}

/** 압축된 스트림이면 풀고, 아니면 그대로 반환 */
function maybeInflate(raw: Uint8Array, compressed: boolean): Uint8Array {
  if (!compressed) return raw;
  try {
    // HWP는 zlib 헤더 없는 raw deflate로 저장한다
    return inflateRaw(raw);
  } catch {
    // 일부 문서는 zlib 헤더를 포함한다
    return inflate(raw);
  }
}

function extractHwp(buffer: Buffer): string {
  let container: CFB.CFB$Container;
  try {
    container = CFB.read(buffer, { type: 'buffer' });
  } catch (err: any) {
    throw new HwpParseError(
      `HWP 파일 구조를 읽을 수 없습니다. 손상되었거나 HWP 5.0 형식이 아닐 수 있습니다. (${err?.message ?? '알 수 없는 오류'})`
    );
  }

  const fileHeader = container.FileIndex.find((entry) => entry.name === 'FileHeader');
  if (!fileHeader?.content) {
    throw new HwpParseError('HWP 파일이 아닙니다. (FileHeader 없음)');
  }

  // FileHeader의 36번째 바이트부터 4바이트가 속성 플래그
  const headerBytes = Uint8Array.from(fileHeader.content as ArrayLike<number>);
  const compressed =
    headerBytes.length >= 40 &&
    (new DataView(headerBytes.buffer).getUint32(36, true) & FLAG_COMPRESSED) !== 0;

  // BodyText/Section0, Section1, ... 을 번호 순서대로 모은다
  const sections = container.FileIndex.filter(
    (entry) => /^Section\d+$/.test(entry.name) && entry.content
  ).sort((a, b) => {
    const n = (s: string) => parseInt(s.replace('Section', ''), 10);
    return n(a.name) - n(b.name);
  });

  if (sections.length === 0) {
    throw new HwpParseError('본문(BodyText)을 찾을 수 없습니다.');
  }

  const parts: string[] = [];
  for (const section of sections) {
    const raw = Uint8Array.from(section.content as ArrayLike<number>);
    let data: Uint8Array;
    try {
      data = maybeInflate(raw, compressed);
    } catch (err: any) {
      // 한 섹션이 깨져도 나머지는 살린다
      console.warn(`[hwp] ${section.name} 압축 해제 실패, 건너뜀:`, err?.message);
      continue;
    }
    parts.push(renderChildren(parseRecordTree(data)));
  }

  return parts.join('\n');
}

// ── HWPX (ZIP + XML) ─────────────────────────────────────────

/** XML 노드 트리를 훑어 본문 텍스트를 순서대로 수집 */
function collectHwpxText(node: unknown, out: string[]): void {
  if (node == null) return;

  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return;
  }

  if (Array.isArray(node)) {
    for (const child of node) collectHwpxText(child, out);
    return;
  }

  if (typeof node !== 'object') return;

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.startsWith('@_')) continue; // 속성은 본문이 아니다

    // 문단 경계마다 줄바꿈을 넣어 문맥이 뭉개지지 않게 한다
    if (key === 'hp:p' || key === 'p') {
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) {
        collectHwpxText(item, out);
        out.push('\n');
      }
      continue;
    }

    collectHwpxText(value, out);
  }
}

async function extractHwpx(buffer: Buffer): Promise<string> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err: any) {
    throw new HwpParseError(
      `HWPX 파일을 열 수 없습니다. (${err?.message ?? '알 수 없는 오류'})`
    );
  }

  // 본문은 Contents/section0.xml, section1.xml ... 에 들어 있다
  const sectionFiles = Object.keys(zip.files)
    .filter((name) => /Contents\/section\d+\.xml$/i.test(name))
    .sort();

  if (sectionFiles.length === 0) {
    throw new HwpParseError('HWPX 본문(Contents/section*.xml)을 찾을 수 없습니다.');
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    textNodeName: '#text',
    trimValues: false,
  });

  const chunks: string[] = [];
  for (const name of sectionFiles) {
    const xml = await zip.files[name].async('string');
    const out: string[] = [];
    collectHwpxText(parser.parse(xml), out);
    chunks.push(out.join(''));
  }

  return chunks.join('\n');
}

// ── 공개 API ─────────────────────────────────────────────────

export function isHwpFile(fileName: string, mimeType?: string): boolean {
  const lower = fileName.toLowerCase();
  return (
    lower.endsWith('.hwp') ||
    lower.endsWith('.hwpx') ||
    mimeType === 'application/x-hwp' ||
    mimeType === 'application/haansofthwp' ||
    mimeType === 'application/hwp+zip'
  );
}

/**
 * 사용자 정의 영역(PUA) 문자인지.
 *
 * 한글은 공문서의 구분선·결재란 같은 장식을 전용 글꼴의 PUA 문자로 그린다.
 * (실측: 어느 공문 1건에서 U+F080F 85개, U+F0317 91개 — 문서의 9.8%)
 * 의미 없는 문자인데 임베딩 토큰만 잡아먹고 청크 내용을 오염시키므로 버린다.
 */
function isPrivateUse(codePoint: number): boolean {
  return (
    (codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
    (codePoint >= 0xf0000 && codePoint <= 0xffffd) ||
    (codePoint >= 0x100000 && codePoint <= 0x10fffd)
  );
}

/** RAG 인덱싱에 쓸 수 있도록 장식 문자와 빈 줄을 정리한다 */
function normalize(text: string): string {
  const withoutPua = Array.from(text)
    .filter((ch) => !isPrivateUse(ch.codePointAt(0) ?? 0))
    .join('');

  return withoutPua
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    // 빈 줄이 연속되면 하나로 — 원문 레이아웃상 빈 문단이 많다
    .filter((line, index, lines) => line.trim() !== '' || lines[index - 1]?.trim() !== '')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * HWP/HWPX 파일에서 순수 텍스트를 추출합니다.
 * 확장자가 아니라 파일 시그니처로 포맷을 판별합니다 (확장자만 바꾼 파일 대응).
 */
export async function extractTextFromHwp(buffer: Buffer, fileName: string): Promise<string> {
  // ZIP 시그니처("PK")면 HWPX
  const isZip = buffer.length > 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;

  const text = isZip ? await extractHwpx(buffer) : extractHwp(buffer);
  const normalized = normalize(text);

  if (!normalized) {
    throw new HwpParseError(
      `${fileName}에서 텍스트를 추출하지 못했습니다. 이미지만 있는 문서이거나 암호가 걸린 문서일 수 있습니다.`
    );
  }

  return normalized;
}
