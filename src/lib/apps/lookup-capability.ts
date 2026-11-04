// src/lib/apps/lookup-capability.ts
// 앱 빌더가 저장할 때의 공공 데이터 능력(public_data) 커넥터 — 화면과 시험이 같은 규칙을 쓴다(순수).

/**
 * `current` = 앱에 지금 켜진 커넥터, `before` = 저장된 정의의 조회 단계가 쓰던 커넥터, `after` = 새 정의가 쓰는 커넥터.
 * 새 정의가 쓰는 것은 켜고, 예전 조회 단계 때문에 켰는데 이제 안 쓰는 것은 끈다. 조회와 상관없이 켜 둔 커넥터는 그대로 둔다.
 * 켜는 것이 직원 범위 안인지는 서버(agent-route-helpers의 범위 검사)가 다시 본다.
 */
export function lookupCapability(current: readonly string[], before: readonly string[], after: readonly string[]): string[] {
  const kept = current.filter(id => !before.includes(id) || after.includes(id));
  return [...new Set([...kept, ...after])];
}
