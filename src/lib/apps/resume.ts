import { APP_DOC_SOURCE_PATH, APP_LOOKUP_TOOLS, APP_LOOPS_PER_RUN, branchBackIndex, branchJumpIndex, chooseBranch, classifyKey, conditionHolds, renderAppInput, repeatItems, repeatsFiles, type AppDefinition, type AppStep } from './definition';
import type { AppStepRecord, AppStepSource } from './pipeline';

/**
 * 이어 실행에서 다시 쓰는 조회 단계(2026-11-09) — 조회 단계로 남긴다(그래야 다음 단계에 '조회 자료'로 가고, 문서 찾기는 정보 공백이 이어진다).
 * 저장된 출처는 믿지 않고 꼴(공공 데이터는 http·https, 문서 찾기는 문서 원본 주소)만 다시 거른다
 */
function reusedLookup(saved: Record<string, unknown>, docSearch: boolean, dataTable = false): Partial<AppStepRecord> {
  if (saved.kind !== 'lookup') return {};
  // 데이터 표 계산(2026-11-26)의 출처도 문서 원본 주소
  const ok = (url: unknown) => typeof url === 'string' && (docSearch || dataTable ? APP_DOC_SOURCE_PATH.test(url) : /^https?:\/\//.test(url));
  const sources: AppStepSource[] = Array.isArray(saved.sources)
    ? saved.sources.filter((s): s is { title?: unknown; url: string } => Boolean(s) && typeof s === 'object' && ok((s as { url?: unknown }).url)).slice(0, 10).map((s) => ({ title: String(s.title ?? '').slice(0, 200), url: s.url }))
    : [];
  return {
    kind: 'lookup',
    ...(typeof saved.query === 'string' ? { query: saved.query.slice(0, 1100) } : {}),
    ...(Array.isArray(saved.queries) ? { queries: saved.queries.filter((q): q is string => typeof q === 'string').slice(0, 10).map((q) => q.slice(0, 200)) } : {}),
    ...(typeof saved.refined === 'number' && Number.isInteger(saved.refined) && saved.refined >= 0 && saved.refined <= 2 ? { refined: saved.refined } : {}),
    ...(typeof saved.article === 'string' && /^\d{1,4}$/.test(saved.article) ? { article: saved.article } : {}),
    ...(sources.length ? { sources } : {}),
    ...(docSearch ? {
      docSearch: true as const,
      ...(saved.gap === true ? { gap: true as const } : {}),
      ...(Array.isArray(saved.tags) ? { tags: saved.tags.filter((t): t is string => typeof t === 'string').slice(0, 5).map((t) => t.slice(0, 20)) } : {}),
      ...(Array.isArray(saved.gapQueries) ? { gapQueries: saved.gapQueries.filter((q): q is string => typeof q === 'string').slice(0, 10).map((q) => q.slice(0, 200)) } : {}),
    } : {}),
  };
}

/**
 * 멈춘 줄마다 반복 단계의 끝난 줄(2026-11-07) — 지금 입력의 줄보다 적고, 글이 비지 않았고, 합쳐 12,000자 안이고,
 * 갈래가 지금 고를 갈래와 같을 때만 다시 쓴다(아니면 null — 그 단계를 처음부터)
 */
function reusablePartial(step: AppStep, saved: Record<string, unknown>, inputs: Record<string, string>, branch: string | undefined): string[] | null {
  if (!step.repeat || repeatsFiles(step.repeat) || !Array.isArray(saved.partial) || !saved.partial.length) return null;
  const items = repeatItems(inputs[step.repeat.field]);
  const partial = saved.partial;
  if (partial.length >= items.length || partial.some((t) => typeof t !== 'string' || !t.trim()) || partial.join('').length > 12000) return null;
  if ((typeof saved.branch === 'string' ? saved.branch : undefined) !== branch) return null;
  return partial as string[];
}

export function restoreAppSteps(definition: AppDefinition, references: Record<string, unknown>, currentMessage: string): { ok: true; records: AppStepRecord[] } | { ok: false; message: string } {
  const fail = (message: string) => ({ ok: false as const, message });
  const steps = definition.steps;
  if (!steps?.length || !Array.isArray(references.app_steps) || references.app_steps.length !== steps.length) return fail('이어 실행할 단계 기록이 없습니다. 새로 실행해 주세요.');
  if (!references.app_inputs || typeof references.app_inputs !== 'object' || Array.isArray(references.app_inputs)) return fail('이 기록에는 재개용 입력 정보가 없습니다. 새로 실행해 주세요.');
  const original = renderAppInput(definition, references.app_inputs);
  if (!original.ok || original.message !== currentMessage) return fail('원래 입력과 다릅니다. 입력을 바꿨다면 새로 실행해 주세요.');
  // 되돌아간 실행(2026-11-25) — 되돌아간 횟수(`looped`)와 되돌아온 까닭(`loopFeedback`)을 이어 받는다. 되돌아갈 수 있는 단계의 기록에만,
  // 횟수는 합쳐 한 실행의 상한 안, 까닭은 되돌아가 다시 하는 중(끝나지 않은 단계)에만 — 아니면 처음부터
  const loopError = '되돌아간 단계의 기록이 현재 앱과 다릅니다. 새로 실행해 주세요.';
  let loopTotal = 0; let feedbackCount = 0;
  for (const [i, s] of (references.app_steps as unknown[]).entries()) {
    if (!s || typeof s !== 'object') continue;
    const { looped, loopFeedback, status } = s as { looped?: unknown; loopFeedback?: unknown; status?: unknown };
    if (looped === undefined && loopFeedback === undefined) continue;
    const canLoop = Boolean(steps[i]?.branches?.some((b) => branchBackIndex(i, b, steps.length) !== null));
    if (!canLoop) return fail(loopError);
    if (looped !== undefined) {
      if (typeof looped !== 'number' || !Number.isInteger(looped) || looped < 1) return fail(loopError);
      loopTotal += looped;
    }
    if (loopFeedback !== undefined) {
      if (typeof loopFeedback !== 'string' || !loopFeedback.trim() || loopFeedback.length > 12000 || status === 'completed' || looped === undefined) return fail(loopError);
      feedbackCount++;
    }
  }
  if (loopTotal > APP_LOOPS_PER_RUN || feedbackCount > 1) return fail(loopError);
  const loopState = (saved: Record<string, unknown>, pending: boolean): Partial<AppStepRecord> => ({
    ...(typeof saved.looped === 'number' ? { looped: saved.looped } : {}),
    ...(pending && typeof saved.loopFeedback === 'string' ? { loopFeedback: saved.loopFeedback } : {}),
  });
  const records: AppStepRecord[] = []; let failed = false; let completed = 0; let partialReused = false;
  // 조건 판정 값 — 입력값 + 재사용할 분류 단계의 결과(@N). 실행기와 같은 값으로 갈래·건너뛰기를 맞춰 본다
  const judged: Record<string, string> = { ...original.inputs };
  // 앞 단계의 갈래가 건너간 자리(2026-11-08) — 그 앞 단계는 기록에서도 건너뛰어져 있어야 한다(실행기와 같은 규칙)
  let skipUntil = -1;
  for (let index = 0; index < steps.length; index++) {
    const saved = references.app_steps[index]; const step = steps[index];
    if (!saved || typeof saved !== 'object' || saved.name !== step.name) return fail('단계 기록이 현재 앱과 다릅니다. 새로 실행해 주세요.');
    if (index < skipUntil) {
      if (failed || saved.status !== 'skipped') return fail('단계의 갈래가 기록과 다릅니다. 새로 실행해 주세요.');
      records.push({ name: step.name, status: 'skipped', jumped: true });
      continue;
    }
    if (!failed && saved.status === 'completed') {
      if (index === steps.length - 1 || typeof saved.output !== 'string' || !saved.output.trim() || saved.output.length > 12000 || (step.when && !conditionHolds(step.when, judged))) return fail('재사용할 단계 결과를 확인하지 못했습니다. 새로 실행해 주세요.');
      if (step.classify) {
        // 분류 결과는 지금 선택지 안의 값이어야 한다(선택지를 고쳤으면 새로 실행)
        if (saved.kind !== 'classify' || !step.classify.options.includes(saved.output)) return fail('분류 단계의 기록이 현재 선택지와 다릅니다. 새로 실행해 주세요.');
        judged[classifyKey(index)] = saved.output;
        records.push({ name: step.name, status: 'completed', output: saved.output, reused: true, kind: 'classify' }); completed++;
        continue;
      }
      if (saved.kind === 'classify') return fail('분류 단계의 기록이 현재 앱과 다릅니다. 새로 실행해 주세요.');
      // 기록의 갈래가 지금 정의·입력으로 고를 갈래와 다르면(갈래를 고쳤거나 없앴음) 다른 지시로 만든 결과라 재사용하지 않는다
      const branch = chooseBranch(step, judged)?.name;
      if ((typeof saved.branch === 'string' ? saved.branch : undefined) !== branch) return fail('단계의 갈래가 기록과 다릅니다. 새로 실행해 주세요.');
      records.push({ name: step.name, status: 'completed', output: saved.output, reused: true, ...loopState(saved as Record<string, unknown>, false), ...(branch ? { branch } : {}), ...(step.repeat && typeof saved.repeated === 'number' ? { repeated: saved.repeated, ...(saved.repeatedFiles === true ? { repeatedFiles: true as const } : {}) } : {}), ...(step.lookup ? reusedLookup(saved as Record<string, unknown>, APP_LOOKUP_TOOLS[step.lookup.tool].capability === 'doc_search', APP_LOOKUP_TOOLS[step.lookup.tool].capability === 'table_merge') : {}) }); completed++;
      const target = branchJumpIndex(index, step.branches?.find(b => b.name === branch), steps.length);
      if (target !== null) skipUntil = Math.max(skipUntil, target);
    } else if (!failed && saved.status === 'skipped') {
      if (saved.jumped === true || !step.when || conditionHolds(step.when, judged)) return fail('단계의 실행 조건과 기록이 다릅니다. 새로 실행해 주세요.');
      records.push({ name: step.name, status: 'skipped' });
    } else {
      if (!failed && saved.status === 'failed') {
        failed = true;
        // 줄마다 반복이 도중에 멈췄으면 끝난 줄은 다시 쓴다(실행 조건이 지금도 맞을 때만)
        const branch = chooseBranch(step, judged)?.name;
        const partial = !step.when || conditionHolds(step.when, judged) ? reusablePartial(step, saved as Record<string, unknown>, original.inputs, branch) : null;
        if (partial) { records.push({ name: step.name, status: 'pending', partial, ...loopState(saved as Record<string, unknown>, true) }); partialReused = true; continue; }
      } else if (!failed || saved.status !== 'not_run') return fail('중단된 실행 기록만 이어서 실행할 수 있습니다.');
      records.push({ name: step.name, status: 'pending', ...loopState(saved as Record<string, unknown>, true) });
    }
  }
  if (!failed || (!completed && !partialReused)) return fail('재사용할 완료 단계가 없습니다. 새로 실행해 주세요.');
  return { ok: true, records };
}

/** 첨부 읽기 능력 — 이번 실행에 파일이 없으면 프롬프트에 아무것도 더하지 않는다 */
const ATTACHMENT_ONLY_CAPABILITIES: ReadonlySet<string> = new Set(['file_read', 'table_merge']);

/**
 * 결과가 입력 글에만 기대는 실행인가 — 재개용 입력 저장(stream.ts)과 재개 허용(prepare.ts)이 같은 규칙을 쓴다.
 * 켜진 능력이 첨부 읽기뿐이고 이번 실행에 파일이 없을 때만 참. 문서 찾기·공공 데이터 같은 능력은 근거가 바뀔 수 있어 거짓.
 * 사진은 `image` 능력이 켜진 비서만 받으므로(그 밖은 prepare가 거절) 능력 조건이 사진도 막는다.
 */
export function isInputOnlyRun(capabilities: readonly string[] | object, attachmentCount: number): boolean {
  const ids = Array.isArray(capabilities) ? capabilities : Object.keys(capabilities);
  // 비서 문서함의 표 파일로 계산(2026-11-26)하면 근거가 문서함에 기대므로 입력만 쓰는 실행이 아니다
  const dataFiles = !Array.isArray(capabilities) && (capabilities as { table_merge?: { agent_documents?: unknown } }).table_merge?.agent_documents === true;
  return attachmentCount === 0 && !dataFiles && ids.every(id => ATTACHMENT_ONLY_CAPABILITIES.has(id));
}

/**
 * 멈춘 답변에 이어 갈 진행이 남았나(2026-11-08, 예약 자동 이어 실행) — 재개용 입력(`app_inputs`, 입력만 쓰는 실행에만 저장됨)이 있고
 * 끝난 단계가 있거나 반복이 도중에 멈춘 줄이 있을 때. 대략의 판정이다 — 실제로 이어 갈 수 있는지는 이어 실행 요청을 대화 실행기가 다시 본다
 */
export function hasResumableProgress(references: unknown): boolean {
  if (!references || typeof references !== 'object' || Array.isArray(references)) return false;
  const refs = references as Record<string, unknown>;
  if (!refs.app_inputs || typeof refs.app_inputs !== 'object' || Array.isArray(refs.app_inputs) || !Array.isArray(refs.app_steps)) return false;
  const steps = refs.app_steps as Array<Record<string, unknown> | null>;
  if (!steps.some((s) => s?.status === 'failed' || s?.status === 'not_run')) return false;
  return steps.some((s) => s?.status === 'completed' || (s?.status === 'failed' && Array.isArray(s.partial) && s.partial.length > 0));
}
