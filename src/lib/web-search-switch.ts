// src/lib/web-search-switch.ts
// 기관 웹 검색 스위치(2026-11-26, 0124). 비서의 '웹 검색' 능력은 검색어를 기관 밖(Anthropic의 검색 제공자)으로 보내므로 기본은 꺼짐 —
// 기관 전체 관리자(최상위 부서 소속)가 사유(5~200자)와 함께 켜고 끈다. 바뀌면 보안 로그(high). 보기는 관리자 누구나.
// 대화는 턴마다 읽고(`webSearchEnabled`), 못 읽으면 꺼진 것으로 본다(닫힘 — 실패가 기관 밖으로 내보내는 길을 열면 안 된다).
import type { ActorScope } from '@/lib/agent-permissions';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSecurityEvent } from '@/lib/filter';

export type WebSearchSwitchState = { enabled: boolean; enabledAt: string | null; reason: string | null };
export type WebSearchSwitchView = WebSearchSwitchState & { canChange: boolean };

/** 기관의 스위치 — 읽지 못하면 던진다 */
export async function readWebSearchSwitch(organizationId: string): Promise<WebSearchSwitchState> {
  const { data, error } = await supabaseAdmin.from('organizations').select('web_search_enabled_at, web_search_enabled_reason').eq('id', organizationId).maybeSingle();
  if (error) throw new Error(`organizations web_search: ${error.code ?? error.message}`);
  const row = data as { web_search_enabled_at?: string | null; web_search_enabled_reason?: string | null } | null;
  const at = row?.web_search_enabled_at ?? null;
  return { enabled: Boolean(at), enabledAt: at, reason: at ? row?.web_search_enabled_reason ?? null : null };
}

/** 대화 턴 — 켜졌는가. 못 읽으면 거짓(닫힘)과 오류 */
export async function webSearchEnabled(organizationId: string): Promise<{ enabled: boolean; error?: string }> {
  try { return { enabled: (await readWebSearchSwitch(organizationId)).enabled }; } catch (error) {
    return { enabled: false, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' };
  }
}

export const webSearchSwitchView = (state: WebSearchSwitchState, actor: ActorScope): WebSearchSwitchView => ({
  ...state, canChange: Boolean(actor.isAdmin && actor.managesWholeOrganization),
});

export type WebSearchSwitchResult = { ok: true; data: WebSearchSwitchView } | { ok: false; status: number; message: string };

/** 켜기·끄기 — 조건부로 바꾸고 바뀌었을 때만 보안 로그. 켤 때의 사유는 저장해 화면에 보이고, 끌 때의 사유는 보안 로그에만 */
export async function setWebSearchSwitch(
  admin: { scope: ActorScope; userId: string; impersonating: boolean }, enabled: boolean, reason: string, nowMs: number,
): Promise<WebSearchSwitchResult> {
  const actor = admin.scope;
  if (!actor.organizationId) return { ok: false, status: 403, message: '기관 소속을 확인할 수 없습니다.' };
  if (!actor.isAdmin || !actor.managesWholeOrganization) return { ok: false, status: 403, message: '웹 검색은 기관 전체를 관리하는 관리자(최상위 부서 소속)만 켜고 끌 수 있습니다.' };
  const base = supabaseAdmin.from('organizations');
  const { data: changed, error } = enabled
    ? await base.update({ web_search_enabled_at: new Date(nowMs).toISOString(), web_search_enabled_reason: reason }).eq('id', actor.organizationId).is('web_search_enabled_at', null).select('id')
    : await base.update({ web_search_enabled_at: null, web_search_enabled_reason: null }).eq('id', actor.organizationId).not('web_search_enabled_at', 'is', null).select('id');
  if (error) return { ok: false, status: 503, message: enabled ? '웹 검색을 켜지 못했습니다.' : '웹 검색을 끄지 못했습니다.' };
  if (changed?.length) {
    await logSecurityEvent(actor.departmentId, admin.userId, enabled ? 'web_search_org_enabled' : 'web_search_org_disabled',
      { organization_id: actor.organizationId, reason, impersonating: admin.impersonating }, 'high');
  }
  try {
    return { ok: true, data: webSearchSwitchView(await readWebSearchSwitch(actor.organizationId), actor) };
  } catch {
    return { ok: false, status: 503, message: '웹 검색 설정을 다시 읽지 못했습니다.' };
  }
}
