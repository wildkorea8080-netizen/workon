import JSZip from 'jszip';
import { scanTags, unescapeXml, escapeXml, stripInvalidXmlChars, paragraphPrefix } from './xml-scan';
import { findMarkers } from './slots';
import { DocFillError } from './errors';

/**
 * HWPX 채우기. HWPX는 zip 안의 XML 묶음이고 본문은 Contents/section*.xml이다.
 *
 * - 본문 XML만 고친다. 서식 정의(header.xml)·그림·설정은 그대로 다시 넣는다
 * - 글은 <hp:t> 안에 있다. 한 문단(<hp:p>)이 여러 조각(<hp:run>)으로 나뉠 수
 *   있어 문단 단위로 글을 이어 붙여 표시를 찾는다
 * - 표 칸·머리말·각주·글상자 안의 문단은 그것을 품은 문단 안에 중첩된다.
 *   모든 문단을 읽되, 문단의 글은 '그 문단 자신의 조각'만 모은다(중첩 문단의 글은
 *   그 문단 몫). 고칠 때도 글 조각 구간만 바꾸므로 중첩 문단과 부딪히지 않는다
 * - 여분 줄은 원본 문단을 복제하지 않고 새로 만든다. 복제하면 구역 설정·표·그림 같은
 *   컨트롤이 함께 복제돼 파일이 깨진다
 */

interface TextPiece {
  /** 원본 XML에서 글자 내용의 위치(이스케이프된 상태) */
  start: number;
  end: number;
  /** 이스케이프를 푼 글 */
  text: string;
  /** 이 글이 든 조각(run)의 글자 서식 참조. 속성이 없으면 null */
  charPr: string | null;
}

interface Para {
  start: number;
  end: number;
  /** 여는 태그 원문 — 여분 줄 문단이 같은 속성을 쓴다 */
  openTag: string;
  /** 이 문단 자신의 글 조각(중첩 문단의 것은 제외) */
  pieces: TextPiece[];
  text: string;
  /** 이 문단 자신의 줄 배치 캐시 구간 */
  lineSegs: { start: number; end: number }[];
  hasChild: boolean;
  /** 이 문단을 품은 바깥 문단들의 시작 위치(바깥 → 안쪽 순) */
  ancestors: number[];
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

const SECTION = /^Contents\/section(\d+)\.xml$/i;

type Method = 'STORE' | 'DEFLATE';

function sectionNames(zip: JSZip): string[] {
  return Object.keys(zip.files)
    .filter((n) => SECTION.test(n))
    .sort((a, b) => Number(a.match(SECTION)![1]) - Number(b.match(SECTION)![1]));
}

/** 읽어 들인 항목의 압축 방식. 그림처럼 무압축으로 저장된 항목은 그대로 둔다 */
function entryMethods(zip: JSZip): Map<string, Method> {
  const out = new Map<string, Method>();
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const magic = (file as unknown as { _data?: { compression?: { magic?: string } } })._data?.compression?.magic;
    out.set(name, magic === '\u0000\u0000' ? 'STORE' : 'DEFLATE');
  }
  return out;
}

async function openHwpx(bytes: Buffer): Promise<{ zip: JSZip; sections: string[]; methods: Map<string, Method> }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new DocFillError('한글(HWPX) 파일을 열 수 없습니다. 파일이 손상됐을 수 있습니다.');
  }
  const sections = sectionNames(zip);
  if (sections.length === 0) throw new DocFillError('HWPX 본문(Contents/section*.xml)을 찾을 수 없습니다.');
  return { zip, sections, methods: entryMethods(zip) };
}

const CHAR_PR = /\scharPrIDRef\s*=\s*(?:"([^"]*)"|'([^']*)')/;

