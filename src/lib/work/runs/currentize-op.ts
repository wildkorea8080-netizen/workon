// src/lib/work/runs/currentize-op.ts
import type { WorkContext } from '../context';
import { WorkError, type WorkRunRow, type WorkSourceRow, type WorkTaskRow } from '../types';
import { definitionFor } from '../workflows';
import { checkForm } from '../workflows/form';
import { loadSourceExtracts } from '../sources';
import type { ExtractedTable } from '@/lib/attachments/types';
import { readHwpxTables } from '@/lib/attachments/tables-hwpx';
import { openHwpx, readEntry } from '@/lib/doc-fill/hwpx-core';
import { paragraphPrefix, scanTags } from '@/lib/doc-fill/xml-scan';
import { parseNumber } from '@/lib/table-engine/number';
import { estimateCostKrw } from '@/lib/models';
import { DEFAULT_COST_CAP_KRW, MODEL_BATCH_SEGMENTS } from '../workflows/currentize/limits';
import { readSegments, type Segment } from '../workflows/currentize/segments';
import { classifySegment, type Finding } from '../workflows/currentize/classify';
import { shiftYears, dominantYear } from '../workflows/currentize/shift';
import { planColumnShift, shiftColumns, columnName } from '../workflows/currentize/tables';
import { matchRowValues, thisYearColumnValues, unknownProseNumbers } from '../workflows/currentize/numbers';
import { compareCitations, type CitationInput, type CitationPair } from '../workflows/currentize/citations';
import { MAX_REWRITE_SOURCE_CHARS, type RawRewrite, type RewriteInput } from '../workflows/currentize/model';
import { verifyRewrites } from '../workflows/currentize/verify';
import { buildPlan, type Change, type CurrentizeContent, type PlanTableCell } from '../workflows/currentize/plan';
import { currentizeReviewItems } from '../workflows/currentize/review';
import { loadPriorFile, segmentLabels, type PriorFile } from '../workflows/currentize/output';
import { buildFileStep, writeModelUsage, type StepFn } from './shared';

/**
 * 현행화 — 작년 HWPX(원자료 용도 prior)를 올해 문서로 고친다(S6-1). 보고서처럼 usesCurrentizeWhenPrior인 업무에서
 * 작년 파일이 읽혀 있으면 실행기가 양식 채우기 대신 이리로 보낸다.
 *
 * 단계(체크포인트): load_prior → segments → classify → evidence(인용 대조, 제공자 호출) → rewrite_<순번 글자>(모델 묶음마다, rewriteStepName)
 * → save_version → review → file. 조각·분류·표 계산은 작년 바이트에서 언제나 같게 나오므로 다시 시도하면 다시 계산하고,
 * 바깥 호출(근거 제공자·모델)만 결과를 체크포인트에 남겨 다시 부르지 않는다.
 *
 * 원칙: 프로그램이 확신하는 것(연도 밀기·표 열 밀기·근거가 맞는 고치기)만 파일에 넣고, 나머지는 확인 요청·제안으로 남긴다.
 * 본문 수치는 프로그램도 모델도 바꾸지 않는다.
 */

/** 원가 상한으로 멈춘 뒤 남은 줄글 조각의 확인 요청 */
export const NOTE_COST_STOPPED = '원가 상한으로 멈춤 — 나머지 문장은 직접 확인하세요';
/** 글이 없는 칸(조각이 없어 글자 단위로 고칠 수 없음)에 값이 들어가야 할 때 */
export const NOTE_BLANK_CELL = '빈 칸에 값을 넣어야 합니다 — 직접 입력하세요';
/** 문단이 여럿인 칸은 문단 하나로 바꿀 수 없다(적용이 PRIOR_MISMATCH로 멈추지 않게 미리 확인 요청으로) */
export const NOTE_MULTI_PARAGRAPH_CELL = '여러 줄 칸이라 자동으로 바꾸지 않았습니다 — 직접 고치세요';
/** 숫자가 든 표인데 전년도·당해 열을 가리지 못했을 때 — 표의 연도·수치를 하나도 바꾸지 않는다 */
export const NOTE_UNPLANNED_TABLE = '표의 연도 열을 가리지 못해 그대로 두었습니다 — 직접 확인하세요';
/**
 * 묶음 단계 이름. 단계 이름은 DB가 `^[a-z_]{1,40}$`만 받으므로(0034 work_run_steps) 'rewrite:3' 대신 순번을
 * 글자로 적는다 — 26진수의 자리 글자(0-9a-p)를 a-z로 옮긴다: 0 → rewrite_a, 1 → rewrite_b, 26 → rewrite_ba
 */
