// src/lib/apps/call-estimate.ts
// 입력형 앱 실행 전 예상 AI 호출 수(2026-11-07) — 실행 화면이 '초안 만들기' 옆에 보인다. 실행기(pipeline.ts)와 같은 규칙으로 센다:
// 중간 단계는 한 번(분류도 한 번), 조회 단계는 AI를 부르지 않고(조회로 따로 셈), 반복은 줄 수·파일 수만큼, 마지막 단계는 언제나 한 번.
// 실행 조건이 입력만 보면 지금 입력으로 판정하고, 앞 분류 결과(@N)를 보면 미리 알 수 없어 '많으면'에만 넣는다.
// 긴 첨부를 나눠 추리는 호출(조각마다)은 파일을 읽어 봐야 알아 숫자에 넣지 않고 따로 알린다. 화면도 쓰는 잎 모듈 — definition.ts만 가져온다
import { APP_DATA_LOOKUP_ATTEMPTS, APP_LOOKUP_EACH_MAX, APP_LOOKUP_REFINE_TOTAL, APP_LOOKUP_TOOLS, APP_LOOPS_PER_RUN, branchBackIndex, branchJumpIndex, branchRounds, chooseBranch, conditionHolds, conditionRules, repeatItems, repeatsFiles, type AppDefinition, type AppStepCondition } from './definition';

export type AppCallEstimate = {
  /** 적어도 이만큼 AI를 부른다 */
  min: number;
  /** 많으면 이만큼(분류 결과에 따라 갈리는 단계를 모두 실행할 때) */
  max: number;
  /** 공공 데이터 조회 수(AI 사용량 없음) — 많으면 기준 */
  lookups: number;
  /**
   * 웹 검색 조회의 AI 호출 수(2026-11-26) — 많으면 기준. 조회어마다 AI가 웹을 찾아 간추리므로 `min`·`max`에도 들어 있다(검색 요금은 따로 —
   * 사용량 예약이 호출마다 검색 `APP_WEB_LOOKUP_MAX_USES`번으로 셈). 조사 단계가 웹 검색을 고를 수 있으면 조회어 합계 상한만큼
   */
  webSearches: number;
  /** 첨부가 길면 조각마다 추리는 호출이 더 든다(파일·문서를 붙였을 때만 참) */
  mayDigest: boolean;
};

