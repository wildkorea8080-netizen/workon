// src/lib/latest-request.ts
// 마지막 요청의 응답만 화면에 쓰게 하는 번호표 — 아무것도 import하지 않는다(화면 공용 잎 파일).
//
// 2026-11-23: 거르기·찾기·쪽·기간을 바꿀 때마다 다시 읽는 화면 여덟(슈퍼관리자 로그 네 탭·기관 목록·기관 상세 사용자 찾기·
// 사용량, 관리자 답변 평가)이 앞 요청의 응답이 늦게 오면 그것으로 목록·숫자를 덮었다 — 찾기 칸에 '총무'를 치면 '총'의
// 결과가 마지막에 와 남는 식. 다시 읽기마다 begin()으로 번호를 받고, 응답을 쓰기 전에 isLatest(번호)를 본다.
//
// 화면에서는 `const gate = useRef(latestGate());` → `const ticket = gate.current.begin();` → 응답 뒤
// `if (!gate.current.isLatest(ticket)) return;`(진행 표시도 마지막 요청만 끈다).

export interface LatestGate {
  /** 새 요청의 번호 — 앞 번호는 모두 낡은 것이 된다 */
  begin(): number;
  /** 이 번호가 아직 마지막 요청인가 */
  isLatest(ticket: number): boolean;
}

export function latestGate(): LatestGate {
  let last = 0;
  return {
    begin: () => ++last,
    isLatest: (ticket) => ticket === last,
  };
}
