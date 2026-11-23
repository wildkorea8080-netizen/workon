// src/lib/confirmed-post.ts
// 화면이 '서버가 실제로 했는지' 확인하고 다음으로 넘어가게 하는 POST — 아무것도 import하지 않는다(화면 공용 잎 파일).
//
// 2026-11-20: 대리 접근 복귀·슈퍼관리자 로그아웃·공지 읽음이 응답을 보지 않고 넘어갔다. 복귀가 실패해도 슈퍼관리자 화면으로
// 이동해, 그 기관 관리자 로그인(쿠키)이 남아 있는데 끝난 줄 알았다. 연결이 끊겨도(던짐) 거짓으로 답한다 — 던지지 않는다.

type FetchLike = (input: string, init?: { method?: string }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** 서버가 2xx이고 몸이 `{ ok: false }`가 아닐 때만 참. 그 밖(4xx·5xx·연결 실패)은 거짓 */
export async function confirmedPost(url: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<boolean> {
  try {
    const res = await fetchImpl(url, { method: 'POST' });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    return !(body && typeof body === 'object' && (body as { ok?: unknown }).ok === false);
  } catch {
    return false;
  }
}

export const IMPERSONATION_END_FAILED = '대리 접근을 끝내지 못했습니다. 이 브라우저는 아직 이 기관 관리자로 로그인돼 있습니다 — 다시 눌러 주세요.';
export const SUPER_LOGOUT_FAILED = '로그아웃하지 못했습니다. 아직 로그인된 상태입니다 — 다시 눌러 주세요.';
