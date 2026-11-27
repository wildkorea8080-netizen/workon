// src/lib/public-ask/deps.ts
// 시민 상담 창(0136)의 실제 이음매 — 서비스 키 DB·NODA 찾기·모델. 읽기 실패는 던진다(라우트가 503 — 확인 못 하면 닫힘)
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { normalizeOrgSlug } from '@/lib/org-slug';
import { organizationBudgetStatus } from '@/lib/usage-limit';
import { filterUserInput } from '@/lib/filter';
import { prepareLikeChat } from '@/lib/capabilities/doc-search';
import { getAllowedModelIds, resolveModel } from '@/lib/model-policy';
import { streamChat } from '@/lib/llm';
import { buildUsageDetails, writeUsageLog } from '@/lib/assistant/persist';
import { logSystem } from '@/lib/logger';
import type { PublicAskDeps } from './service';

export function publicAskDeps(): PublicAskDeps {
  return {
    async loadOrg(slug) {
      const s = normalizeOrgSlug(slug);
      if (!s.ok) return null;
      const { data, error } = await supabaseAdmin.from('organizations').select('id, name, status, logo_url, theme_color').eq('slug', s.slug).maybeSingle();
      if (error) throw error;
      return data;
    },
    async loadSettings(orgId) {
      const { data, error } = await supabaseAdmin
        .from('public_ask_settings')
        .select('enabled, agent_id, notice, faq, contacts, allowed_origins, ip_daily_cap, org_daily_cap')
        .eq('organization_id', orgId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    async loadAgent(agentId) {
      const { data, error } = await supabaseAdmin
        .from('agents')
        .select('id, organization_id, department_id, tier, deleted_at, is_active, model_id, system_prompt')
        .eq('id', agentId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    async orgBudgetExhausted(orgId) {
      const status = await organizationBudgetStatus(orgId);
      return !!status && status.used >= status.limit;
    },
    async claim(orgId, ipHash, dayStart, ipCap, orgCap) {
      const { data, error } = await supabaseAdmin.rpc('public_ask_claim', { p_org: orgId, p_ip_hash: ipHash, p_day_start: dayStart, p_ip_cap: ipCap, p_org_cap: orgCap });
      if (error) throw error;
      const r = (data ?? {}) as { status?: string; id?: string };
      if (r.status !== 'ok' && r.status !== 'capped_ip' && r.status !== 'capped_org') throw new Error('public_ask_claim: unexpected');
      return { status: r.status, ...(r.id ? { id: r.id } : {}) };
    },
    async passesFilter(departmentId, text) {
      const result = await filterUserInput(departmentId, text, undefined, { failClosed: true });
      return result.isValid;
    },
    prepare: (agentId, orgId, query, previousQuestion) => prepareLikeChat({ agentId, organizationId: orgId, query, ...(previousQuestion ? { previousQuestion } : {}) }),
    async resolveModel(requested, orgId) {
      return resolveModel(requested, await getAllowedModelIds(orgId)).modelId;
    },
    stream: (req) => streamChat(req),
    async finishLog(id, patch) {
      const { error } = await supabaseAdmin.from('public_ask_logs').update(patch).eq('id', id);
      if (error) await logSystem({ level: 'warning', category: 'database', message: '시민 상담 기록을 마무리하지 못했습니다', details: { code: error.code ?? 'error', result: patch.result } });
    },
    logUsage: (departmentId, agentId, usage) => writeUsageLog({
      departmentId, userId: null, action: 'public_ask', resourceType: 'agent', resourceId: agentId,
      details: buildUsageDetails(usage, { agent_id: agentId }),
    }),
    now: () => Date.now(),
  };
}
