import JSZip from 'jszip';
import { scanTags, unescapeXml, escapeXml, paragraphPrefix } from './xml-scan';
import { findMarkers } from './slots';
import { DocFillError } from './errors';

/**
 * HWPX 채우기. HWPX는 zip 안의 XML 묶음이고 본문은 Contents/section*.xml이다.
 *
 * - 본문 XML만 고친다. 서식 정의(header.xml)·그림·설정은 그대로 다시 넣는다
 * - 글은 <hp:t> 안에 있다. 한 문단(<hp:p>)이 여러 조각(<hp:run>)으로 나뉠 수
 *   있어 문단 단위로 글을 이어 붙여 표시를 찾는다
 * - 표 칸 안의 문단은 바깥 문단 안에 중첩된다. 중첩 문단이 없는 '맨 안쪽
 *   문단'만 고친다 — 표를 품은 문단을 복제하면 표가 겹친다
 */

interface TextPiece {
  /** 원본 XML에서 글자 내용의 위치(이스케이프된 상태) */
  start: number;
  end: number;
  /** 이스케이프를 푼 글 */
  text: string;
}

interface Para {
  start: number;
  end: number;
  pieces: TextPiece[];
  text: string;
}

const SECTION = /^Contents\/section(\d+)\.xml$/i;

function sectionNames(zip: JSZip): string[] {
  return Object.keys(zip.files)
    .filter((n) => SECTION.test(n))
    .sort((a, b) => Number(a.match(SECTION)![1]) - Number(b.match(SECTION)![1]));
}

async function openHwpx(bytes: Buffer): Promise<{ zip: JSZip; sections: string[] }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new DocFillError('한글(HWPX) 파일을 열 수 없습니다. 파일이 손상됐을 수 있습니다.');
  }
  const sections = sectionNames(zip);
  if (sections.length === 0) throw new DocFillError('HWPX 본문(Contents/section*.xml)을 찾을 수 없습니다.');
  return { zip, sections };
}

