import { chooseBranch, classifyKey, conditionHolds, renderAppInput, type AppDefinition } from './definition';
import type { AppStepRecord } from './pipeline';

export function restoreAppSteps(definition: AppDefinition, references: Record<string, unknown>, currentMessage: string): { ok: true; records: AppStepRecord[] } | { ok: false; message: string } {
  const fail = (message: string) => ({ ok: false as const, message });
  const steps = definition.steps;
  if (!steps?.length || !Array.isArray(references.app_steps) || references.app_steps.length !== steps.length) return fail('이어 실행할 단계 기록이 없습니다. 새로 실행해 주세요.');
  if (!references.app_inputs || typeof references.app_inputs !== 'object' || Array.isArray(references.app_inputs)) return fail('이 기록에는 재개용 입력 정보가 없습니다. 새로 실행해 주세요.');
  const original = renderAppInput(definition, references.app_inputs);
  if (!original.ok || original.message !== currentMessage) return fail('원래 입력과 다릅니다. 입력을 바꿨다면 새로 실행해 주세요.');
  const records: AppStepRecord[] = []; let failed = false; let completed = 0;
  // 조건 판정 값 — 입력값 + 재사용할 분류 단계의 결과(@N). 실행기와 같은 값으로 갈래·건너뛰기를 맞춰 본다
  const judged: Record<string, string> = { ...original.inputs };
  for (let index = 0; index < steps.length; index++) {
    const saved = references.app_steps[index]; const step = steps[index];
    if (!saved || typeof saved !== 'object' || saved.name !== step.name) return fail('단계 기록이 현재 앱과 다릅니다. 새로 실행해 주세요.');
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
      records.push({ name: step.name, status: 'completed', output: saved.output, reused: true, ...(branch ? { branch } : {}), ...(step.repeat && typeof saved.repeated === 'number' ? { repeated: saved.repeated, ...(saved.repeatedFiles === true ? { repeatedFiles: true as const } : {}) } : {}) }); completed++;
    } else if (!failed && saved.status === 'skipped') {
      if (!step.when || conditionHolds(step.when, judged)) return fail('단계의 실행 조건과 기록이 다릅니다. 새로 실행해 주세요.');
      records.push({ name: step.name, status: 'skipped' });
    } else {
      if (!failed && saved.status === 'failed') failed = true;
      else if (!failed || saved.status !== 'not_run') return fail('중단된 실행 기록만 이어서 실행할 수 있습니다.');
      records.push({ name: step.name, status: 'pending' });
    }
  }
  if (!failed || !completed) return fail('재사용할 완료 단계가 없습니다. 새로 실행해 주세요.');
  return { ok: true, records };
}

/** 첨부 읽기 능력 — 이번 실행에 파일이 없으면 프롬프트에 아무것도 더하지 않는다 */
const ATTACHMENT_ONLY_CAPABILITIES: ReadonlySet<string> = new Set(['file_read', 'table_merge']);

/**
 * 결과가 입력 글에만 기대는 실행인가 — 재개용 입력 저장(stream.ts)과 재개 허용(prepare.ts)이 같은 규칙을 쓴다.
 * 켜진 능력이 첨부 읽기뿐이고 이번 실행에 파일이 없을 때만 참. 문서 찾기·공공 데이터 같은 능력은 근거가 바뀔 수 있어 거짓.
 * 사진은 `image` 능력이 켜진 비서만 받으므로(그 밖은 prepare가 거절) 능력 조건이 사진도 막는다.
 */
export function isInputOnlyRun(capabilityIds: readonly string[], attachmentCount: number): boolean {
  return attachmentCount === 0 && capabilityIds.every(id => ATTACHMENT_ONLY_CAPABILITIES.has(id));
}
