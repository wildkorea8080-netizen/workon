import JSZip from 'jszip';
import { scanTags, unescapeXml, escapeXml, stripInvalidXmlChars } from './xml-scan';
import { findMarkers } from './slots';
import { valueLines, pieceOffsets, applyEdits, entryMethods, type Edit } from './hwpx-core';
import { DocFillError } from './errors';

/**
 * DOCX 표시({{이름}}) 채우기. HWPX와 같은 원칙이다(hwpx-core.ts 머리말 참조).
 *
 * - 본문 XML(word/document.xml · header*.xml · footer*.xml)만 문자열 단위로 고친다.
 *   서식·그림·설정 등 나머지 항목은 내용도 압축 방식도 그대로 다시 넣는다
 * - 글은 <w:r> 안의 <w:t>에 있다. 한 문단(<w:p>)의 글을 이어 붙여 표시를 찾고 조각 위치로 되짚는다.
 *   글상자 안의 문단(<w:txbxContent>)은 바깥 문단 안에 중첩되므로, 문단의 글은 '자기 조각'만 모은다
 * - 여분 줄은 원래 문단을 복제하지 않고 새 문단으로 만든다: 문단 속성(pPr)에서 구역 설정·쪽 나눔·번호 매김만
 *   빼고, 표시가 든 조각의 글자 서식(rPr)과 글 하나를 붙인다
 */

interface DocxPiece {
  /** <w:t> 요소 전체(여는 태그 ~ 닫는 태그) */
  tagStart: number;
  tagEnd: number;
  /** 이스케이프를 푼 글 */
  text: string;
  /** 이 글이 든 조각(run)의 글자 서식 원문. 없으면 null */
  rPr: string | null;
  /** 요소 이름(접두어 포함) */
  tagName: string;
}

interface DocxPara {
  start: number;
  end: number;
  /** 문단 속성 원문. 없으면 null */
  pPr: string | null;
  /** pPr 원문의 시작 위치 */
  pPrStart: number | null;
  pieces: DocxPiece[];
  text: string;
}

interface Frame {
  start: number;
  pPr: string | null;
  pPrDepth: number;
  pPrStart: number;
  pieces: DocxPiece[];
  rDepth: number;
  rPr: string | null;
  rPrDepth: number;
  rPrStart: number;
}

const NOT_OPEN = 'Word(DOCX) 파일을 열 수 없습니다. 파일이 손상됐을 수 있습니다.';
const NO_BODY = 'Word(DOCX) 본문(word/document.xml)을 찾을 수 없습니다.';
const BAD_ENTRY = 'Word(DOCX) 파일의 본문을 읽을 수 없습니다. 파일이 손상됐을 수 있습니다.';

/** 문단 네임스페이스의 접두어. 보통 w이지만 선언을 따른다 */
export function wordPrefix(xml: string): string {
  const m = xml.match(
    /xmlns:([\w.-]+)="http:\/\/(?:schemas\.openxmlformats\.org\/wordprocessingml\/2006|purl\.oclc\.org\/ooxml\/wordprocessingml)\/main"/
  );
  return m ? m[1] : 'w';
}

