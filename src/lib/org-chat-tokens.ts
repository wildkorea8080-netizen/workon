import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { pagedRows } from '@/lib/paged-select';

/**
 * 기관의 '이번 달 토큰'을 한 규칙으로(2026-11-17). 종량제 월 토큰 한도 판정(`checkTokenLimit` → DB 함수 `organization_chat_tokens`, 0057)과
 * 같은 셈: **`chat_message`·`public_ask`(시민 상담, 0136) 기록의 입력+출력 토큰, 숫자가 아니면 0, 한국 시간 이번 달 1일부터**.
 *
 * 예전엔 화면마다 달랐다 — 슈퍼관리자 기관 목록은 DB 뷰 `v_organization_summary`(모든 활동·UTC 달)라 기관 상세(위 함수)와 숫자가 달랐고
 * (운영 '기본 기관' 10,820 vs 10,697), 대시보드는 같은 이번 달 기록을 세 번 따로 읽어 더했으며 숫자가 아닌 값은 그대로 더했다.
 */

/** 기록 한 줄의 토큰 — 숫자가 아니면 0(DB 함수와 같음) */
export function chatTokensOf(details: unknown): number {
  if (!details || typeof details !== 'object') return 0;
  const d = details as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return n(d.input_tokens) + n(d.output_tokens);
}

/** 그때부터의 `chat_message` 기록을 기관별로 더한다 — 못 읽으면 null */
export async function loadChatTokensByOrg(fromIso: string): Promise<Map<string, number> | null> {
  const { data, error } = await pagedRows<{ organization_id: string | null; details: unknown }>((a, b, w) => supabaseAdmin
    .from('usage_logs').select('organization_id, details', w ? { count: 'exact' } : undefined)
    .in('action', ['chat_message', 'public_ask']).gte('created_at', fromIso).order('id').range(a, b));
  if (error) return null;
  return sumByOrg(data ?? []);
}

export function sumByOrg(rows: Array<{ organization_id: string | null; details: unknown }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (!r.organization_id) continue;
    m.set(r.organization_id, (m.get(r.organization_id) ?? 0) + chatTokensOf(r.details));
  }
  return m;
}

/** 활성 기관의 월 토큰 한도 경고(80% 이상·100% 미만)·초과(100% 이상) 수 — 한도 0·없음은 무제한이라 세지 않는다 */
export function tokenLimitCounts(orgs: Array<{ id: string; monthly_token_limit: unknown }>, usage: Map<string, number>): { warnings: number; exceeded: number } {
  let warnings = 0;
  let exceeded = 0;
  for (const o of orgs) {
    const limit = Number(o.monthly_token_limit);
    if (!Number.isFinite(limit) || limit <= 0) continue;
    const used = usage.get(o.id) ?? 0;
    if (used >= limit) exceeded++;
    else if (used / limit >= 0.8) warnings++;
  }
  return { warnings, exceeded };
}

/** 이번 달 토큰 Top N — 기관 행이 없으면(지운 기관) 이름 '—', 한도 0·없음은 0% */
export function topTokenOrgs(ids: string[], usage: Map<string, number>, orgs: Array<{ id: string; name: string | null; monthly_token_limit: unknown }>) {
  return ids.map((id) => {
    const org = orgs.find((o) => o.id === id);
    const tokens = usage.get(id) ?? 0;
    const limit = Number(org?.monthly_token_limit);
    return { id, name: org?.name ?? '—', tokens, usagePct: Number.isFinite(limit) && limit > 0 ? Math.round(tokens / limit * 100) : 0 };
  });
}

/** 기관 몇 곳의 토큰을 DB 함수로(목록 한 쪽 — 100곳까지) — 못 읽은 기관은 값 없음 */
export async function orgChatTokens(orgIds: string[], fromIso: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await Promise.all(orgIds.map(async (id) => {
    const { data, error } = await supabaseAdmin.rpc('organization_chat_tokens', { p_organization_id: id, p_from: fromIso });
    if (!error && data !== null && data !== undefined && Number.isFinite(Number(data))) out.set(id, Number(data));
  }));
  return out;
}
