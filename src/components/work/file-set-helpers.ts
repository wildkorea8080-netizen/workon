// 업무 입력 보이기 규칙 — 화면(업무 카드·새 작업·작업실 원자료)이 함께 쓰는 순수 함수. 아무것도 import하지 않는다.
// tests/work-currentize-ui.test.ts가 고정한다.

/**
 * 화면에 보일 업무 입력. 현행화하지 않는 업무(usesCurrentizeWhenPrior가 아님)는 '작년 파일'(file-set 'prior')을 뺀다 —
 * 올려도 실행기가 읽지 않으므로(sources.loadSourceExtracts가 작년 파일을 뺀다) 고를 수 있게 두면 직원이 현행화를 기대한다
 */
export function inputsFor<T extends { key: string; type: string }>(inputs: T[], currentizes: boolean): T[] {
  return currentizes ? inputs : inputs.filter((i) => !(i.type === 'file-set' && i.key === 'prior'));
}