/** 모든 문단과 그 자신의 글 조각. 시작 위치 순 */
function scanDocxParagraphs(xml: string, prefix: string): DocxPara[] {
  const P = `${prefix}:p`;
  const T = `${prefix}:t`;
  const R = `${prefix}:r`;
  const PPR = `${prefix}:pPr`;
  const RPR = `${prefix}:rPr`;
  const tags = scanTags(xml);
  const stack: Frame[] = [];
  const out: DocxPara[] = [];

  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    const top = stack.length > 0 ? stack[stack.length - 1] : null;
    if (tag.name === P) {
      if (tag.kind === 'open') {
        stack.push({ start: tag.start, pPr: null, pPrDepth: 0, pPrStart: 0, pieces: [], rDepth: 0, rPr: null, rPrDepth: 0, rPrStart: 0 });
      } else if (tag.kind === 'close' && top) {
        stack.pop();
        out.push({ start: top.start, end: tag.end, pPr: top.pPr, pPrStart: top.pPr === null ? null : top.pPrStart, pieces: top.pieces, text: top.pieces.map((p) => p.text).join('') });
      }
      continue;
    }
    if (!top) continue;
    if (tag.name === PPR) {
      if (tag.kind === 'open') {
        if (top.pPrDepth === 0 && top.pPr === null) top.pPrStart = tag.start;
        top.pPrDepth++;
      } else if (tag.kind === 'close') {
        top.pPrDepth--;
        if (top.pPrDepth === 0 && top.pPr === null) top.pPr = xml.slice(top.pPrStart, tag.end);
      } else if (top.pPrDepth === 0 && top.pPr === null) {
        top.pPrStart = tag.start;
        top.pPr = xml.slice(tag.start, tag.end);
      }
    } else if (tag.name === R) {
      if (tag.kind === 'open') {
        top.rDepth++;
        if (top.rDepth === 1) top.rPr = null;
      } else if (tag.kind === 'close') {
        top.rDepth--;
      }
    } else if (tag.name === RPR && top.rDepth > 0) {
      // 조각 안의 글자 서식. 문단 부호의 서식(pPr 안)은 조각 밖이라 여기 오지 않는다
      if (tag.kind === 'open') {
        if (top.rPrDepth === 0) top.rPrStart = tag.start;
        top.rPrDepth++;
      } else if (tag.kind === 'close') {
        top.rPrDepth--;
        if (top.rPrDepth === 0) top.rPr = xml.slice(top.rPrStart, tag.end);
      } else if (top.rPrDepth === 0) {
        top.rPr = xml.slice(tag.start, tag.end);
      }
    } else if (tag.name === T && tag.kind === 'open') {
      const close = tags[i + 1];
      if (close && close.name === T && close.kind === 'close') {
        top.pieces.push({
          tagStart: tag.start,
          tagEnd: close.end,
          text: unescapeXml(xml.slice(tag.end, close.start)),
          rPr: top.rPr,
          tagName: tag.name,
        });
        i++;
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** 표시 이름을 문서 순서로(중복 없이) */
function labelsInOrder(paras: DocxPara[]): string[] {
  const hits: { pos: number; label: string }[] = [];
  for (const para of paras) {
    const offsets = pieceOffsets(para);
    for (const m of findMarkers(para.text)) {
      let i = offsets.length - 1;
      while (i > 0 && offsets[i] > m.start) i--;
      hits.push({ pos: para.pieces[i].tagStart + (m.start - offsets[i]), label: m.label });
    }
  }
  hits.sort((a, b) => a.pos - b.pos);
  const labels: string[] = [];
  for (const h of hits) if (!labels.includes(h.label)) labels.push(h.label);
  return labels;
}

/**
 * 지정한 요소를 뺀다(자기 닫힘이든 안에 내용이 있든, 짝이 맞는 닫는 태그까지). opaque 요소는 통째로 건너뛰어
 * 그 안은 보지 않는다. 뺀 요소의 원문도 돌려준다
 */
function removeElements(xml: string, drop: Set<string>, opaque: Set<string> = new Set()): { out: string; removed: string[] } {
  const tags = scanTags(xml);
  const removed: string[] = [];
  let out = '';
  let cursor = 0;
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    if (tag.kind === 'close' || !(drop.has(tag.name) || opaque.has(tag.name))) continue;
    let end = tag.end;
    if (tag.kind === 'open') {
      // 같은 이름이 안에 또 있을 수 있어 짝이 맞는 닫는 태그까지 센다
      let depth = 1;
      for (let j = i + 1; j < tags.length && depth > 0; j++) {
        if (tags[j].name !== tag.name) continue;
        if (tags[j].kind === 'open') depth++;
        else if (tags[j].kind === 'close') depth--;
        if (depth === 0) {
          end = tags[j].end;
          i = j;
        }
      }
    }
    if (drop.has(tag.name)) {
      out += xml.slice(cursor, tag.start);
      removed.push(xml.slice(tag.start, end));
      cursor = end;
    }
  }
  return { out: out + xml.slice(cursor), removed };
}

/**
 * 여분 줄 문단 속성. 쪽 나눔·번호 매김은 첫 문단에서만 — 줄마다 새 쪽·새 번호가 되면 안 된다.
 * 변경 추적 표시(pPrChange, 문단 부호의 ins/del, rPrChange)도 뺀다: 같은 변경 번호가 겹치고,
 * 복사한 문단 부호의 del은 변경을 수락할 때 문단을 합쳐 버린다.
 * 구역 설정(sectPr)은 DOCX에서 '이 문단 뒤'에서 구역이 끝난다는 뜻이라, 마지막 이어 붙인 문단에 달아야
 * 이어 붙인 줄이 구역 나눔 앞에 남는다 — sectPr 인자가 그것이다
 */
function continuationPPr(pPr: string | null, prefix: string, sectPr: string | null): string {
  const drop = new Set(
    ['sectPr', 'pageBreakBefore', 'numPr', 'pPrChange', 'rPrChange', 'ins', 'del', 'moveFrom', 'moveTo'].map((n) => `${prefix}:${n}`)
  );
  const base = pPr === null ? '' : removeElements(pPr, drop).out;
  if (sectPr === null) return base;
  const close = `</${prefix}:pPr>`;
  if (base === '' || /^<[^>]*\/>$/.test(base)) return `<${prefix}:pPr>${sectPr}${close}`;
  const at = base.lastIndexOf(close);
  return at < 0 ? base : base.slice(0, at) + sectPr + base.slice(at);
}

const textXml = (s: string) => escapeXml(stripInvalidXmlChars(s));

function freshParagraph(pPr: string | null, rPr: string | null, line: string, prefix: string, sectPr: string | null): string {
  const runPr = rPr === null ? '' : removeElements(rPr, new Set([`${prefix}:rPrChange`])).out;
  return (
    `<${prefix}:p>${continuationPPr(pPr, prefix, sectPr)}<${prefix}:r>${runPr}` +
    `<${prefix}:t xml:space="preserve">${textXml(line)}</${prefix}:t></${prefix}:r></${prefix}:p>`
  );
}

function planParagraph(para: DocxPara, values: Map<string, string>, prefix: string, filled: Set<string>): Edit[] {
  const markers = findMarkers(para.text).filter((m) => values.has(m.label));
  if (markers.length === 0) return [];

  const offsets = pieceOffsets(para);
  const texts = para.pieces.map((p) => p.text);
  const extraByMarker: { rPr: string | null; line: string }[][] = [];

  // 뒤에서부터 바꾼다 — 앞쪽 위치가 그대로 남는다
  for (const m of [...markers].reverse()) {
    filled.add(m.label);
    const lines = valueLines(values.get(m.label)!);
    let home = offsets.length - 1;
    while (home > 0 && offsets[home] > m.start) home--;
    extraByMarker.unshift(lines.slice(1).map((line) => ({ rPr: para.pieces[home].rPr, line })));
    let first = true;
    for (let i = 0; i < para.pieces.length; i++) {
      const pieceStart = offsets[i];
      const pieceEnd = pieceStart + para.pieces[i].text.length;
      if (pieceEnd <= m.start || pieceStart >= m.end) continue;
      const localStart = Math.max(m.start, pieceStart) - pieceStart;
      const localEnd = Math.min(m.end, pieceEnd) - pieceStart;
      texts[i] = texts[i].slice(0, localStart) + (first ? lines[0] : '') + texts[i].slice(localEnd);
      first = false;
    }
  }

  const edits: Edit[] = [];
  para.pieces.forEach((p, i) => {
    if (texts[i] === p.text) return;
    // 앞뒤 공백이 지워지지 않게 xml:space="preserve"를 붙여 요소째 다시 쓴다
    edits.push({
      start: p.tagStart,
      end: p.tagEnd,
      text: `<${p.tagName} xml:space="preserve">${textXml(texts[i])}</${p.tagName}>`,
    });
  });
  const extras = extraByMarker.flat();
  if (extras.length > 0) {
    // 구역 나눔은 이 문단 '뒤'에서 일어난다. 원래 문단에서 떼어 마지막 이어 붙인 문단으로 옮긴다
    let sectPr: string | null = null;
    if (para.pPr !== null && para.pPrStart !== null) {
      const split = removeElements(para.pPr, new Set([`${prefix}:sectPr`]), new Set([`${prefix}:pPrChange`]));
      if (split.removed.length > 0) {
        sectPr = split.removed.join('');
        edits.push({ start: para.pPrStart, end: para.pPrStart + para.pPr.length, text: split.out });
      }
    }
    // 여분 줄은 이 문단이 닫힌 바로 뒤(글상자 안이면 그 안)에 새 문단으로 잇는다
    const built = extras
      .map((x, i) => freshParagraph(para.pPr, x.rPr, x.line, prefix, i === extras.length - 1 ? sectPr : null))
      .join('');
    edits.push({ start: para.end, end: para.end, text: built });
  }
  return edits;
}

const PART = /^word\/(header|footer)(\d*)\.xml$/i;

interface DocxDoc {
  zip: JSZip;
  /** 읽는 순서: 머리글 → 본문 → 바닥글 */
  parts: string[];
  methods: ReturnType<typeof entryMethods>;
}

async function openDocx(bytes: Buffer): Promise<DocxDoc> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new DocFillError(NOT_OPEN);
  }
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const body = names.find((n) => n.toLowerCase() === 'word/document.xml');
  if (!body) throw new DocFillError(NO_BODY);
  const ofKind = (kind: string) =>
    names
      .filter((n) => PART.test(n) && n.match(PART)![1].toLowerCase() === kind)
      .sort((a, b) => Number(a.match(PART)![2] || 0) - Number(b.match(PART)![2] || 0));
  return { zip, parts: [...ofKind('header'), body, ...ofKind('footer')], methods: entryMethods(zip) };
}

