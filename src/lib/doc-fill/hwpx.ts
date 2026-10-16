import { paragraphPrefix } from './xml-scan';
import { findMarkers } from './slots';
import {
  openHwpx,
  readEntry,
  scanParagraphs,
  pieceOffsets,
  textXml,
  freshParagraph,
  valueLines,
  dedupeDeletes,
  applyEdits,
  ancestorLineSegDeletes,
  writeHwpx,
  type Para,
  type Edit,
} from './hwpx-core';

/**
 * HWPX 표시({{이름}}) 채우기. 구조 읽기·편집 적용·다시 묶기 같은 공통 처리는 hwpx-core.ts에 있다.
 * 여기에는 표시를 찾아 값으로 바꾸는 계획(planParagraph)만 둔다.
 */

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

function planParagraph(
  para: Para,
  values: Map<string, string>,
  prefix: string,
  filled: Set<string>
): { edits: Edit[] } {
  const markers = findMarkers(para.text).filter((m) => values.has(m.label));
  if (markers.length === 0) return { edits: [] };

  const offsets = pieceOffsets(para);
  const texts = para.pieces.map((p) => p.text);
  const extraByMarker: string[][] = [];

  // 뒤에서부터 바꾼다 — 앞쪽 위치가 그대로 남는다
  for (const m of [...markers].reverse()) {
    filled.add(m.label);
    const lines = valueLines(values.get(m.label)!);
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
  return { edits };
}

export async function readHwpxMarkers(bytes: Buffer): Promise<string[]> {
  const { zip, sections } = await openHwpx(bytes);
  const labels: string[] = [];
  for (const name of sections) {
    const xml = await readEntry(zip, name);
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
  const doc = await openHwpx(bytes);
  const order: string[] = [];
  const filled = new Set<string>();
  const edited = new Map<string, string>();

  for (const name of doc.sections) {
    const xml = await readEntry(doc.zip, name);
    const prefix = paragraphPrefix(xml);
    const paras = scanParagraphs(xml, prefix);
    for (const label of labelsInOrder(paras)) if (!order.includes(label)) order.push(label);

    const byStart = new Map(paras.map((p) => [p.start, p]));
    const edits: Edit[] = [];
    for (const para of paras) {
      const plan = planParagraph(para, values, prefix, filled);
      edits.push(...plan.edits);
      // 표 칸 같은 안쪽 문단의 글이 바뀌면 그것을 품은 문단의 옛 줄 배치는 낡는다
      if (plan.edits.length > 0) edits.push(...ancestorLineSegDeletes(para, byStart));
    }
    const out = applyEdits(xml, dedupeDeletes(edits));
    if (out !== xml) edited.set(name, out);
  }

  const out = await writeHwpx(doc, edited);
  return {
    bytes: out,
    filled: order.filter((l) => filled.has(l)),
    unfilled: order.filter((l) => !filled.has(l)),
  };
}
