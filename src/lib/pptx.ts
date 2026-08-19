import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';

/**
 * 발표자료(PPTX) 텍스트 추출.
 *
 * 공공기관은 보고·발표 자료가 PPTX로 쌓인다 — 업무보고, 사업설명회,
 * 정책브리핑. 지금까지 이 형식을 아예 못 올렸다.
 *
 * **슬라이드 경계를 남긴다.** 전부 이어붙이면 "몇 페이지에 있는 내용이냐"는
 * 질문에 답할 수 없고, 담당자는 원본에서 그 자리를 찾아야 한다. 발표자료는
 * 슬라이드 단위로 논의되는 문서라 이 경계가 곧 출처다.
 *
 * **표는 마크다운 표로 복원한다.** 셀을 순서대로 이어붙이면 열 머리글과 값의
 * 대응이 끊긴다. `hwp.ts`·`spreadsheet.ts`·`pdf-ocr.ts`가 모두 같은 결론에
 * 도달했고 여기서도 같은 형태로 맞춘다.
 *
 * 새 업체나 새 의존이 필요 없다 — PPTX는 zip + XML이고 `jszip`·
 * `fast-xml-parser`는 HWPX 처리를 위해 이미 들어와 있다.
 */

const PPTX_EXTENSIONS = ['.pptx'];

const PPTX_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // 브라우저·그룹웨어가 이 값으로 보내는 경우가 있다
  'application/vnd.ms-powerpoint',
];

export function isPptxFile(fileName: string, mimeType?: string): boolean {
  const lower = fileName.toLowerCase();
  if (PPTX_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  return !!mimeType && PPTX_MIME_TYPES.includes(mimeType);
}

/** 슬라이드가 아무리 많아도 여기까지만. 임베딩 비용이 선형으로 는다. */
const MAX_SLIDES = 300;

export class PptxParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PptxParseError';
  }
}

/**
 * `ppt/slides/slide12.xml` 에서 12를 뽑는다.
 *
 * 파일명 문자열로 정렬하면 slide10이 slide2보다 앞에 온다. 발표자료는
 * 순서가 곧 내용이라(현황 → 문제 → 대안) 뒤섞이면 흐름이 무너진다.
 */
function slideNumber(name: string): number {
  const m = name.match(/slide(\d+)\.xml$/i);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/** 마크다운 표에서 파이프는 열 구분자라 그대로 두면 칸이 밀린다. */
function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * 한 문단(`a:p`)의 텍스트.
 *
 * 글자는 `a:r`(런) 안의 `a:t`에 들어 있는데, 서식이 바뀔 때마다 런이 쪼개진다.
 * "2026년도 예산"이 ["2026", "년도 ", "예산"] 세 런으로 오는 식이라 런 사이에는
 * 공백을 넣지 않고 그대로 붙인다.
 */
function paragraphText(node: unknown): string {
  const out: string[] = [];
  collectText(node, out);
  return out.join('').replace(/\s+/g, ' ').trim();
}

function collectText(node: unknown, out: string[]): void {
  if (node == null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out);
    return;
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    // a:t 가 실제 글자다. 속성만 있는 태그는 파서가 객체로 주므로 문자열·숫자만 받는다.
    if (key === 'a:t') {
      for (const t of asArray(value)) {
        if (typeof t === 'string' || typeof t === 'number') {
          out.push(String(t));
        } else if (t && typeof t === 'object' && '#text' in (t as object)) {
          out.push(String((t as Record<string, unknown>)['#text'] ?? ''));
        }
      }
      continue;
    }
    // a:br 은 문단 안의 줄바꿈이다. 한 문단은 한 줄로 다루므로 공백으로 바꾼다.
    if (key === 'a:br') {
      out.push(' ');
      continue;
    }
    // 속성(@_로 시작)은 글자가 아니다
    if (key.startsWith('@_') || key === '#text') continue;

    collectText(value, out);
  }
}

/** `a:tbl` 하나를 마크다운 표로. 첫 행을 머리글로 본다. */
function renderTable(tbl: Record<string, unknown>): string {
  const rows: string[][] = [];

  for (const tr of asArray(tbl['a:tr'] as unknown)) {
    const cells: string[] = [];
    for (const tc of asArray((tr as Record<string, unknown>)?.['a:tc'] as unknown)) {
      const txBody = (tc as Record<string, unknown>)?.['a:txBody'];
      const paras = asArray((txBody as Record<string, unknown>)?.['a:p'] as unknown);
      // 셀 안의 여러 문단은 한 칸에 들어가야 하므로 공백으로 잇는다
      cells.push(escapeCell(paras.map(paragraphText).filter(Boolean).join(' ')));
    }
    if (cells.length > 0) rows.push(cells);
  }

  if (rows.length === 0) return '';

  const width = Math.max(...rows.map((r) => r.length));
  const pad = (row: string[]) => Array.from({ length: width }, (_, i) => row[i] ?? '');

  const [head, ...body] = rows;
  return [
    `| ${pad(head).join(' | ')} |`,
    `| ${Array(width).fill('---').join(' | ')} |`,
    ...body.map((row) => `| ${pad(row).join(' | ')} |`),
  ].join('\n');
}

