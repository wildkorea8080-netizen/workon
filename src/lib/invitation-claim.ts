import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * 초대 링크 쓰기(2026-11-12).
 *
 * - **초대받은 이메일로만**: 가입(`/api/signup`)은 요청 본문의 이메일로 계정을 만드는데 초대의 이메일과 맞춰 보지 않아,
 *   kim@기관 앞으로 보낸 (관리자) 초대 링크로 아무 이메일이나 가입할 수 있었다. 초대 목록에는 kim이 보이는데 실제 계정은 다른 사람이다.
 * - **한 번만**: '이미 사용됨' 확인과 사용 표시가 따로라, 거의 동시에 보낸 요청 둘이 한 초대로 계정 둘을 만들 수 있었다.
 *   이제 계정을 만들기 **전에** `accepted_at IS NULL`·만료 전인 초대를 조건부로 차지하고, 만들기가 실패하면 그 차지만 푼다.
 */

export function normalizeInviteEmail(email: unknown): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/** 초대의 이메일과 가입 이메일이 같은가(대소문자·앞뒤 공백 무시) */
export function invitationEmailMatches(invitationEmail: unknown, email: unknown): boolean {
  const a = normalizeInviteEmail(invitationEmail);
  return a !== '' && a === normalizeInviteEmail(email);
}

/** 초대를 쓴 것으로 차지한다 — 아직 안 썼고 만료 전일 때만. 차지했으면 그 시각, 아니면 null */
export async function claimInvitation(id: string, nowMs = Date.now()): Promise<string | null> {
  const at = new Date(nowMs).toISOString();
  const { data, error } = await supabaseAdmin
    .from('invitations')
    .update({ accepted_at: at })
    .eq('id', id)
    .is('accepted_at', null)
    .gt('expires_at', at)
    .select('id')
    .maybeSingle();
  if (error || !data) return null;
  return at;
}

/** 차지를 푼다 — 그 차지(같은 시각)일 때만. 던지지 않는다 */
export async function releaseInvitation(id: string, claimedAt: string): Promise<void> {
  try {
    await supabaseAdmin.from('invitations').update({ accepted_at: null }).eq('id', id).eq('accepted_at', claimedAt);
  } catch {
    // 풀지 못하면 그 초대는 쓴 것으로 남는다 — 관리자가 새 초대를 보낸다
  }
}
