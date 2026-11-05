/**
 * HWPX 본문에 표 넣기 — 칸 글만 받아 표 XML은 프로그램이 만든다(모델이 XML을 만들지 않는다).
 *
 * 표 자리는 채우기 엔진이 넣은 **표지 문단**(글 전체가 `tableMarker(i)`인 본문 최상위 문단)이고,
 * 그 문단을 표 하나를 품은 문단으로 바꾼다(문단·글자 서식은 표지 문단의 것을 쓴다).
 * 칸 테두리·머리 행 바탕(borderFill)과 머리 행 굵은 글자(charPr), 열 정렬 문단 서식(paraPr)은 header.xml 목록 **끝에 더한다** — 기존 항목·번호는 그대로다.
 * 줄 배치 캐시(linesegarray)는 넣지 않는다 — 한글이 열 때 다시 계산한다.
 * 표지를 하나라도 못 찾으면 던진다 — 표가 조용히 빠진 파일을 내지 않는다.
 */
import { DocFillError } from './errors';
import { openHwpx, readEntry, scanParagraphs, writeHwpx, textXml, applyEdits, type Edit } from './hwpx-core';
import { paragraphPrefix } from './xml-scan';

export type HwpxColumnAlign = 'left' | 'center' | 'right' | null;
/** 칸 안 글 조각 — 'ins'는 밑줄(새로 넣은 글), 'del'은 취소선(지운 글). 신구대비표가 쓴다(2026-11-05) */
export interface HwpxRun {
  text: string;
  mark: 'ins' | 'del' | null;
}
export interface HwpxTable {
  header: string[];
  rows: string[][];
  /** 열 정렬(머리 행·본문 행 모두). 없거나 null이면 표지 문단의 정렬 그대로 */
  align?: HwpxColumnAlign[];
  /**
   * 본문 칸의 글 조각(rows와 같은 자리). 있으면 그 칸은 rows 글 대신 조각을 한 문단에 잇고, 표시한 조각은
   * 칸 글자 서식에 밑줄·취소선만 더한 사본으로 쓴다. 표지 문단에 글자 서식이 없으면 표시 없이 글만 잇는다
   */
  runs?: (HwpxRun[] | null | undefined)[][];
  /** 열 폭 비율(열 수와 같을 때만). 없으면 칸 글 길이로 정한다 */
  widths?: number[];
}
const HORIZONTAL = { left: 'LEFT', center: 'CENTER', right: 'RIGHT' } as const;

/** 이보다 큰 표는 표로 넣지 않는다(부르는 쪽이 글로 넣는다) — 한글에서 다루기 어려운 크기 */
export const MAX_HWPX_TABLE_COLS = 20;
export const MAX_HWPX_TABLE_ROWS = 500;

const HEADER = 'Contents/header.xml';
/** 본문 폭을 못 읽을 때 — A4 세로에 좌우 여백 30mm */
const DEFAULT_BODY_WIDTH = 42520;
const OUT_MARGIN = 141;
const ROW_HEIGHT = 282;
const IN_MARGIN_X = 510;
const IN_MARGIN_Y = 283;
const MIN_COL_WIDTH = 1700;
const HEAD_FILL = '#E7ECF4';

export const tableColumnCount = (t: HwpxTable) => Math.max(t.header.length, ...t.rows.map((r) => r.length), 1);
export const tableFits = (t: HwpxTable) => tableColumnCount(t) <= MAX_HWPX_TABLE_COLS && t.rows.length + 1 <= MAX_HWPX_TABLE_ROWS;

/** 표 자리 표지 — 사용자 영역 글자(U+E000)로 감싸 답 글과 겹치지 않는다 */
export function tableMarker(index: number): string {
  return `표${index + 1}`;
}
const MARKER = /^표(\d+)$/;

