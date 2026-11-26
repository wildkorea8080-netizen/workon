// tests/batch-0329.test.ts
// 입력형 앱 실행 전 '많으면 쓸 금액'(2026-11-26, 마이그레이션 없음) — 사용량 예약(0122)과 같은 규칙으로 서버가 어림한다.
import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ session: true, agent: null as unknown, agentError: null as unknown, allowed: ['claude-sonnet-4-6'] as string[] | null, actor: { userId: 'u1', organizationId: 'o1', departmentId: 'd1', isAdmin: false, visibleDepartmentIds: ['d1'], managedDepartmentIds: [], managesWholeOrganization: false } }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: () => { const b: Record<string, unknown> = {}; b.select = () => b; b.eq = () => b; b.maybeSingle = async () => ({ data: state.agent, error: state.agentError }); return b; } },
}));
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn(async () => {}) }));
vi.mock('@/lib/config', () => ({ USD_KRW_RATE: 1350 }));
vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => (state.session ? { user: { id: 'u1' } } : null) }));
vi.mock('@/lib/actor-scope-response', () => ({ actorScopeOr503: async () => state.actor }));
vi.mock('@/lib/model-policy', () => ({ readAllowedModelIds: async () => state.allowed, resolveModel: (m: string | null, allowed: string[]) => ({ modelId: m && allowed.includes(m) ? m : allowed[0], substituted: false }) }));

import { POST } from '@/app/api/apps/estimate/route';
import { estimateRunCostKrw } from '@/lib/usage-reservation';
import { appOutputInstruction, type AppDefinition } from '@/lib/apps/definition';
import { estimateAppCalls } from '@/lib/apps/call-estimate';
import { appCostNote } from '@/components/apps/AppCostEstimate';
import { API_ROUTES } from '@/lib/api-route-ids';

const AGENT = '44444444-4444-4444-8444-444444444444';
const definition: AppDefinition = { schemaVersion: 1, output: 'bullets', fields: [{ key: 'topic', label: '주제', type: 'text', required: true }], steps: [{ name: '정리', instruction: '정리하라' }, { name: '마무리', instruction: '다듬어라' }] } as AppDefinition;
const agentRow = (over: Record<string, unknown> = {}) => ({
  id: AGENT, tier: 'department', department_id: 'd1', organization_id: 'o1', visibility: 'organization', owner_id: null, created_by: 'x', is_active: true, is_published: true, deleted_at: null,
  approval_status: null, version: 3, approval_version: null, shared_user_ids: [], shared_editor_ids: [], shared_department_ids: [],
  system_prompt: '너는 공문 비서다.', model_id: 'claude-sonnet-4-6', app_definition: definition, agent_type: 'chat', ...over,
});
const call = (body: unknown) => POST(new Request('https://workon.test/api/apps/estimate', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => { state.session = true; state.agent = agentRow(); state.agentError = null; state.allowed = ['claude-sonnet-4-6']; });

describe('어림', () => {
  it('예약과 같은 규칙 — 호출 수·지시문·입력 글·모델', async () => {
    const res = await call({ agent_id: AGENT, app_inputs: { topic: '여비' }, files: 1 });
    expect(res.status).toBe(200);
    const body = await res.json();
    const calls = estimateAppCalls(definition, { topic: '여비' }, 1);
    expect(body.data.calls).toBe(calls.max);
    // 입력 글의 길이는 실행과 같은 renderAppInput 글 — 지시문·출력 지시보다 짧으면 금액이 조금 다를 뿐이라 범위로 본다
    const low = estimateRunCostKrw({ modelId: 'claude-sonnet-4-6', calls: calls.max, baseChars: '너는 공문 비서다.'.length + appOutputInstruction(definition).length });
    expect(body.data.maxKrw).toBeGreaterThanOrEqual(low);
    expect(body.data.maxKrw).toBeLessThan(low + 5);
    expect(body.data.modelId).toBe('claude-sonnet-4-6');
  });
  it('허용 밖 모델은 기관 모델로, 정책을 못 읽으면 503', async () => {
    state.agent = agentRow({ model_id: 'claude-opus-5' });
    expect((await (await call({ agent_id: AGENT, app_inputs: { topic: 'x' }, files: 0 })).json()).data.modelId).toBe('claude-sonnet-4-6');
    state.allowed = null;
    expect((await call({ agent_id: AGENT, app_inputs: { topic: 'x' }, files: 0 })).status).toBe(503);
  });
  it('거절 — 로그인 없음 401·쓸 수 없음/링크형 404·입력 틀림/파일 수 400·앱 못 읽음 503', async () => {
    state.session = false;
    expect((await call({ agent_id: AGENT, app_inputs: { topic: 'x' }, files: 0 })).status).toBe(401);
    state.session = true;
    state.agent = agentRow({ tier: 'personal', owner_id: 'someone', visibility: 'department' });
    expect((await call({ agent_id: AGENT, app_inputs: { topic: 'x' }, files: 0 })).status).toBe(404);
    state.agent = agentRow({ agent_type: 'link' });
    expect((await call({ agent_id: AGENT, app_inputs: {}, files: 0 })).status).toBe(404);
    state.agent = agentRow();
    expect((await call({ agent_id: AGENT, app_inputs: {}, files: 0 })).status).toBe(400);
    expect((await call({ agent_id: AGENT, app_inputs: { topic: 'x' }, files: 9 })).status).toBe(400);
    expect((await call({ agent_id: 'nope', app_inputs: { topic: 'x' }, files: 0 })).status).toBe(404);
    state.agentError = { code: 'x' };
    expect((await call({ agent_id: AGENT, app_inputs: { topic: 'x' }, files: 0 })).status).toBe(503);
  });
});

describe('화면', () => {
  it('금액 글·연결', () => {
    expect(appCostNote(1234.4)).toBe('많으면 약 1,234원(첨부·문서 내용 빼고 어림 — 첨부가 길면 더 듭니다)');
    expect(appCostNote(0.2)).toContain('약 1원');
    expect(API_ROUTES).toContain('apps/estimate');
    expect(readFileSync('src/app/apps/run/page.tsx', 'utf8')).toContain('{!draftSavedAt && <AppCostEstimate agentId={agent.id} values={values}');
    expect(readFileSync('src/components/apps/AppCostEstimate.tsx', 'utf8')).toContain('if (!gate.current.isLatest(ticket)) return;');
  });
});