async function readPart(zip: JSZip, name: string): Promise<string> {
  try {
    return await zip.files[name].async('string');
  } catch {
    throw new DocFillError(BAD_ENTRY);
  }
}

export async function readDocxMarkers(bytes: Buffer): Promise<string[]> {
  const { zip, parts } = await openDocx(bytes);
  const labels: string[] = [];
  for (const name of parts) {
    const xml = await readPart(zip, name);
    for (const label of labelsInOrder(scanDocxParagraphs(xml, wordPrefix(xml)))) {
      if (!labels.includes(label)) labels.push(label);
    }
  }
  return labels;
}

export async function fillDocx(
  bytes: Buffer,
  values: Map<string, string>
): Promise<{ bytes: Buffer; filled: string[]; unfilled: string[] }> {
  const { zip, parts, methods } = await openDocx(bytes);
  const order: string[] = [];
  const filled = new Set<string>();

  for (const name of parts) {
    const xml = await readPart(zip, name);
    const prefix = wordPrefix(xml);
    const paras = scanDocxParagraphs(xml, prefix);
    for (const label of labelsInOrder(paras)) if (!order.includes(label)) order.push(label);

    const edits = paras.flatMap((para) => planParagraph(para, values, prefix, filled));
    const out = applyEdits(xml, edits);
    if (out !== xml) {
      zip.file(name, out, { createFolders: false });
    }
  }

  // 항목마다 원래 압축 방식을 따른다 — 그림이 무압축이었으면 무압축으로
  for (const [name, file] of Object.entries(zip.files)) {
    if (!file.dir) file.options.compression = methods.get(name) ?? 'DEFLATE';
  }
  let out: Buffer;
  try {
    out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  } catch {
    throw new DocFillError('Word(DOCX) 파일을 다시 묶을 수 없습니다. 파일이 손상됐을 수 있습니다.');
  }
  return {
    bytes: out,
    filled: order.filter((l) => filled.has(l)),
    unfilled: order.filter((l) => !filled.has(l)),
  };
}