export function estimateAppCalls(def: AppDefinition, inputs: Record<string, string>, fileCount: number): AppCallEstimate {
  const steps = def.steps ?? [];
  let min = 0; let max = 0; let lookups = 0; let webSearches = 0;
  if (!steps.length) return { min: 1, max: 1, lookups: 0, webSearches: 0, mayDigest: fileCount > 0 };
  // 웹 검색 조회(2026-11-26) — 조회어마다 AI 호출 하나. 줄마다 찾기는 5줄, 더 찾기·조사 단계는 조회어 합계 상한까지
  const webCallsAt = (i: number) => {
    const s = steps[i];
    if (i === steps.length - 1) return 0;
    if (s.lookup && APP_LOOKUP_TOOLS[s.lookup.tool].capability === 'web_search') return s.lookup.refine ? APP_LOOKUP_REFINE_TOTAL : s.lookup.each ? APP_LOOKUP_EACH_MAX : 1;
    if (s.research?.tools.some((t) => APP_LOOKUP_TOOLS[t].capability === 'web_search')) return APP_LOOKUP_REFINE_TOTAL;
    return 0;
  };
  // 데이터 표 계산(2026-11-26) — 지시를 쓰는 AI 호출 하나, 틀리면 한 번 더(많으면에만)
  const dataCallsAt = (i: number) => (i < steps.length - 1 && steps[i].lookup && APP_LOOKUP_TOOLS[steps[i].lookup!.tool].capability === 'table_merge' ? APP_DATA_LOOKUP_ATTEMPTS : 0);
  const onClassify = (c: AppStepCondition) => conditionRules(c).some((rule) => rule.field.startsWith('@'));
  // 갈래의 건너가기(2026-11-08) — 입력만 보고 정해지면 사이 단계를 빼고, 분류 결과에 갈리거나 그 단계가 돌지 모르면 사이 단계는 '많으면'에만
  let skipUntil = -1;
  const maybeSkipped = new Set<number>();
  // 되돌아가기(2026-11-25) — 되돌아가면 그 사이 단계를 다시 부른다. 한 실행에 합쳐 APP_LOOPS_PER_RUN번까지
  let loopsMin = APP_LOOPS_PER_RUN; let loopsMax = APP_LOOPS_PER_RUN;
  const callsAt = (i: number) => {
    const s = steps[i];
    return i === steps.length - 1 ? 1 : s.lookup ? 0 : s.research ? 1 : s.repeat ? (repeatsFiles(s.repeat) ? fileCount : repeatItems(inputs[s.repeat.field]).length) : 1;
  };
  steps.forEach((step, index) => {
    if (index < skipUntil) return;
    const last = index === steps.length - 1;
    const calls = callsAt(index);
    const web = webCallsAt(index);
    const data = dataCallsAt(index);
    // 웹 검색 조회는 AI를 부르므로 '공공 데이터 조회(AI 사용량 없음)'로 세지 않는다
    const lookup = !last && (step.research || (step.lookup && !web && !data)) ? 1 : 0;
    // 더 찾기(2026-11-09) — AI가 '없음'이라고 하면 덜 부르므로 '많으면'에만 센다
    // 조사 단계(2026-11-25) — 첫 라운드는 늘, 뒤 라운드는 AI가 '끝'이라고 하면 덜 부르므로 '많으면'에만
    const refines = !last && step.lookup?.refine ? step.lookup.refine : !last && step.research ? step.research.rounds - 1 : 0;
    let surely: boolean;
    if (!step.when || last) surely = !maybeSkipped.has(index) || last;
    else if (onClassify(step.when)) { max += calls + refines + web + data; webSearches += web; lookups += lookup; surely = false; markJumps(false); return; }
    else if (conditionHolds(step.when, inputs)) surely = !maybeSkipped.has(index);
    else return;
    if (surely) min += calls + (step.lookup && web ? 1 : 0) + (data ? 1 : 0);
    max += calls + refines + web + data; webSearches += web; lookups += lookup;
    markJumps(surely);

    function markJumps(runs: boolean) {
      if (last || !step.branches?.length) return;
      // 되돌아가는 갈래 — 입력만으로 정해져 늘 돌면 정한 횟수만큼 반드시, 분류 결과에 갈리면 '많으면'에만
      const fixed = runs && !step.branches.some((b) => onClassify(b.when));
      for (const b of step.branches) {
        const back = branchBackIndex(index, b, steps.length);
        if (back === null) continue;
        let span = 0;
        for (let i = back; i <= index; i++) span += callsAt(i);
        const sure = fixed && chooseBranch(step, inputs) === b;
        const roundsMax = Math.min(branchRounds(b), loopsMax);
        max += span * roundsMax; loopsMax -= roundsMax;
        if (sure) { const roundsMin = Math.min(branchRounds(b), loopsMin); min += span * roundsMin; loopsMin -= roundsMin; }
      }
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
  return { min, max, lookups, webSearches, mayDigest: fileCount > 0 };
}

/** 화면 한 줄 — '예상 AI 호출 3번' · '2~4번' · 조회·긴 첨부 안내 */
export function describeAppCalls(e: AppCallEstimate): string {
  const calls = e.min === e.max ? `${e.min}번` : `${e.min}~${e.max}번`;
  const parts = [`예상 AI 호출 ${calls}`];
  if (e.lookups) parts.push(`공공 데이터 조회 ${e.lookups}번(AI 사용량 없음)`);
  if (e.webSearches) parts.push(`웹 검색 조회는 많으면 ${e.webSearches}번(호출에 포함 · 검색 요금이 더 듭니다)`);
  if (e.mayDigest) parts.push('첨부가 길면 조각마다 추리는 호출이 더 듭니다');
  return parts.join(' · ');
}