export function rewriteStepName(index: number): string {
  const letters = index.toString(26).replace(/[0-9a-p]/g, (c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 26)));
  return `rewrite_${letters}`;
}

/** 모델 지시·틀의 글자 수 어림(원가 예상용) */
const PROMPT_OVERHEAD_CHARS = 1500;

/**
 * 이 실행이 현행화로 가는가. 다시 시도는 첫 시도의 길을 따른다 — 'load_prior' 단계가 있으면 현행화, 'prepare'가 있으면 양식 채우기.
 * 처음이면 지금 원자료(읽힌 작년 파일이 있는가)로 정한다
 */
export async function usesCurrentize(ctx: WorkContext, run: WorkRunRow, task: WorkTaskRow): Promise<boolean> {
  if (await ctx.store.getStep(run.id, 'load_prior')) return true;
  if (await ctx.store.getStep(run.id, 'prepare')) return false;
  return Boolean(await findPriorSource(ctx, task));
}

/**
 * 작년 파일 읽기(조각·표)의 일반 오류는 다시 시도해도 같다 — 안내 문구가 있는 PRIOR_UNSUPPORTED로 바꿔 바로 멈춘다.
 * 원래 오류는 운영 기록에 남긴다(파일 글 없이 오류 문구 앞부분만) — 안내 문구만 남으면 읽기 코드의 결함을 찾을 수 없다
 */
async function readPrior<T>(ctx: WorkContext, task: WorkTaskRow, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof WorkError) throw e;
    await ctx
      .log({ level: 'warning', category: 'work', message: '작년 파일 읽기 실패', details: { task_id: task.id, error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200) } })
      .catch(() => undefined);
    throw new WorkError('PRIOR_UNSUPPORTED', '작년 파일을 읽지 못했습니다. 한글에서 다시 저장해 올려 주세요.', 422);
  }
}

/** 이 작업의 읽힌 작년 파일 — 여럿이면 가장 나중에 올린 것 */
export async function findPriorSource(ctx: WorkContext, task: WorkTaskRow): Promise<WorkSourceRow | null> {
  const list = (await ctx.store.listSources(task.id, task.organization_id)).filter((s) => s.task_id === task.id && s.status === 'ready' && s.purpose === 'prior');
  if (!list.length) return null;
  return list.reduce((a, b) => (Date.parse(b.created_at) > Date.parse(a.created_at) ? b : a));
}