/** 칸 글 폭 — 한글·전각은 2칸 */
function displayWidth(s: string): number {
  let n = 0;
  for (const ch of s) n += /[ᄀ-ᇿ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return n;
}

/**
 * 열 폭 — 칸 안 여백(고정) + 가장 긴 줄의 글 폭(반각 한 칸 = 500, 4~40칸으로 자름)에 비례, 합은 total.
 * 여백을 빼고 비례하면 짧은 열('3월~5월')이 여백에 먹혀 줄이 꺾인다. 좁아지면 똑같이 나눈다
 */
export function columnWidths(t: HwpxTable, total: number): number[] {
  const cols = tableColumnCount(t);
  // 부르는 쪽이 정한 비율이 있으면 그대로(열 수와 같고 모두 양수일 때만)
  if (t.widths && t.widths.length === cols && t.widths.every((w) => Number.isFinite(w) && w > 0)) {
    const sum = t.widths.reduce((a, b) => a + b, 0);
    const fixed = t.widths.map((w) => Math.floor((total * w) / sum));
    fixed[cols - 1] += total - fixed.reduce((a, b) => a + b, 0);
    return fixed;
  }
  const weights = Array.from({ length: cols }, (_, c) => {
    const longest = Math.max(4, ...[t.header, ...t.rows].flatMap((r) => (r[c] ?? '').split(/<br\s*\/?>/i)).map((l) => displayWidth(l.trim())));
    return IN_MARGIN_X * 2 + 200 + Math.min(40, longest) * 500;
  });
  const sum = weights.reduce((a, b) => a + b, 0);
  let widths = weights.map((w) => Math.floor((total * w) / sum));
  if (widths.some((w) => w < MIN_COL_WIDTH)) widths = weights.map(() => Math.floor(total / cols));
  widths[cols - 1] += total - widths.reduce((a, b) => a + b, 0);
  return widths;
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : null;
}

/** 첫 구역의 쪽 폭 − 좌우 여백 */
function bodyWidth(xml: string, prefix: string): number {
  const page = xml.match(new RegExp(`<${prefix}:pagePr\\s[^>]*>`));
  const margin = xml.match(new RegExp(`<${prefix}:margin\\s[^>]*>`));
  const width = page ? Number(attr(page[0], 'width')) : NaN;
  const landscape = page ? attr(page[0], 'landscape') : null;
  const height = page ? Number(attr(page[0], 'height')) : NaN;
  // 한글은 가로 쪽(NARROWLY)이면 width·height를 바꿔 읽는다
  const pageWidth = landscape === 'NARROWLY' && Number.isFinite(height) ? height : width;
  const left = margin ? Number(attr(margin[0], 'left')) : NaN;
  const right = margin ? Number(attr(margin[0], 'right')) : NaN;
  const body = pageWidth - left - right;
  return Number.isFinite(body) && body > 5000 ? body : DEFAULT_BODY_WIDTH;
}

/** header.xml 목록(borderFills·charProperties·paraProperties) 끝에 항목을 더하고 itemCnt를 고친다. 더한 항목의 첫 번호를 돌려준다 */
function appendItems(header: string, hh: string, list: string, item: string, make: (firstId: number) => string): { xml: string; firstId: number } {
  const listRe = new RegExp(`(<${hh}:${list}\\b[^>]*>)([\\s\\S]*?)(</${hh}:${list}>)`);
  const m = header.match(listRe);
  if (!m) throw new DocFillError('한글(HWPX) 파일의 서식 목록을 읽을 수 없습니다.');
  const ids = [...m[2].matchAll(new RegExp(`<${hh}:${item}\\s[^>]*\\bid="(\\d+)"`, 'g'))].map((x) => Number(x[1]));
  const firstId = ids.length ? Math.max(...ids) + 1 : 0;
  const added = make(firstId);
  const count = (added.match(new RegExp(`<${hh}:${item}\\s`, 'g')) ?? []).length;
  const open = m[1].replace(/\bitemCnt="(\d+)"/, (_, n) => `itemCnt="${Number(n) + count}"`);
  return { xml: header.replace(listRe, `${open}${m[2]}${added}${m[3]}`), firstId };
}

function borderFill(hh: string, hc: string, id: number, fill: string | null): string {
  const side = (s: string) => `<${hh}:${s} type="SOLID" width="0.12 mm" color="#000000"/>`;
  const brush = fill ? `<${hc}:fillBrush><${hc}:winBrush faceColor="${fill}" hatchColor="#000000" alpha="0"/></${hc}:fillBrush>` : '';
  return (
    `<${hh}:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">` +
    `<${hh}:slash type="NONE" Crooked="0" isCounter="0"/><${hh}:backSlash type="NONE" Crooked="0" isCounter="0"/>` +
    side('leftBorder') + side('rightBorder') + side('topBorder') + side('bottomBorder') +
    `<${hh}:diagonal type="SOLID" width="0.1 mm" color="#000000"/>${brush}</${hh}:borderFill>`
  );
}

/** 칸 글자 서식의 굵은 사본 — 이미 굵으면 그대로, 굵게 넣을 자리를 모르면 그대로(굵지 않은 머리 행) */
function boldCharPr(header: string, hh: string, charPr: string): { xml: string; id: string } {
  const m = header.match(new RegExp(`<${hh}:charPr\\s[^>]*\\bid="${charPr}"[\\s\\S]*?</${hh}:charPr>`));
  if (!m || m[0].includes(`<${hh}:bold`)) return { xml: header, id: charPr };
  const after = m[0].match(new RegExp(`<${hh}:italic\\b[^>]*/>`)) ?? m[0].match(new RegExp(`<${hh}:offset\\b[^>]*/>`));
  if (!after) return { xml: header, id: charPr };
  const added = appendItems(header, hh, 'charProperties', 'charPr', (id) =>
    m[0].replace(/\bid="\d+"/, `id="${id}"`).replace(after[0], `${after[0]}<${hh}:bold/>`)
  );
  return { xml: added.xml, id: String(added.firstId) };
}

/**
 * 칸 글자 서식에 밑줄(ins)·취소선(del)만 더한 사본 — 한글이 쓰는 꼴(`underline type="BOTTOM"`·`strikeout shape="SOLID"`).
 * 그 자리를 못 찾으면 그대로(표시 없이 글만)
 */
function markedCharPr(header: string, hh: string, charPr: string, mark: 'ins' | 'del'): { xml: string; id: string } {
  const m = header.match(new RegExp(`<${hh}:charPr\\s[^>]*\\bid="${charPr}"[\\s\\S]*?</${hh}:charPr>`));
  if (!m) return { xml: header, id: charPr };
  const tag = mark === 'ins' ? m[0].match(new RegExp(`<${hh}:underline\\b[^>]*/>`)) : m[0].match(new RegExp(`<${hh}:strikeout\\b[^>]*/>`));
  if (!tag) return { xml: header, id: charPr };
  const changed = mark === 'ins' ? tag[0].replace(/\btype="[^"]*"/, 'type="BOTTOM"') : tag[0].replace(/\bshape="[^"]*"/, 'shape="SOLID"');
  const added = appendItems(header, hh, 'charProperties', 'charPr', (id) => m[0].replace(/\bid="\d+"/, `id="${id}"`).replace(tag[0], changed));
  return { xml: added.xml, id: String(added.firstId) };
}

/** 문단 서식의 정렬만 바꾼 사본 — 이미 그 정렬이면 그대로, 정렬 자리를 모르면 그대로(정렬 없는 칸) */
function alignedParaPr(header: string, hh: string, paraPr: string, horizontal: string): { xml: string; id: string } {
  const m = header.match(new RegExp(`<${hh}:paraPr\\s[^>]*\\bid="${paraPr}"[\\s\\S]*?</${hh}:paraPr>`));
  const align = m?.[0].match(new RegExp(`<${hh}:align\\b[^>]*\\bhorizontal="([^"]*)"[^>]*/>`));
  if (!m || !align || align[1] === horizontal) return { xml: header, id: paraPr };
  const added = appendItems(header, hh, 'paraProperties', 'paraPr', (id) =>
    m[0].replace(/\bid="\d+"/, `id="${id}"`).replace(align[0], align[0].replace(/\bhorizontal="[^"]*"/, `horizontal="${horizontal}"`))
  );
  return { xml: added.xml, id: String(added.firstId) };
}

interface Style {
  paraPr: string;
  /** 열마다 쓸 문단 서식(정렬) — 없으면 paraPr */
  colParaPr: string[];
  charPr: string | null;
  headCharPr: string | null;
  /** 밑줄·취소선 사본 — 표지 문단에 글자 서식이 없으면 null(표시 없이) */
  insCharPr?: string | null;
  delCharPr?: string | null;
  border: number;
  headBorder: number;
}

function runsParagraph(hp: string, runs: HwpxRun[], paraPr: string, style: Style): string {
  const open = (cp: string | null | undefined) => (cp === null || cp === undefined ? `<${hp}:run>` : `<${hp}:run charPrIDRef="${cp}">`);
  const body = runs
    .filter((r) => r.text)
    .map((r) => {
      const cp = r.mark === 'ins' ? style.insCharPr ?? style.charPr : r.mark === 'del' ? style.delCharPr ?? style.charPr : style.charPr;
      return `${open(cp)}<${hp}:t>${textXml(r.text)}</${hp}:t></${hp}:run>`;
    })
    .join('');
  const empty = style.charPr === null ? `<${hp}:run/>` : `<${hp}:run charPrIDRef="${style.charPr}"/>`;
  return `<${hp}:p id="0" paraPrIDRef="${paraPr}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${body || empty}</${hp}:p>`;
}

function cellXml(hp: string, text: string, isHead: boolean, row: number, col: number, width: number, style: Style, runs?: HwpxRun[] | null): string {
  const cp = isHead ? style.headCharPr : style.charPr;
  const paraPr = style.colParaPr[col] ?? style.paraPr;
  const run = cp === null ? `<${hp}:run` : `<${hp}:run charPrIDRef="${cp}"`;
  const paras = !isHead && runs && runs.length ? [runsParagraph(hp, runs, paraPr, style)] : text.split(/<br\s*\/?>/i).map((line) =>
    `<${hp}:p id="0" paraPrIDRef="${paraPr}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">` +
    (line.trim() ? `${run}><${hp}:t>${textXml(line.trim())}</${hp}:t></${hp}:run>` : `${run}/>`) +
    `</${hp}:p>`
  );
  return (
    `<${hp}:tc name="" header="${isHead ? 1 : 0}" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${isHead ? style.headBorder : style.border}">` +
    `<${hp}:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">` +
    paras.join('') +
    `</${hp}:subList><${hp}:cellAddr colAddr="${col}" rowAddr="${row}"/><${hp}:cellSpan colSpan="1" rowSpan="1"/>` +
    `<${hp}:cellSz width="${width}" height="${ROW_HEIGHT}"/><${hp}:cellMargin left="${IN_MARGIN_X}" right="${IN_MARGIN_X}" top="${IN_MARGIN_Y}" bottom="${IN_MARGIN_Y}"/></${hp}:tc>`
  );
}

export function tableXml(hp: string, t: HwpxTable, style: Style, id: number, zOrder: number, total: number): string {
  const cols = tableColumnCount(t);
  const widths = columnWidths(t, total);
  const all = [t.header, ...t.rows];
  const rows = all.map((cells, r) =>
    `<${hp}:tr>${Array.from({ length: cols }, (_, c) => cellXml(hp, cells[c] ?? '', r === 0, r, c, widths[c], style, r === 0 ? null : t.runs?.[r - 1]?.[c])).join('')}</${hp}:tr>`
  );
  return (
    `<${hp}:tbl id="${id}" zOrder="${zOrder}" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="${all.length}" colCnt="${cols}" cellSpacing="0" borderFillIDRef="${style.border}" noAdjust="0">` +
    `<${hp}:sz width="${widths.reduce((a, b) => a + b, 0)}" widthRelTo="ABSOLUTE" height="${ROW_HEIGHT * all.length}" heightRelTo="ABSOLUTE" protect="0"/>` +
    `<${hp}:pos treatAsChar="0" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="CENTER" vertOffset="0" horzOffset="0"/>` +
    `<${hp}:outMargin left="${OUT_MARGIN}" right="${OUT_MARGIN}" top="${OUT_MARGIN}" bottom="${OUT_MARGIN}"/><${hp}:inMargin left="${IN_MARGIN_X}" right="${IN_MARGIN_X}" top="${IN_MARGIN_Y}" bottom="${IN_MARGIN_Y}"/>` +
    rows.join('') +
    `</${hp}:tbl>`
  );
}

/** 표지 문단마다 tables[i]를 넣는다. 표지는 본문 최상위 문단의 글 전체여야 한다 */
export async function insertHwpxTables(bytes: Buffer, tables: HwpxTable[]): Promise<Buffer> {
  if (tables.length === 0) return bytes;
  const doc = await openHwpx(bytes);
  if (!doc.zip.file(HEADER)) throw new DocFillError('한글(HWPX) 파일의 서식 정보(header.xml)가 없습니다.');
  let header = await readEntry(doc.zip, HEADER);
  const hh = header.match(/<(\w+):borderFills\b/)?.[1] ?? 'hh';
  const hc = header.match(/xmlns:(\w+)="http:\/\/www\.hancom\.co\.kr\/hwpml\/2011\/core"/)?.[1] ?? 'hc';

  const sections = new Map<string, string>();
  const found = new Map<number, { section: string; start: number; end: number; openTag: string; charPr: string | null }>();
  let total = DEFAULT_BODY_WIDTH;
  let zOrder = 0;
  for (const [i, name] of doc.sections.entries()) {
    const xml = await readEntry(doc.zip, name);
    sections.set(name, xml);
    const prefix = paragraphPrefix(xml);
    if (i === 0) total = bodyWidth(xml, prefix) - OUT_MARGIN * 2;
    for (const z of xml.matchAll(/\szOrder="(\d+)"/g)) zOrder = Math.max(zOrder, Number(z[1]) + 1);
    for (const p of scanParagraphs(xml, prefix)) {
      const m = p.ancestors.length === 0 ? p.text.trim().match(MARKER) : null;
      if (!m) continue;
      const index = Number(m[1]) - 1;
      if (found.has(index) || index >= tables.length) throw new DocFillError('표를 넣을 자리가 겹칩니다.');
      found.set(index, { section: name, start: p.start, end: p.end, openTag: p.openTag, charPr: p.pieces[0]?.charPr ?? null });
    }
  }
  if (found.size !== tables.length) throw new DocFillError('표를 넣을 자리를 찾지 못했습니다.');

  const fills = appendItems(header, hh, 'borderFills', 'borderFill', (id) => borderFill(hh, hc, id, null) + borderFill(hh, hc, id + 1, HEAD_FILL));
  header = fills.xml;
  const bold = new Map<string, string>();
  const marked = new Map<string, string>();
  const aligned = new Map<string, string>();
  const edits = new Map<string, Edit[]>();
  for (const [index, at] of [...found.entries()].sort((a, b) => a[0] - b[0])) {
    let headCharPr: string | null = null;
    if (at.charPr !== null) {
      if (!bold.has(at.charPr)) {
        const made = boldCharPr(header, hh, at.charPr);
        header = made.xml;
        bold.set(at.charPr, made.id);
      }
      headCharPr = bold.get(at.charPr)!;
    }
    // 밑줄·취소선 사본은 표에 조각이 있을 때만 만든다(다른 표는 header.xml을 늘리지 않는다)
    let insCharPr: string | null = null;
    let delCharPr: string | null = null;
    if (at.charPr !== null && tables[index].runs?.some((row) => row?.some((cell) => cell?.some((r) => r.mark)))) {
      for (const mark of ['ins', 'del'] as const) {
        const key = `${at.charPr}:${mark}`;
        if (!marked.has(key)) {
          const made = markedCharPr(header, hh, at.charPr, mark);
          header = made.xml;
          marked.set(key, made.id);
        }
      }
      insCharPr = marked.get(`${at.charPr}:ins`)!;
      delCharPr = marked.get(`${at.charPr}:del`)!;
    }
    const hp = paragraphPrefix(sections.get(at.section)!);
    const paraPr = attr(at.openTag, 'paraPrIDRef') ?? '0';
    const colParaPr = Array.from({ length: tableColumnCount(tables[index]) }, (_, c) => {
      const want = tables[index].align?.[c];
      if (!want) return paraPr;
      const key = `${paraPr}:${want}`;
      if (!aligned.has(key)) {
        const made = alignedParaPr(header, hh, paraPr, HORIZONTAL[want]);
        header = made.xml;
        aligned.set(key, made.id);
      }
      return aligned.get(key)!;
    });
    const style: Style = { paraPr, colParaPr, charPr: at.charPr, headCharPr, insCharPr, delCharPr, border: fills.firstId, headBorder: fills.firstId + 1 };
    // 쪽·단 나눔은 표지 문단의 것을 넘기지 않는다
    const open = at.openTag.replace(/(\s(?:pageBreak|columnBreak)\s*=\s*)(?:"[^"]*"|'[^']*')/g, '$1"0"');
    const run = at.charPr === null ? `<${hp}:run>` : `<${hp}:run charPrIDRef="${at.charPr}">`;
    const xml = `${open}${run}${tableXml(hp, tables[index], style, 1900000000 + index, zOrder + index, total)}<${hp}:t/></${hp}:run></${hp}:p>`;
    edits.set(at.section, [...(edits.get(at.section) ?? []), { start: at.start, end: at.end, text: xml }]);
  }
  for (const [name, list] of edits) sections.set(name, applyEdits(sections.get(name)!, list));
  doc.zip.file(HEADER, header, { createFolders: false });
  return writeHwpx(doc, new Map([...edits.keys()].map((n) => [n, sections.get(n)!])));
}