/**
 * 슬라이드 XML에서 도형·표를 순서대로 훑는다.
 *
 * 표를 먼저 뽑아 두고 나머지 텍스트를 따로 모으는 방식이면 표 안의 글자가
 * 두 번 나온다. 대신 트리를 한 번만 내려가면서 `a:tbl`을 만나면 표로
 * 렌더링하고 **그 아래로는 더 내려가지 않는다.**
 */
function collectSlide(node: unknown, out: string[]): void {
  if (node == null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) collectSlide(item, out);
    return;
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.startsWith('@_') || key === '#text') continue;

    if (key === 'a:tbl') {
      for (const tbl of asArray(value)) {
        const table = renderTable(tbl as Record<string, unknown>);
        if (table) out.push(table);
      }
      // 표 안으로 다시 들어가면 셀 글자가 중복된다
      continue;
    }

    if (key === 'a:p') {
      for (const p of asArray(value)) {
        const text = paragraphText(p);
        if (text) out.push(text);
      }
      continue;
    }

    collectSlide(value, out);
  }
}

/**
 * 슬라이드에 딸린 발표자 노트.
 *
 * 관계 파일(`_rels`)을 따라가는 것이 정확하지만, 실제 PPTX는 슬라이드 번호와
 * 노트 번호가 일치한다. 관계 해석까지 넣으면 코드가 두 배가 되고 얻는 것이
 * 적어 번호 대응으로 둔다 — 어긋나면 노트가 빠질 뿐 본문은 멀쩡하다.
 */
async function extractNotes(
  zip: JSZip,
  slidePath: string,
  parser: XMLParser
): Promise<string> {
  const n = slideNumber(slidePath);
  const file = zip.files[`ppt/notesSlides/notesSlide${n}.xml`];
  if (!file) return '';

  try {
    const parts: string[] = [];
    collectSlide(parser.parse(await file.async('string')), parts);
    // 노트 자리에는 슬라이드 번호만 든 자리표시자가 들어 있곤 한다
    return parts.filter((p) => p.trim() && p.trim() !== String(n)).join(' ');
  } catch {
    return '';
  }
}

export async function extractTextFromPptx(fileBuffer: Buffer): Promise<string> {
  // 구형 .ppt(CFB)는 zip이 아니다. 그대로 열면 "파일을 열 수 없습니다"만 나와
  // 담당자가 원인을 알 수 없다. 공공기관에는 옛 .ppt가 많으므로 따로 안내한다.
  if (fileBuffer.length > 1 && !(fileBuffer[0] === 0x50 && fileBuffer[1] === 0x4b)) {
    throw new PptxParseError(
      '구형 PPT 형식은 지원하지 않습니다. PowerPoint에서 PPTX로 저장한 뒤 올려주세요.'
    );
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(fileBuffer);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '알 수 없는 오류';
    throw new PptxParseError(`PPTX 파일을 열 수 없습니다. (${message})`);
  }

  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  if (slideFiles.length === 0) {
    throw new PptxParseError(
      'PPTX 슬라이드를 찾을 수 없습니다. 빈 파일이거나 손상된 파일인지 확인해주세요.'
    );
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    textNodeName: '#text',
    // **다듬지 않는다.** PowerPoint는 런 끝의 공백을 xml:space="preserve"로
    // 보존하는데, 파서가 그걸 지우면 "2026" + "년도 " + "예산"이
    // "2026년도예산"으로 붙는다. 태그 사이 들여쓰기는 #text 노드로 들어오고
    // 우리는 그 키를 건너뛰므로 섞이지 않는다.
    trimValues: false,
  });

  const sections: string[] = [];
  const shown = slideFiles.slice(0, MAX_SLIDES);

  for (const path of shown) {
    const parts: string[] = [];

    try {
      collectSlide(parser.parse(await zip.files[path].async('string')), parts);
    } catch {
      // 슬라이드 하나가 깨져도 나머지는 살린다. 발표자료는 장수가 많고
      // 한 장 때문에 전체를 못 쓰게 되면 손해가 크다.
      continue;
    }

    // 발표자 노트는 화면에 없는 설명이라 본문보다 상세한 경우가 많다.
    const notes = await extractNotes(zip, path, parser);
    if (notes) parts.push(`[발표자 노트] ${notes}`);

    if (parts.length === 0) continue;

    // 슬라이드 번호는 파일명에서 가져온다. 배열 순번을 쓰면 빈 슬라이드를
    // 건너뛴 만큼 어긋나 원본에서 그 자리를 못 찾는다.
    sections.push(`## 슬라이드 ${slideNumber(path)}\n\n${parts.join('\n\n')}`);
  }

  if (sections.length === 0) {
    throw new PptxParseError(
      '발표자료에서 글자를 찾지 못했습니다. 이미지로만 이루어진 자료인지 확인해주세요.'
    );
  }

  const note =
    slideFiles.length > shown.length
      ? `\n\n[슬라이드가 많아 앞 ${shown.length}장만 포함했습니다. 전체 ${slideFiles.length}장]`
      : '';

  return sections.join('\n\n') + note;
}
