// src/lib/apps/call-estimate.ts
// 입력형 앱 실행 전 예상 AI 호출 수(2026-11-07) — 실행 화면이 '초안 만들기' 옆에 보인다. 실행기(pipeline.ts)와 같은 규칙으로 센다:
// 중간 단계는 한 번(분류도 한 번), 조회 단계는 AI를 부르지 않고(조회로 따로 셈), 반복은 줄 수·파일 수만큼, 마지막 단계는 언제나 한 번.
// 실행 조건이 입력만 보면 지금 입력으로 판정하고, 앞 분류 결과(@N)를 보면 미리 알 수 없어 '많으면'에만 넣는다.
// 긴 첨부를 나눠 추리는 호출(조각마다)은 파일을 읽어 봐야 알아 숫자에 넣지 않고 따로 알린다. 화면도 쓰는 잎 모듈 — definition.ts만 가져온다
import { branchJumpIndex, chooseBranch, conditionHolds, conditionRules, repeatItems, repeatsFiles, type AppDefinition, type AppStepCondition } from './definition';

export type AppCallEstimate = {
  /** 적어도 이만큼 AI를 부른다 */
  min: number;
  /** 많으면 이만큼(분류 결과에 따라 갈리는 단계를 모두 실행할 때) */
  max: number;
  /** 공공 데이터 조회 수(AI 사용량 없음) — 많으면 기준 */
  lookups: number;
  /** 첨부가 길면 조각마다 추리는 호출이 더 든다(파일·문서를 붙였을 때만 참) */
  mayDigest: boolean;
};

export function estimateAppCalls(def: AppDefinition, inputs: Record<string, string>, fileCount: number): AppCallEstimate {
  const steps = def.steps ?? [];
  let min = 0; let max = 0; let lookups = 0;
  if (!steps.length) return { min: 1, max: 1, lookups: 0, mayDigest: fileCount > 0 };
  const onClassify = (c: AppStepCondition) => conditionRules(c).some((rule) => rule.field.startsWith('@'));
  // 갈래의 건너가기(2026-11-08) — 입력만 보고 정해지면 사이 단계를 빼고, 분류 결과에 갈리거나 그 단계가 돌지 모르면 사이 단계는 '많으면'에만
  let skipUntil = -1;
  const maybeSkipped = new Set<number>();
  steps.forEach((step, index) => {
    if (index < skipUntil) return;
    const last = index === steps.length - 1;
    const calls = last ? 1 : step.lookup ? 0 : step.repeat ? (repeatsFiles(step.repeat) ? fileCount : repeatItems(inputs[step.repeat.field]).length) : 1;
    const lookup = !last && step.lookup ? 1 : 0;
    let surely: boolean;
    if (!step.when || last) surely = !maybeSkipped.has(index) || last;
    else if (onClassify(step.when)) { max += calls; lookups += lookup; surely = false; markJumps(false); return; }
    else if (conditionHolds(step.when, inputs)) surely = !maybeSkipped.has(index);
    else return;
    if (surely) min += calls;
    max += calls; lookups += lookup;
    markJumps(surely);

    function markJumps(runs: boolean) {
      if (last || !step.branches?.length) return;
      if (runs && !step.branches.some((b) => onClassify(b.when))) {
        const target = branchJumpIndex(index, chooseBranch(step, inputs), steps.length);
        if (target !== null) skipUntil = target;
        return;
      }
      for (const b of step.branches) {
        const target = branchJumpIndex(index, b, steps.length);
        if (target !== null) for (let i = index + 1; i < target; i++) maybeSkipped.add(i);
      }
    }
  });
  return { min, max, lookups, mayDigest: fileCount > 0 };
}

/** 화면 한 줄 — '예상 AI 호출 3번' · '2~4번' · 조회·긴 첨부 안내 */
export function describeAppCalls(e: AppCallEstimate): string {
  const calls = e.min === e.max ? `${e.min}번` : `${e.min}~${e.max}번`;
  const parts = [`예상 AI 호출 ${calls}`];
  if (e.lookups) parts.push(`공공 데이터 조회 ${e.lookups}번(AI 사용량 없음)`);
  if (e.mayDigest) parts.push('첨부가 길면 조각마다 추리는 호출이 더 듭니다');
  return parts.join(' · ');
}
