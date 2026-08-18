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
/** 문단 텍스트 레코드 */
const HWPTAG_PARA_TEXT = HWPTAG_BEGIN + 51; // 67

/** FileHeader 속성 플래그의 압축 여부 비트 */
const FLAG_COMPRESSED = 0x01;

export class HwpParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HwpParseError';
  }
}

// ── HWP 5.0 (바이너리) ───────────────────────────────────────

/**
 * HWP 레코드 스트림을 순회하며 문단 텍스트를 뽑는다.
 *
 * 레코드 헤더는 4바이트 리틀엔디언 비트필드:
 *   [0..9]   tagID (10bit)
 *   [10..19] level (10bit)
 *   [20..31] size  (12bit) — 0xFFF이면 뒤따르는 4바이트가 실제 크기
 */
function extractTextFromRecords(data: Uint8Array): string[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const paragraphs: string[] = [];
  let pos = 0;

  while (pos + 4 <= data.length) {
    const header = view.getUint32(pos, true);
    pos += 4;

    const tagId = header & 0x3ff;
    let size = (header >> 20) & 0xfff;

    if (size === 0xfff) {
      if (pos + 4 > data.length) break;
      size = view.getUint32(pos, true);
      pos += 4;
    }

    if (pos + size > data.length) break;

    if (tagId === HWPTAG_PARA_TEXT) {
      paragraphs.push(decodeParaText(data.subarray(pos, pos + size)));
    }

    pos += size;
  }

  return paragraphs;
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

  const paragraphs: string[] = [];
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
    paragraphs.push(...extractTextFromRecords(data));
  }

  return paragraphs.join('\n');
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
 * HWP/HWPX 파일에서 순수 텍스트를 추출합니다.
 * 확장자가 아니라 파일 시그니처로 포맷을 판별합니다 (확장자만 바꾼 파일 대응).
 */
export async function extractTextFromHwp(buffer: Buffer, fileName: string): Promise<string> {
  // ZIP 시그니처("PK")면 HWPX
  const isZip = buffer.length > 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;

  const text = isZip ? await extractHwpx(buffer) : extractHwp(buffer);
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  if (!normalized) {
    throw new HwpParseError(
      `${fileName}에서 텍스트를 추출하지 못했습니다. 이미지만 있는 문서이거나 암호가 걸린 문서일 수 있습니다.`
    );
  }

  return normalized;
}
