// src/lib/share-switch.ts
// 기관 전체 '대화 공개 링크' 스위치(0098, 2026-11-23) — 대화(부서)로 그 기관이 공개 공유를 막았는지 본다.
// 끄고 켜기는 기관 전체 관리자만(`setOrgSwitch('shares', …)` — webhook-switch.ts, 보안 로그 high).
// 막으면 새 링크를 만들지 못하고(403) 이미 만든 링크도 열리지 않는다(공개 조회 403). 링크·토큰은 지우지 않는다 — 다시 열면 그대로.
// 읽지 못하면 던진다 — 부르는 쪽이 503(닫힘: 로그인 없이 열리는 주소다).

import { supabaseAdmin } from '@/lib/supabaseAdmin';

export interface ShareSwitch {
  disabled: boolean;
  reason: string | null;
}

/** 직원에게 — 새 링크를 만들 수 없을 때 */
export function shareCreateBlockedMessage(reason: string | null): string {
  return `기관이 대화 공개 링크를 막아 두었습니다${reason ? `(사유: ${reason})` : ''}. 필요하면 기관 관리자에게 문의하세요.`;
}

/** 링크를 받은 사람에게 — 열 수 없을 때(사유는 싣지 않는다: 로그인 없이 보이는 글이다) */
export const SHARE_OPEN_BLOCKED_MESSAGE = '이 대화를 공유한 기관이 공개 링크를 막아 두어 지금은 열 수 없습니다.';

/** 이 부서가 속한 기관의 스위치. 부서·기관이 없으면 막지 않은 것으로(대화는 부서가 있어야 만들어진다). 못 읽으면 던진다 */
export async function shareSwitchForDepartment(departmentId: string | null | undefined): Promise<ShareSwitch> {
  if (!departmentId) return { disabled: false, reason: null };
  const { data, error } = await supabaseAdmin
    .from('departments')
    .select('organization:organizations(conversation_share_disabled_at, conversation_share_disabled_reason)')
    .eq('id', departmentId)
    .maybeSingle();
  if (error) throw new Error(`share switch: ${error.code ?? 'error'}`);
  type Org = { conversation_share_disabled_at: string | null; conversation_share_disabled_reason: string | null };
  const raw = (data as { organization?: Org | Org[] | null } | null)?.organization;
  const org = Array.isArray(raw) ? raw[0] : raw;
  const at = org?.conversation_share_disabled_at ?? null;
  return { disabled: Boolean(at), reason: at ? org?.conversation_share_disabled_reason ?? null : null };
}
