// src/lib/edition-compare-hwpx.ts
// 두 판 신구 대비를 한글(HWPX) 신구대비표로 쓴다(2026-11-05). 엑셀(edition-compare-xlsx.ts)과 같은 대조 결과를 옮긴다.
//
// - 양식은 표준 보고서(assets/templates/report.hwpx — 한글로 만든 진짜 HWPX). 쓰지 않는 칸 제목은 지운다(앱 결과 내보내기와 같은 방식).
// - 표는 채우기 엔진의 표 넣기(insertHwpxTables)로 넣는다 — 위치 · 구분 · 현행(옛 판) · 개정(새 판).
//   공공기관 신구조문대비표 관례대로 **개정 쪽 바뀐 글은 밑줄, 현행 쪽 지운 글은 취소선**이다.
// - 바뀐 문단만 싣는다. 표 하나가 한글에서 다루기 어려운 크기가 되지 않게 행을 나눠 표 여럿으로 넣는다.
// - 만든 뒤 패키지 검사(checkPackage)로 넣은 글이 다 들어갔는지 본다.

import { fillHwpx } from '@/lib/doc-fill/hwpx';
import { openHwpx, readEntry, scanParagraphs, applyEdits, writeHwpx } from '@/lib/doc-fill/hwpx-core';
import { paragraphPrefix } from '@/lib/doc-fill/xml-scan';
import { insertHwpxTables, tableMarker, MAX_HWPX_TABLE_ROWS, type HwpxRun, type HwpxTable } from '@/lib/doc-fill/hwpx-table';
import { checkPackage } from '@/lib/work/documents/package-check';
import { kstStamp } from '@/lib/xlsx-export';
import { compareFileName } from '@/lib/edition-compare-xlsx';
import { compareSummary, type CompareRow, type InlinePart } from '@/lib/edition-compare';
import type { EditionCompareWorkbookInput } from '@/lib/edition-compare-xlsx';
import { findBuiltinTemplate, loadBuiltinTemplate } from '@/lib/builtin-templates';

/** 표 하나의 본문 행 수 — 한글 표 상한(MAX_HWPX_TABLE_ROWS)보다 넉넉히 작게 */
export const ROWS_PER_TABLE = Math.min(200, MAX_HWPX_TABLE_ROWS - 1);
/** 이보다 바뀐 문단이 많으면 한글 파일을 만들지 않는다(엑셀로 안내) — 표 여러 개가 수백 쪽이 된다 */
export const MAX_HWPX_CHANGES = 2_000;
/** 한 칸 글 상한 — 넘으면 자르고 '…' */
const MAX_CELL_CHARS = 4_000;

export class EditionCompareHwpxError extends Error {}

const HEADER = ['위치', '구분', '현행(옛 판)', '개정(새 판)'];
const KIND_LABEL = { changed: '고침', removed: '삭제', added: '신설' } as const;
const UNUSED_HEADINGS = new Set(['□ 추진 경과', '□ 향후 계획', '□ 건의 사항', '{{추진 경과}}', '{{향후 계획}}', '{{건의 사항}}']);

type ChangeRow = Extract<CompareRow, { kind: 'changed' | 'removed' | 'added' }>;

function cut(text: string): string {
  return text.length > MAX_CELL_CHARS ? text.slice(0, MAX_CELL_CHARS) + '…' : text;
}

/** 칸 글자 수 상한을 지키며 조각을 옮긴다 */
function partsToRuns(parts: InlinePart[], mark: 'ins' | 'del'): HwpxRun[] {
  const out: HwpxRun[] = [];
  let left = MAX_CELL_CHARS;
  for (const p of parts) {
    if (left <= 0) break;
    const text = p.text.length > left ? p.text.slice(0, left) + '…' : p.text;
    left -= p.text.length;
    out.push({ text, mark: p.changed ? mark : null });
  }
  return out;
}

/** 표 한 줄 — 글(rows)과 표시 조각(runs). 글은 패키지 검사에도 쓴다 */
export function changeRowCellsHwpx(row: ChangeRow): { cells: string[]; runs: (HwpxRun[] | null)[] } {
  const loc = row.location ?? '';
  switch (row.kind) {
    case 'changed': {
      const oldRuns = partsToRuns(row.old, 'del');
      const newRuns = partsToRuns(row.new, 'ins');
      return {
        cells: [loc, KIND_LABEL.changed, oldRuns.map((r) => r.text).join(''), newRuns.map((r) => r.text).join('')],
        runs: [null, null, oldRuns, newRuns],
      };
    }
    case 'removed':
      return { cells: [loc, KIND_LABEL.removed, cut(row.old), '(삭제)'], runs: [null, null, [{ text: cut(row.old), mark: 'del' }], null] };
    case 'added':
      return { cells: [loc, KIND_LABEL.added, '(신설)', cut(row.new)], runs: [null, null, null, [{ text: cut(row.new), mark: 'ins' }]] };
  }
}