/** 중첩 문단이 없는 문단과 그 안의 글 조각. 문서 순서 */
function leafParagraphs(xml: string, prefix: string): Para[] {
  const P = `${prefix}:p`;
  const T = `${prefix}:t`;
  const stack: { start: number; hasChild: boolean; pieces: TextPiece[] }[] = [];
  const out: Para[] = [];
  let inText = false;
  let cursor = 0;

  const addPiece = (from: number, to: number) => {
    if (from < to && stack.length > 0) {
      stack[stack.length - 1].pieces.push({ start: from, end: to, text: unescapeXml(xml.slice(from, to)) });
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
    if (tag.name !== P) continue;
    if (tag.kind === 'open') {
      if (stack.length > 0) stack[stack.length - 1].hasChild = true;
      stack.push({ start: tag.start, hasChild: false, pieces: [] });
    } else if (tag.kind === 'close') {
      const top = stack.pop();
      if (top && !top.hasChild) {
        out.push({ start: top.start, end: tag.end, pieces: top.pieces, text: top.pieces.map((p) => p.text).join('') });
      }
    } else if (stack.length > 0) {
      stack[stack.length - 1].hasChild = true;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function applyTexts(xml: string, para: Para, texts: string[]): string {
  let out = xml.slice(para.start, para.end);
  for (let i = para.pieces.length - 1; i >= 0; i--) {
    const p = para.pieces[i];
    out = out.slice(0, p.start - para.start) + escapeXml(texts[i]) + out.slice(p.end - para.start);
  }
  return out;
}

/** 글이 바뀐 문단의 줄 배치 캐시를 지운다. 남으면 한글이 옛 배치로 겹쳐 그릴 수 있다 */
function stripLineSegs(paraXml: string, prefix: string): string {
  const tag = `${prefix}:linesegarray`;
  return paraXml.replace(new RegExp(`<${tag}\\b[^>]*/>|<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'g'), '');
}

function rewriteParagraph(
  xml: string,
  para: Para,
  values: Map<string, string>,
  prefix: string,
  filled: Set<string>
): string | null {
  const markers = findMarkers(para.text).filter((m) => values.has(m.label));
  if (markers.length === 0) return null;

  const offsets: number[] = [];
  let acc = 0;
  for (const p of para.pieces) {
    offsets.push(acc);
    acc += p.text.length;
  }

  const texts = para.pieces.map((p) => p.text);
  const extraByMarker: string[][] = [];

  // 뒤에서부터 바꾼다 — 앞쪽 위치가 그대로 남는다
  for (const m of [...markers].reverse()) {
    filled.add(m.label);
    const lines = values.get(m.label)!.replace(/\r\n?/g, '\n').split('\n');
    extraByMarker.unshift(lines.slice(1));
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

  const head = stripLineSegs(applyTexts(xml, para, texts), prefix);
  // 남은 줄은 같은 문단을 복제해 잇는다 — 글꼴·들여쓰기 같은 서식 참조가 그대로 남는다
  const clones = extraByMarker
    .flat()
    .map((line) => stripLineSegs(applyTexts(xml, para, para.pieces.map((_, i) => (i === 0 ? line : ''))), prefix));
  return head + clones.join('');
}

async function rewritePreview(zip: JSZip, text: string): Promise<void> {
  const file = zip.file('Preview/PrvText.txt');
  if (!file) return;
  const original = await file.async('uint8array');
  const preview = text.slice(0, 2000);
  // 파일 탐색기 미리보기에 자리 표시가 보이면 안 된다. 원래 인코딩을 따른다
  if (original[0] === 0xff && original[1] === 0xfe) {
    zip.file('Preview/PrvText.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(preview, 'utf16le')]));
  } else {
    zip.file('Preview/PrvText.txt', preview);
  }
}

export async function readHwpxMarkers(bytes: Buffer): Promise<string[]> {
  const { zip, sections } = await openHwpx(bytes);
  const labels: string[] = [];
  for (const name of sections) {
    const xml = await zip.files[name].async('string');
    for (const para of leafParagraphs(xml, paragraphPrefix(xml))) {
      for (const m of findMarkers(para.text)) {
        if (!labels.includes(m.label)) labels.push(m.label);
      }
    }
  }
  return labels;
}

export async function fillHwpx(
  bytes: Buffer,
  values: Map<string, string>
): Promise<{ bytes: Buffer; filled: string[]; unfilled: string[] }> {
  const { zip, sections } = await openHwpx(bytes);
  const order: string[] = [];
  const filled = new Set<string>();
  const previewLines: string[] = [];

  for (const name of sections) {
    const xml = await zip.files[name].async('string');
    const prefix = paragraphPrefix(xml);
    const paras = leafParagraphs(xml, prefix);
    for (const para of paras) {
      for (const m of findMarkers(para.text)) if (!order.includes(m.label)) order.push(m.label);
    }

    let out = xml;
    for (const para of [...paras].reverse()) {
      const replaced = rewriteParagraph(xml, para, values, prefix, filled);
      if (replaced !== null) out = out.slice(0, para.start) + replaced + out.slice(para.end);
    }
    if (out !== xml) zip.file(name, out);
    previewLines.push(...leafParagraphs(out, prefix).map((p) => p.text));
  }

  await rewritePreview(zip, previewLines.join('\r\n'));

  // 형식 규칙: mimetype은 zip 맨 앞에 압축 없이. 같은 이름으로 다시 넣으면 자리는 그대로다
  const mimetype = zip.file('mimetype');
  if (mimetype) zip.file('mimetype', await mimetype.async('uint8array'), { compression: 'STORE' });

  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return {
    bytes: out,
    filled: order.filter((l) => filled.has(l)),
    unfilled: order.filter((l) => !filled.has(l)),
  };
}
