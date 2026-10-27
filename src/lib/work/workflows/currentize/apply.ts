// src/lib/work/workflows/currentize/apply.ts
// 현행화 — 변경 계획을 작년 HWPX 바이트에 글자 단위로 적용한다(S6-1).
// 있는 문단의 글만 바꾸고, 여러 줄이면 그 문단 바로 뒤에 글만 든 새 문단을 잇는다. 표 행·구역은 넣지도 빼지도 않는다.
// 편집 방식은 양식 채우기(doc-fill/hwpx.ts planParagraph)와 같다 — 한글이 받아 주는 것이 검증된 길이다.
import {
  openHwpx,
  readEntry,
  scanParagraphs,
  textXml,
  freshParagraph,
  valueLines,
  dedupeDeletes,
  applyEdits,
  ancestorLineSegDeletes,
  writeHwpx,
  type Para,
  type Edit,
} from '@/lib/doc-fill/hwpx-core';
import { paragraphPrefix } from '@/lib/doc-fill/xml-scan';
import { WorkError } from '@/lib/work/types';
import { scanSegmentParas } from './segments';
import type { Change } from './plan';

const SEGMENT_ID = /^(\d+):(\d+)$/;

function priorMismatch(): WorkError {
  return new WorkError('PRIOR_MISMATCH', '작년 파일이 바뀌어 변경을 적용할 수 없습니다.', 409);
}

/** 문단 하나를 after로: 첫 글 조각에 첫 줄, 나머지 조각은 빈 글, 줄 배치 캐시 삭제, 둘째 줄부터는 뒤에 새 문단 */
function paragraphEdits(para: Para, after: string, prefix: string): Edit[] {
  const lines = valueLines(after);
  // 조각(run)과 그 서식은 남기고 글만 바꾼다 — 조각을 지우면 탭·컨트롤의 자리가 흔들린다
  const edits: Edit[] = para.pieces.map((p, i) => ({ start: p.start, end: p.end, text: textXml(i === 0 ? lines[0] : '') }));
  // 글이 바뀐 문단의 줄 배치 캐시를 지운다. 남으면 한글이 옛 배치로 겹쳐 그릴 수 있다
  for (const seg of para.lineSegs) edits.push({ start: seg.start, end: seg.end, text: '' });
  const extras = lines
    .slice(1)
    .map((line) => freshParagraph(para.openTag, para.pieces[0].charPr, line, prefix))
    .join('');
  if (extras) edits.push({ start: para.end, end: para.end, text: extras });
  return edits;
}

/**
 * status가 changed이고 after가 있는 변경만 적용한다. 위치는 모두 **원래 바이트** 기준이라 한 섹션의 편집을 한 번에 모아 적용한다.
 * 조각 id가 풀리지 않거나 그 문단의 글이 before와 다르면(표 칸 제외 — 칸 글은 표 읽기 결과라 다듬어져 있을 수 있다) PRIOR_MISMATCH.
 * 적용할 것이 없으면 원래 바이트를 그대로 돌려준다.
 */
export async function applyChanges(priorBytes: Buffer, changes: Change[]): Promise<Buffer> {
  const applied = changes.filter((c) => c.status === 'changed' && c.after !== null);
  if (applied.length === 0) return priorBytes;

  const doc = await openHwpx(priorBytes);
  const bySection = new Map<number, { change: Change; start: number }[]>();
  const seen = new Set<string>();
  for (const change of applied) {
    const m = change.segmentId.match(SEGMENT_ID);
    if (!m) throw priorMismatch();
    const section = Number(m[1]);
    if (section >= doc.sections.length) throw priorMismatch();
    // 한 문단에 두 변경을 겹쳐 적용하면 XML이 깨진다 — 계획이 그런 목록을 내지 않는다
    if (seen.has(change.segmentId)) throw new WorkError('INVALID_INPUT', '같은 조각에 적용할 변경이 둘 이상입니다.', 400);
    seen.add(change.segmentId);
    bySection.set(section, [...(bySection.get(section) ?? []), { change, start: Number(m[2]) }]);
  }

  const edited = new Map<string, string>();
  for (const [section, list] of bySection) {
    const name = doc.sections[section];
    const xml = await readEntry(doc.zip, name);
    const prefix = paragraphPrefix(xml);
    // 조각 id는 readSegments와 같은 훑기로 푼다
    const segmentParas = new Map(scanSegmentParas(xml, prefix).map((p) => [p.start, p]));
    // 표를 품은 바깥 문단은 글이 없어 조각이 아니지만 그 줄 배치 캐시도 지워야 한다 — 모든 문단으로 찾는다
    const byStart = new Map(scanParagraphs(xml, prefix).map((p) => [p.start, p]));

    const edits: Edit[] = [];
    for (const { change, start } of list) {
      const para = segmentParas.get(start);
      if (!para || (change.kind !== 'table' && para.text !== change.before)) throw priorMismatch();
      edits.push(...paragraphEdits(para, change.after!, prefix), ...ancestorLineSegDeletes(para, byStart));
    }
    edited.set(name, applyEdits(xml, dedupeDeletes(edits)));
  }
  return writeHwpx(doc, edited);
}