/** KST 날짜 YYYY-MM-DD */
function kstIsoDate(d: Date): string {
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

const YEAR_IN_TEXT = /(?<!\d)((?:19|20)\d\d)(?!\d)/g;
const DIGIT_RUN = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/** 연도 표지가 하나도 없을 때 — 글 전체에서 가장 많이 나온 네 자리 연도(같으면 큰 해) */
function mostFrequentYear(texts: string[]): number | null {
  const counts = new Map<number, number>();
  for (const t of texts) for (const m of t.matchAll(YEAR_IN_TEXT)) counts.set(Number(m[1]), (counts.get(Number(m[1])) ?? 0) + 1);
  let best: number | null = null;
  for (const [y, n] of counts) if (best === null || n > counts.get(best)! || (n === counts.get(best)! && y > best)) best = y;
  return best;
}

/** 섹션마다 표(hp:tbl 열림) 수 — 조각의 표 번호(섹션 안 순번)를 문서 전체 순번(readHwpxTables)으로 바꾸는 데 쓴다 */
async function sectionTableCounts(bytes: Buffer): Promise<number[]> {
  const doc = await openHwpx(bytes);
  const counts: number[] = [];
  for (const name of doc.sections) {
    const xml = await readEntry(doc.zip, name);
    const tbl = `${paragraphPrefix(xml)}:tbl`;
    let n = 0;
    for (const tag of scanTags(xml)) if (tag.name === tbl && tag.kind === 'open') n++;
    counts.push(n);
  }
  return counts;
}

function hasNumbers(table: ExtractedTable): boolean {
  for (let r = table.header.to + 1; r < table.cells.length; r++) {
    if ((table.cells[r] ?? []).some((c) => parseNumber(c ?? null).kind === 'number')) return true;
  }
  return false;
}

interface TableWork {
  tableCells: PlanTableCell[];
  /** 조각 없는 빈 칸 → 구조 확인 요청(계획 뒤에 붙인다) */
  extra: Omit<Change, 'id'>[];
  /** 밀린 표 열 머리의 연도(전년도 열 머리도 한 해 민다) */
  headerShifted: Map<string, string>;
  /** 올해 값으로 확인된 숫자(당해 열·증감 열의 새 값 — 단위를 모르는 행은 빼고) */
  known: number[];
  /** 연도·수치를 하나도 바꾸지 않을 칸 조각(열을 가리지 못한 숫자 표·위치를 맞추지 못한 표) — 연도 밀기·모델 고치기에서 뺀다 */
  frozen: Set<string>;
  warnings: string[];
}

/**
 * 표 열 밀기 — 작년 표마다 전년도 ← 옛 당해, 당해 ← 올해 자료, 증감 다시 계산. 칸 좌표를 조각에 잇는다.
 * readHwpxTables(문서 전체 순번)와 조각의 칸 좌표(섹션 안 순번)는 둘 다 hp:tbl 열림 순서다 — 개수가 어긋나면(칸 없는 표 등)
 * 짐작하지 않고 표는 바꾸지 않는다(경고).
 */
async function tableWork(bytes: Buffer, segments: Segment[], findings: Map<string, Finding[]>, dataTables: ExtractedTable[], toYear: number): Promise<TableWork> {
  const out: TableWork = { tableCells: [], extra: [], headerShifted: new Map(), known: [], frozen: new Set(), warnings: [] };
  const { tables } = await readHwpxTables(bytes);
  if (!tables.length) return out;
  const counts = await sectionTableCounts(bytes);
  if (counts.reduce((a, b) => a + b, 0) !== tables.length) {
    out.warnings.push('작년 파일의 표 위치를 맞추지 못해 표는 바꾸지 않았습니다 — 표를 직접 확인하세요');
    // 어느 칸이 어느 표인지 모르니 칸의 연도도 밀지 않는다(표 머리 연도만 밀리면 값과 어긋난다)
    for (const s of segments) if (s.cell) out.frozen.add(s.id);
    return out;
  }
  const offsets: number[] = [];
  counts.reduce((acc, n, i) => ((offsets[i] = acc), acc + n), 0);
  /** 문서 전체 표 순번 → 그 표의 칸 조각(행·열 → 조각들), 문서 순서 */
  const byTable = new Map<number, Segment[]>();
  for (const s of segments) {
    if (!s.cell) continue;
    const g = offsets[s.section] + s.cell.table;
    byTable.set(g, [...(byTable.get(g) ?? []), s]);
  }

  tables.forEach((table, g) => {
    const plan = planColumnShift(table, toYear);
    const segs = byTable.get(g) ?? [];
    if (!plan) {
      // 숫자가 든 표의 열을 가리지 못했으면 머리 연도만 밀고 값은 그대로 두는 반쪽 표가 된다 — 표 전체를 그대로 두고 사람이 본다
      if (hasNumbers(table)) {
        for (const s of segs) out.frozen.add(s.id);
        if (segs[0]) out.extra.push({ segmentId: segs[0].id, kind: 'structure', before: '', after: null, status: 'needs_check', basis: [], note: NOTE_UNPLANNED_TABLE });
        else out.warnings.push(`표 ${g + 1}은 ${toYear - 2}년·${toYear - 1}년 열을 찾지 못해 바꾸지 않았습니다 — 직접 확인하세요`);
      }
      return;
    }
    const at = (row: number, col: number) => segs.filter((s) => s.cell!.row === row && s.cell!.col === col);

    // 열 머리의 연도도 한 해씩 민다: 전년도 열 (올해−2 → 올해−1), 당해 열 (올해−1 → 올해)
    for (let row = table.header.from; row <= table.header.to; row++) {
      for (const [col, from, to] of [[plan.prevCol, toYear - 2, toYear - 1], [plan.curCol, toYear - 1, toYear]] as const) {
        for (const s of at(row, col)) out.headerShifted.set(s.id, shiftYears(s.text, findings.get(s.id) ?? [], from, to).text);
      }
    }

    const m = matchRowValues(table, dataTables, columnName(table, plan.curCol));
    out.warnings.push(...m.warnings);
    for (const cell of shiftColumns(table, plan, m.values).cells) {
      const unsure = m.uncertain.has(cell.row);
      // 전년도 칸에 옮긴 값은 작년 수치다 — 본문 수치가 올해 값인지 가르는 기준(known)에 넣지 않는다.
      // 단위를 모르는 행의 값(1000배 어긋날 수 있다)도 넣지 않는다
      if (!unsure && cell.col !== plan.prevCol && cell.status === 'changed' && cell.after !== null) {
        const p = parseNumber(cell.after);
        if (p.kind === 'number') out.known.push(p.value);
      }
      // 값이 그대로인 칸(증감 100 → 100)은 변경이 아니다
      if (cell.status === 'changed' && cell.after === cell.before) continue;
      const own = at(cell.row, cell.col);
      if (own.length === 1 && (cell.before.includes('\n') || (cell.after ?? '').includes('\n'))) {
        // 칸 안 줄바꿈(<hp:lineBreak/>)도 여러 줄 칸이다 — 문단 하나의 글로 맞대면 적용이 PRIOR_MISMATCH로 멈춘다
        out.tableCells.push({ segmentId: own[0].id, cell: { ...cell, status: 'needs_check', note: NOTE_MULTI_PARAGRAPH_CELL }, uncertain: false });
      } else if (own.length === 1) {
        out.tableCells.push({ segmentId: own[0].id, cell, uncertain: unsure });
      } else if (own.length > 1) {
        out.tableCells.push({ segmentId: own[0].id, cell: { ...cell, status: 'needs_check', note: NOTE_MULTI_PARAGRAPH_CELL }, uncertain: false });
      } else {
        // 글 없는 칸 — 글자 단위로 고칠 문단이 없다. 같은 행의 첫 조각(없으면 표의 첫 조각)에 붙여 사람이 넣게 한다
        const anchor = segs.find((s) => s.cell!.row === cell.row) ?? segs[0];
        if (!anchor) {
          out.warnings.push(`표 ${g + 1}의 빈 칸에 값을 넣어야 합니다 — 직접 확인하세요`);
          continue;
        }
        out.extra.push({ segmentId: anchor.id, kind: 'structure', before: '', after: cell.after, status: 'needs_check', basis: [], note: NOTE_BLANK_CELL });
      }
    }
  });
  return out;
}

const YEARISH = new Set<Finding['kind']>(['year', 'period', 'date']);
const YEAR_SENTENCE_KINDS = new Set<Finding['kind']>(['year', 'period', 'date', 'number', 'citation']);
/** 연도 표지를 뺀 나머지 글이 이만큼(공백 빼고) 있어야 문장으로 본다 — '2025년 ○○ 사업계획' 같은 제목은 모델에 보내지 않는다 */
const YEAR_SENTENCE_MIN_CHARS = 10;

/**
 * 연도·기간·날짜가 든 본문 문장(I4) — 그 밖의 표지는 수치·인용뿐이고, 표지를 뺀 글이 10자 이상. 연도만 밀면 내용(사업 B 중단 등)이
 * 작년 그대로 남으므로 모델이 메모·원자료로 고칠 수 있게 보낸다. 고치기가 없으면 연도 밀기가 그대로 남는다
 */
export function isYearSentence(s: Pick<Segment, 'text' | 'cell'>, findings: Finding[]): boolean {
  if (s.cell || findings.length === 0) return false;
  if (!findings.every((f) => YEAR_SENTENCE_KINDS.has(f.kind)) || !findings.some((f) => YEARISH.has(f.kind))) return false;
  let rest = s.text;
  for (const f of [...findings].sort((a, b) => b.start - a.start)) rest = rest.slice(0, f.start) + rest.slice(f.end);
  return rest.replace(/\s+/g, '').length >= YEAR_SENTENCE_MIN_CHARS;
}

/** 모델 한 묶음의 입력 글자 수 어림 — 원가 예상(입력 글자/4 토큰) */
function inputChars(input: RewriteInput): number {
  const seg = input.segments.reduce((n, s) => n + s.text.length + s.path.join(' > ').length + 60, 0);
  const src = Math.min(MAX_REWRITE_SOURCE_CHARS, input.sources.reduce((n, s) => n + s.text.length + 80, 0));
  const cites = input.citations.filter((c) => c.status === 'changed' && c.current).reduce((n, c) => n + c.cited.text.length + Math.min(1500, c.current!.text.length) + 120, 0);
  return PROMPT_OVERHEAD_CHARS + input.title.length + input.memo.length + seg + src + cites;
}

/** 근거 제공자가 없을 때 — 인용은 모두 '찾지 못함'(던지지 않는다) */
function notFound(inputs: CitationInput[]): CitationPair[] {
  return inputs.map((i) => ({
    segmentId: i.segmentId,
    cited: { name: i.finding.detail?.name?.trim() ?? '', article: i.finding.detail?.article ?? null, text: i.segmentText.slice(i.finding.end, i.finding.end + 30).trim() },
    current: null,
    status: 'not_found',
  }));
}

export async function opGenerateCurrentize(ctx: WorkContext, run: WorkRunRow, task: WorkTaskRow, step: StepFn) {
  const model = ctx.currentize?.model;
  if (!model) throw new WorkError('WORKFLOW_NOT_READY', '이 업무는 아직 준비 중입니다.', 409);
  const def = definitionFor(task.workflow_key);
  const form = checkForm(def, task.form);
  if (form.missing.length) {
    throw new WorkError('REQUIRED_INPUT_MISSING', `필수 입력이 비어 있습니다: ${form.missing.map((m) => m.label).join(', ')}`, 422, { missing: form.missing.map((m) => m.key) });
  }
  const limit = await ctx.checkLimit(task.department_id, task.owner_id);
  if (!limit.allowed) throw new WorkError('USAGE_LIMIT', limit.message ?? '기관 사용 한도에 걸려 실행할 수 없습니다.', 429);

  // 1) 작년 파일 — 원본 바이트·해시·형식(HWPX만). 다시 시도하면 처음 고른 파일·해시 그대로
  const priorRow = await findPriorSource(ctx, task);
  let first = null as PriorFile | null;
  // 올해 자료(작년 파일·기준 양식이 아닌 읽힌 원자료)도 여기서 고정한다 — 실행이 기다리는 사이 올린 자료가 다시 시도에 섞이면
  // 체크포인트의 모델 결과를 다른 입력으로 검증하거나 묶음이 밀린다
  const loaded = await step('load_prior', async () => {
    if (!priorRow) throw new WorkError('REQUIRED_INPUT_MISSING', '작년 파일이 없습니다. 작년 파일을 올려 주세요.', 422);
    first = await loadPriorFile(ctx, task, priorRow.id);
    const inputSourceIds = (await ctx.store.listSources(task.id, task.organization_id))
      .filter((s) => s.task_id === task.id && s.status === 'ready' && s.purpose !== 'prior' && s.purpose !== 'template')
      .map((s) => s.id)
      .sort();
    return { priorSourceId: first.source.id, priorSha256: first.sha256, inputSourceIds };
  });
  const prior = first ?? (await loadPriorFile(ctx, task, loaded.priorSourceId, loaded.priorSha256));

  // 올해 자료 — 첫 시도에 고정한 원자료만, 고정한 순서대로. 그 사이 지워졌으면 다시 시도해도 같으니 멈춘다
  const extracts = new Map((await loadSourceExtracts(ctx, task)).map((s) => [s.id, s]));
  const inputs = loaded.inputSourceIds.map((id) => {
    const s = extracts.get(id);
    if (!s) throw new WorkError('SOURCE_UNAVAILABLE', '원자료가 그 사이 지워졌습니다. 다시 만들어 주세요.', 409, { retryable: false });
    return s;
  });
  const dataTables = inputs.flatMap((s) => s.tables);
  // 본문 수치 대조에 쓰는 올해 자료 표 — 참고 자료(규정·지침)의 표는 올해 값이 아니다
  const valueTables = inputs.filter((s) => s.purpose !== 'reference').flatMap((s) => s.tables);
  const memo = typeof form.values.emphasis === 'string' ? form.values.emphasis : '';
  const formBasis = typeof form.values.basisDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(form.values.basisDate) ? form.values.basisDate : null;
  const today = kstIsoDate(ctx.now());
  const basisDate = formBasis ?? today;
  const periodYear = [...String(form.values.period ?? '').matchAll(YEAR_IN_TEXT)][0]?.[1];
  const basisYear = formBasis ? Number(formBasis.slice(0, 4)) : periodYear ? Number(periodYear) : Number(today.slice(0, 4));
  // 규정 이름 — 「…」는 분류가 목록 없이 찾고, 그 밖에는 직원이 올린 참고 자료의 이름(확장자 뗌)
  const regulationNames = inputs.filter((s) => s.purpose === 'reference').map((s) => s.name.replace(/\.[^.]+$/, '').trim()).filter((n) => n.length >= 2);

  // 2) 조각 — 같은 바이트에서 언제나 같다
  const { segments, truncated } = await readPrior(ctx, task, () => readSegments(prior.bytes));
  await step('segments', async () => ({ count: segments.length, truncated }));

  // 3) 분류·연도
  const findings = new Map<string, Finding[]>(segments.map((s) => [s.id, classifySegment(s.text, { basisDate, regulationNames, personNames: [] })]));
  const years = await step('classify', async () => {
    const fromYear = dominantYear([...findings.values()].flat()) ?? mostFrequentYear(segments.map((s) => s.text));
    if (fromYear === null) throw new WorkError('REQUIRED_INPUT_MISSING', '작년 파일에서 연도를 찾지 못했습니다.', 422);
    return { fromYear, toYear: basisYear <= fromYear ? fromYear + 1 : basisYear };
  });
  const { fromYear, toYear } = years;

  const tables = await readPrior(ctx, task, () => tableWork(prior.bytes, segments, findings, dataTables, toYear));
  // 그대로 둘 칸(열을 가리지 못한 숫자 표)은 연도도 밀지 않는다
  const shifted = new Map<string, string>(
    segments.map((s) => [s.id, tables.frozen.has(s.id) ? s.text : (tables.headerShifted.get(s.id) ?? shiftYears(s.text, findings.get(s.id) ?? [], fromYear, toYear).text)])
  );

  // 본문 수치 대조의 기준(C2) — 올해 자료 표의 '올해 값 열'(표 계산이 고르는 열)만 + 표 계산의 새 값(단위 모르는 행 제외) + 직원 메모의 숫자.
  // 같은 표의 작년 열·참고 자료의 표를 넣으면 옛 수치가 '확인됨'으로 통과한다
  const known = new Set<number>([...tables.known, ...thisYearColumnValues(valueTables, toYear)]);
  for (const d of memo.match(DIGIT_RUN) ?? []) known.add(Number(d.replace(/,/g, '')));
  const numberStatus = new Map<string, 'ok' | 'needs_check'>();
  const numberTokens = new Map<string, string[]>();
  // 표 칸 수치는 표 계산이 맡는다 — 본문(칸 밖) 조각만 본다
  for (const s of segments) {
    if (s.cell) continue;
    const unknown = unknownProseNumbers(findings.get(s.id) ?? [], known);
    numberStatus.set(s.id, unknown.length ? 'needs_check' : 'ok');
    if (unknown.length) numberTokens.set(s.id, unknown);
  }

  // 4) 인용 대조 — 제공자 호출이라 체크포인트
  const citeInputs: CitationInput[] = segments.flatMap((s) => (findings.get(s.id) ?? []).filter((f) => f.kind === 'citation').map((finding) => ({ segmentId: s.id, segmentText: s.text, finding })));
  const evidence = await step('evidence', async () => {
    if (!citeInputs.length) return { citations: [] as CitationPair[], warning: null as string | null };
    if (!ctx.regulations) return { citations: notFound(citeInputs), warning: '근거 조문을 찾을 수 없는 환경이라 인용을 확인하지 못했습니다 — 직접 확인하세요' };
    const scope = { organizationId: task.organization_id, organizationName: await ctx.store.getOrganizationName(task.organization_id), departmentId: task.department_id };
    return { citations: await compareCitations(citeInputs, ctx.regulations.providers, scope, basisDate), warning: null as string | null };
  });
  const citations = evidence.citations;
  const warnings = [...tables.warnings, ...(evidence.warning ? [evidence.warning] : [])];

  // 5) 줄글 고치기 — 줄글 조각 + 인용이 바뀐 조각 + 연도가 든 문장, 문서 순서로 묶음마다(모델에는 연도를 민 글)
  const changedCitation = new Set(citations.filter((c) => c.status === 'changed').map((c) => c.segmentId));
  const isProse = (s: Segment) => (findings.get(s.id) ?? []).some((f) => f.kind === 'prose');
  const targets = segments.filter((s) => !tables.frozen.has(s.id) && (isProse(s) || changedCitation.has(s.id) || isYearSentence(s, findings.get(s.id) ?? [])));
  const batches: Segment[][] = [];
  for (let i = 0; i < targets.length; i += MODEL_BATCH_SEGMENTS) batches.push(targets.slice(i, i + MODEL_BATCH_SEGMENTS));
  const modelId = batches.length ? await ctx.resolveModel(task.department_id) : null;
  const cap = ctx.costCapKrw ?? DEFAULT_COST_CAP_KRW;
  const sources = inputs.map((s) => ({ id: s.id, name: s.name, text: s.text }));
  const accepted: RawRewrite[] = [];
  const proposed: RawRewrite[] = [];
  let mode: 'llm' | 'mock' | null = null;
  let spent = 0;
  let stoppedAt: number | null = null;
  for (let i = 0; i < batches.length; i++) {
    const input: RewriteInput = {
      title: task.title,
      basisDate,
      memo,
      segments: batches[i].map((s) => ({ id: s.id, text: shifted.get(s.id) ?? s.text, path: s.path })),
      sources,
      citations,
    };
    // 원가 상한 — 보내기 전에 지금까지 쓴 원가 + 이 묶음 예상(입력만)이 넘으면 멈춘다. 끝난 묶음의 원가는 체크포인트에서 오므로 다시 시도해도 같은 자리에서 멈춘다
    const estimate = estimateCostKrw({ input_tokens: Math.ceil(inputChars(input) / 4), output_tokens: 0 }, modelId);
    if (spent + estimate > cap) {
      stoppedAt = i;
      break;
    }
    const out = await step(rewriteStepName(i), async () => {
      const r = await model.rewrite(input, { model: modelId! });
      await writeModelUsage(ctx, run, task, r.usage, 'rewrite');
      return { rewrites: r.rewrites, usage: r.usage, mode: r.mode };
    });
    if (out.usage) spent += estimateCostKrw(out.usage, out.usage.model);
    mode = out.mode;
    const v = verifyRewrites(out.rewrites, input, known);
    accepted.push(...v.accepted);
    proposed.push(...v.proposed);
  }

  // 6) 변경 목록 — 계획 + 빈 칸 구조 확인 + 원가 상한으로 못 본 줄글
  const planned = buildPlan({
    segments,
    fromYear,
    toYear,
    findings,
    shifted,
    tableCells: tables.tableCells,
    rewrites: { accepted, proposed },
    citations,
    numberStatus,
    numberTokens,
    plannedYearSegments: new Set(tables.headerShifted.keys()),
  });
  const extra: Omit<Change, 'id'>[] = [...tables.extra];
  if (stoppedAt !== null) {
    for (const s of batches.slice(stoppedAt).flat()) {
      if (isProse(s)) extra.push({ segmentId: s.id, kind: 'prose', before: s.text, after: null, status: 'needs_check', basis: [], note: NOTE_COST_STOPPED });
    }
  }
  // 위치(제목 사슬·표 좌표)는 판에 남긴다 — 화면이 작년 파일을 다시 읽지 않고 '어디'를 보이게
  const labels = segmentLabels(segments);
  const changes: Change[] = [...planned, ...extra.map((c, i) => ({ id: `c${planned.length + i + 1}`, ...c }))].map((c) => {
    const location = labels.get(c.segmentId);
    return location === undefined ? c : { ...c, location };
  });
  const content: CurrentizeContent = {
    schema: 'currentize/1',
    priorSourceId: prior.source.id,
    priorSha256: prior.sha256,
    fromYear,
    toYear,
    changes,
    citations,
    truncated,
    costStopped: stoppedAt !== null,
    mode: mode ?? ctx.generatorMode,
  };

  // 7) 판 — 작년 파일이 곧 양식이라 칸·양식 판이 없다
  const saved = await step('save_version', async () => {
    const existing = await ctx.store.getVersionByRun(task.id, run.id);
    if (existing) return { versionId: existing.id, version: existing.version };
    const v = await ctx.store.saveVersion({
      taskId: task.id,
      organizationId: task.organization_id,
      baseVersion: run.base_version,
      fields: [],
      content: { currentize: content, currentizeWarnings: warnings },
      templateVersionId: null,
      origin: 'generate',
      reason: content.mode === 'mock' ? `시험 모드로 작년 문서 현행화(${fromYear}→${toYear})` : `작년 문서 현행화(${fromYear}→${toYear})`,
      actorId: run.requested_by,
      runId: run.id,
      sourceIds: [prior.source.id, ...inputs.map((s) => s.id)],
    });
    return { versionId: v.id, version: v.version };
  });
  const review = await step('review', async () => {
    const v = (await ctx.store.getVersion(saved.versionId, task.organization_id))!;
    const stored = (v.content as { currentize?: CurrentizeContent } | null)?.currentize ?? content;
    const items = currentizeReviewItems(stored);
    await ctx.store.replaceReviewItems(task.id, task.organization_id, v.id, items);
    return { blocking: items.filter((i) => i.severity === 'blocking').length, warning: items.filter((i) => i.severity === 'warning').length };
  });
  const file = await step('file', () => buildFileStep(ctx, run, task, saved.versionId));
  await ctx.store.setTaskStatus(task.id, task.organization_id, 'needs_review');
  return {
    versionId: saved.versionId,
    version: saved.version,
    artifactId: file.artifactId,
    review,
    mode: content.mode,
    changes: changes.length,
    costStopped: content.costStopped,
  };
}