/** 모든 문단과 그 자신의 글 조각. 시작 위치 순 */
function scanParagraphs(xml: string, prefix: string): Para[] {
  const P = `${prefix}:p`;
  const T = `${prefix}:t`;
  const R = `${prefix}:run`;
  const L = `${prefix}:linesegarray`;
  const stack: (Para & { lsStart: number })[] = [];
  const runs: (string | null)[] = [];
  const out: Para[] = [];
  let inText = false;
  let cursor = 0;

  const addPiece = (from: number, to: number) => {
    if (from < to && stack.length > 0) {
      stack[stack.length - 1].pieces.push({
        start: from,
        end: to,
        text: unescapeXml(xml.slice(from, to)),
        charPr: runs.length > 0 ? runs[runs.length - 1] : null,
      });
    }
  };

  for (const tag of scanTags(xml)) {
    if (inText) {
      // <hp:t> 안의 태그(탭·줄바꿈 등)는 글 조각을 끊는다
      addPiece(cursor, tag.start);
      if (tag.name === T && tag.kind === 'close') inText = false;
      else cursor = tag.end;
      continue;
    }
    if (tag.name === T && tag.kind === 'open') {
      inText = true;
      cursor = tag.end;
      continue;
    }
    if (tag.name === R) {
      if (tag.kind === 'open') {
        const m = xml.slice(tag.start, tag.end).match(CHAR_PR);
        runs.push(m ? (m[1] ?? m[2]) : null);
      } else if (tag.kind === 'close') {
        runs.pop();
      }
      continue;
    }
    if (tag.name === L && stack.length > 0) {
      const top = stack[stack.length - 1];
      if (tag.kind === 'open') top.lsStart = tag.start;
      else if (tag.kind === 'close') top.lineSegs.push({ start: top.lsStart, end: tag.end });
      else top.lineSegs.push({ start: tag.start, end: tag.end });
      continue;
    }
    if (tag.name !== P) continue;
    if (tag.kind === 'open') {
      if (stack.length > 0) stack[stack.length - 1].hasChild = true;
      stack.push({
        start: tag.start,
        end: tag.end,
        openTag: xml.slice(tag.start, tag.end),
        pieces: [],
        text: '',
        lineSegs: [],
        hasChild: false,
        ancestors: stack.map((f) => f.start),
        lsStart: 0,
      });
    } else if (tag.kind === 'close') {
      const top = stack.pop();
      if (top) {
        out.push({
          start: top.start,
          end: tag.end,
          openTag: top.openTag,
          pieces: top.pieces,
          text: top.pieces.map((p) => p.text).join(''),
          lineSegs: top.lineSegs,
          hasChild: top.hasChild,
          ancestors: top.ancestors,
        });
      }
    } else if (stack.length > 0) {
      stack[stack.length - 1].hasChild = true;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function pieceOffsets(para: Para): number[] {
  const offsets: number[] = [];
  let acc = 0;
  for (const p of para.pieces) {
    offsets.push(acc);
    acc += p.text.length;
  }
  return offsets;
}

/** 표시 이름을 문서 순서로(중복 없이). 머리말처럼 본문 문단보다 앞에 놓인 중첩 문단도 제 위치에 */
function labelsInOrder(paras: Para[]): string[] {
  const hits: { pos: number; label: string }[] = [];
  for (const para of paras) {
    const offsets = pieceOffsets(para);
    for (const m of findMarkers(para.text)) {
      let i = offsets.length - 1;
      while (i > 0 && offsets[i] > m.start) i--;
      hits.push({ pos: para.pieces[i].start + (m.start - offsets[i]), label: m.label });
    }
  }
  hits.sort((a, b) => a.pos - b.pos);
  const labels: string[] = [];
  for (const h of hits) if (!labels.includes(h.label)) labels.push(h.label);
  return labels;
}

const textXml = (s: string) => escapeXml(stripInvalidXmlChars(s));

/** 여분 줄 문단. 원래 문단의 여는 태그(서식 참조)와 표시가 있던 조각의 글자 서식만 쓴다 */
function freshParagraph(openTag: string, charPr: string | null, line: string, prefix: string): string {
  // 쪽·단 나눔은 첫 문단에서만. 이어 붙인 줄마다 새 쪽·새 단이 되면 안 된다
  const tag = openTag.replace(/(\s(?:pageBreak|columnBreak)\s*=\s*)(?:"[^"]*"|'[^']*')/g, '$1"0"');
  const attr = charPr === null ? '' : ` charPrIDRef="${charPr.replace(/"/g, '&quot;')}"`;
  return `${tag}<${prefix}:run${attr}><${prefix}:t>${textXml(line)}</${prefix}:t></${prefix}:run></${prefix}:p>`;
}

function planParagraph(
  para: Para,
  values: Map<string, string>,
  prefix: string,
  filled: Set<string>
): { edits: Edit[]; grows: boolean } {
  const markers = findMarkers(para.text).filter((m) => values.has(m.label));
  if (markers.length === 0) return { edits: [], grows: false };

  const offsets = pieceOffsets(para);
  const texts = para.pieces.map((p) => p.text);
  const extraByMarker: string[][] = [];

  // 뒤에서부터 바꾼다 — 앞쪽 위치가 그대로 남는다
  for (const m of [...markers].reverse()) {
    filled.add(m.label);
    const lines = values
      .get(m.label)!
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map(stripInvalidXmlChars);
    let home = offsets.length - 1;
    while (home > 0 && offsets[home] > m.start) home--;
    extraByMarker.unshift(
      lines.slice(1).map((line) => freshParagraph(para.openTag, para.pieces[home].charPr, line, prefix))
    );
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
    if (texts[i] !== p.text) edits.push({ start: p.start, end: p.end, text: textXml(texts[i]) });
  });
  // 글이 바뀐 문단의 줄 배치 캐시를 지운다. 남으면 한글이 옛 배치로 겹쳐 그릴 수 있다
  for (const seg of para.lineSegs) edits.push({ start: seg.start, end: seg.end, text: '' });
  // 여분 줄은 이 문단이 닫힌 바로 뒤(중첩 문단이면 그 칸 안)에 새 문단으로 잇는다
  const extras = extraByMarker.flat().join('');
  if (extras) edits.push({ start: para.end, end: para.end, text: extras });
  return { edits, grows: extras !== '' };
}

/** 같은 줄 배치 캐시를 두 번 지우려 하면 구간이 어긋난다 — 같은 구간의 중복 삭제를 하나로 */
function dedupeDeletes(edits: Edit[]): Edit[] {
  const seen = new Set<string>();
  return edits.filter((e) => {
    if (e.text !== '' || e.end === e.start) return true;
    const key = `${e.start}-${e.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function applyEdits(xml: string, edits: Edit[]): string {
  let out = xml;
  // 겹치지 않는 구간이므로 뒤에서부터 적용하면 앞쪽 위치가 그대로 남는다
  for (const e of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

/** 미리보기 글. 중첩 문단은 자기 글이 시작되는 자리에 */
function previewOf(paras: Para[]): string[] {
  return paras
    .filter((p) => !(p.hasChild && p.pieces.length === 0))
    .sort((a, b) => (a.pieces[0]?.start ?? a.start) - (b.pieces[0]?.start ?? b.start))
    .map((p) => p.text);
}

async function rewritePreview(zip: JSZip, text: string): Promise<void> {
  const file = zip.file('Preview/PrvText.txt');
  if (!file) return;
  const original = await file.async('uint8array');
  const preview = text.slice(0, 2000);
  // 파일 탐색기 미리보기에 자리 표시가 보이면 안 된다. 원래 인코딩을 따른다
  if (original[0] === 0xff && original[1] === 0xfe) {
    zip.file('Preview/PrvText.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(preview, 'utf16le')]), {
      createFolders: false,
    });
  } else {
    zip.file('Preview/PrvText.txt', preview, { createFolders: false });
  }
}

export async function readHwpxMarkers(bytes: Buffer): Promise<string[]> {
  const { zip, sections } = await openHwpx(bytes);
  const labels: string[] = [];
  for (const name of sections) {
    const xml = await zip.files[name].async('string');
    for (const label of labelsInOrder(scanParagraphs(xml, paragraphPrefix(xml)))) {
      if (!labels.includes(label)) labels.push(label);
    }
  }
  return labels;
}

export async function fillHwpx(
  bytes: Buffer,
  values: Map<string, string>
): Promise<{ bytes: Buffer; filled: string[]; unfilled: string[] }> {
  const { zip, sections, methods } = await openHwpx(bytes);
  const order: string[] = [];
  const filled = new Set<string>();
  const previewLines: string[] = [];

  for (const name of sections) {
    const xml = await zip.files[name].async('string');
    const prefix = paragraphPrefix(xml);
    const paras = scanParagraphs(xml, prefix);
    for (const label of labelsInOrder(paras)) if (!order.includes(label)) order.push(label);

    const byStart = new Map(paras.map((p) => [p.start, p]));
    const edits: Edit[] = [];
    for (const para of paras) {
      const plan = planParagraph(para, values, prefix, filled);
      edits.push(...plan.edits);
      // 표 칸 같은 안쪽 문단이 늘어나면 표가 커진다. 그것을 품은 문단의 옛 줄 배치(표 높이 포함)는 낡는다
      if (plan.grows) {
        for (const start of para.ancestors) {
          for (const seg of byStart.get(start)?.lineSegs ?? []) edits.push({ start: seg.start, end: seg.end, text: '' });
        }
      }
    }
    const out = applyEdits(xml, dedupeDeletes(edits));
    if (out !== xml) zip.file(name, out, { createFolders: false });
    previewLines.push(...previewOf(scanParagraphs(out, prefix)));
  }

  await rewritePreview(zip, previewLines.join('\r\n'));

  // 형식 규칙: mimetype은 zip 맨 앞에 압축 없이. 같은 이름으로 다시 넣으면 자리는 그대로다
  const mimetype = zip.file('mimetype');
  if (mimetype) zip.file('mimetype', await mimetype.async('uint8array'), { compression: 'STORE', createFolders: false });
  methods.set('mimetype', 'STORE');

  // 항목마다 원래 압축 방식을 따른다 — 그림이 무압축이었으면 무압축으로
  for (const [name, file] of Object.entries(zip.files)) {
    if (!file.dir) file.options.compression = methods.get(name) ?? 'DEFLATE';
  }

  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return {
    bytes: out,
    filled: order.filter((l) => filled.has(l)),
    unfilled: order.filter((l) => !filled.has(l)),
  };
}