/** 내려받기 응답 머리글 — 한글 파일 이름은 엑셀과 같은 규칙(확장자만 다르다) */
export function compareHwpxHeaders(newName: string): Record<string, string> {
  const name = compareFileName(newName).replace(/\.xlsx$/, '.hwpx');
  return {
    'Content-Type': 'application/hwp+zip',
    'Content-Disposition': `attachment; filename="edition-compare.hwpx"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
  };
}

/**
 * 표준 보고서 양식 바이트(template)에 신구대비표를 채운다.
 * 바뀐 문단이 MAX_HWPX_CHANGES를 넘으면 EditionCompareHwpxError(부르는 쪽이 엑셀로 안내).
 */
export async function buildEditionCompareHwpx(template: Buffer, input: EditionCompareWorkbookInput): Promise<Buffer> {
  const changes = input.comparison.rows.filter((r): r is ChangeRow => r.kind !== 'same' && r.kind !== 'skip');
  if (changes.length > MAX_HWPX_CHANGES) {
    throw new EditionCompareHwpxError(
      `바뀐 문단이 ${changes.length.toLocaleString('ko-KR')}개라 한글 파일로 만들지 않았습니다. 신구대비표 엑셀로 내려받아 주세요.`
    );
  }

  // 쓰지 않는 칸 제목(추진 경과·향후 계획·건의 사항)을 지운다
  const doc = await openHwpx(template);
  const sections = new Map<string, string>();
  for (const name of doc.sections) {
    const xml = await readEntry(doc.zip, name);
    const edits = scanParagraphs(xml, paragraphPrefix(xml))
      .filter((p) => UNUSED_HEADINGS.has(p.text.trim()))
      .map((p) => ({ start: p.start, end: p.end, text: '' }));
    sections.set(name, applyEdits(xml, edits));
  }
  const base = await writeHwpx(doc, sections);

  const side = (label: string, s: EditionCompareWorkbookInput['old']) =>
    `${label}: ${s.name}${s.effective_from ? ` (시행 ${s.effective_from})` : ''}${s.status === 'retired' ? ' — 지난 판' : ''}`;
  const overview = [
    side('현행(옛 판)', input.old),
    side('개정(새 판)', input.new),
    `요약: ${input.comparison.identical ? '두 판의 글이 같습니다' : compareSummary(input.comparison.stats)}`,
    '두 원본의 글을 문단 단위로 맞댄 결과입니다(AI를 쓰지 않음). 띄어쓰기만 다른 문단은 같은 문단으로 봅니다.',
    '표 배치·서식·그림의 차이는 보이지 않습니다. 원본으로 확인하세요.',
    ...input.warnings.map((w) => `경고 — ${w}`),
  ];

  const tables: HwpxTable[] = [];
  const body: string[] = [];
  if (changes.length === 0) {
    body.push('바뀐 문단이 없습니다.');
  } else {
    body.push('개정(새 판) 쪽 밑줄은 바뀌거나 새로 넣은 글, 현행(옛 판) 쪽 취소선은 지운 글입니다.');
    for (let i = 0; i < changes.length; i += ROWS_PER_TABLE) {
      const slice = changes.slice(i, i + ROWS_PER_TABLE).map(changeRowCellsHwpx);
      body.push(tableMarker(tables.length));
      // 위치·구분은 좁게 고정(칸 글 길이로 정하면 '고침'이 두 줄로 꺾인다), 두 판은 같은 폭
      tables.push({ header: HEADER, rows: slice.map((r) => r.cells), runs: slice.map((r) => r.runs), align: ['left', 'center', 'left', 'left'], widths: [17, 9, 37, 37] });
    }
  }

  const title = `신구대비표 — ${input.new.name}`;
  const values = new Map([
    ['제목', title],
    ['작성일', `만든 때: ${kstStamp(input.createdAt)} (KST)`],
    ['작성부서', ''],
    ['개요', overview.join('\n')],
    ['주요 내용', body.join('\n')],
  ]);
  const filled = await fillHwpx(base, values);
  const bytes = await insertHwpxTables(filled.bytes, tables);

  // 넣은 글이 다 들어갔는지(표 칸 글 포함) — 패키지 검사가 못 찾으면 만들지 않는다
  const cellLines = tables.flatMap((t) => [t.header, ...t.rows].flat()).map((c) => c.trim()).filter(Boolean);
  const textLines = [...overview, ...body.filter((line) => !tables.some((_, i) => line === tableMarker(i)))];
  const checked = await checkPackage(bytes, { format: 'hwpx', values: [title, ...textLines, ...cellLines] });
  if (!checked.valid) throw new Error('한글 파일 구조 검증을 통과하지 못했습니다.');
  return bytes;
}

/**
 * 라우트용 — 표준 보고서 양식을 읽어 신구대비표 한글 파일을 만든다.
 * 양식 파일이 없으면 503, 바뀐 문단이 너무 많으면 422(엑셀로 안내). 그 밖의 실패는 던진다
 */
export async function editionCompareHwpxFile(
  input: EditionCompareWorkbookInput,
  loadTemplate: () => Promise<Buffer | null> = () => loadBuiltinTemplate(findBuiltinTemplate('builtin:report')!)
): Promise<{ ok: true; bytes: Buffer } | { ok: false; status: number; message: string }> {
  const template = await loadTemplate();
  if (!template) return { ok: false, status: 503, message: '기본 한글 양식이 준비되지 않았습니다.' };
  try {
    return { ok: true, bytes: await buildEditionCompareHwpx(template, input) };
  } catch (err) {
    if (err instanceof EditionCompareHwpxError) return { ok: false, status: 422, message: err.message };
    throw err;
  }
}
