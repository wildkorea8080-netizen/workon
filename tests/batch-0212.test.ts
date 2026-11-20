import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-20 — 읽기 실패를 '없음'으로 답하지 않기, 세 곳.
 * ① 비서 되돌리기(`POST /api/agents/[id]/revert`): 판 사본을 못 읽어도 '그 판을 찾을 수 없습니다'(404)였다 → 503.
 * ② 일괄 실행 만들기(`createBatch` — 직원 화면·외부 연동의 비동기 호출): 앱을 못 읽어도 '앱을 찾을 수 없습니다'(404)였다 —
 *    외부 시스템은 404를 '다시 해도 같음'으로 읽는다 → 503(다시 시도).
 * ③ 업무 '규정·지침 확인'의 법령 찾기: 기관 유형을 못 읽으면 지방자치단체도 자치법규를 찾지 않고 근거가 빠진 채 판정했다 → 던져 실행을 다시 시도.
 */

const state = vi.hoisted(() => ({ snapshotFails: false, agentError: null as unknown }));

vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => ({ user: { id: 'u1' } }) }));
vi.mock('@/lib/actor-scope', () => ({ getActorScope: async () => ({ userId: 'u1', departmentId: 'd1', organizationId: 'o1' }) }));
vi.mock('@/lib/agent-store', async (orig) => {
  const actual = await orig<typeof import('@/lib/agent-store')>();
  return {
    ...actual,
    loadAgentAccess: async () => ({ id: 'a1', tier: 'personal', version: 3, deleted_at: null }),
    getVersionSnapshot: async () => {
      if (state.snapshotFails) throw new actual.AgentReadError('XX000');
      return null;
    },
  };
});
vi.mock('@/lib/agent-permissions', async (orig) => ({ ...(await orig<typeof import('@/lib/agent-permissions')>()), canEditAgent: () => true }));
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn() }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: () => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'is', 'in']) b[n] = () => b;
      b.maybeSingle = async () => ({ data: null, error: state.agentError });
      return b;
    },
  },
}));

import { POST as revert } from '@/app/api/agents/[id]/revert/route';
import { createBatch } from '@/lib/apps/batches';

beforeEach(() => { state.snapshotFails = false; state.agentError = null; });

const AGENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const revertReq = () => revert(new (require('next/server').NextRequest)('http://x', {
  method: 'POST', body: JSON.stringify({ version: 1, base_version: 3 }), headers: { 'Content-Type': 'application/json' },
}), { params: { id: 'a1' } });

describe('비서 되돌리기', () => {
  it('판 사본을 못 읽으면 503', async () => {
    state.snapshotFails = true;
    const res = await revertReq();
    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toContain('그 판을 지금 읽지 못했습니다');
  });
  it('정말 없으면 404', async () => {
    expect((await revertReq()).status).toBe(404);
  });
});

describe('일괄 실행 만들기', () => {
  const actor = { userId: 'u1', departmentId: 'd1', organizationId: 'o1', isAdmin: false, visibleDepartmentIds: ['d1'], managedDepartmentIds: [], managesWholeOrganization: false } as never;
  it('앱을 못 읽으면 503(다시 시도)', async () => {
    state.agentError = { code: 'XX000' };
    expect(await createBatch(actor, { agent_id: AGENT, rows: [{ a: '1' }] })).toMatchObject({ ok: false, status: 503 });
  });
  it('정말 없으면 404', async () => {
    expect(await createBatch(actor, { agent_id: AGENT, rows: [{ a: '1' }] })).toMatchObject({ ok: false, status: 404 });
  });
});

describe('규정·지침 확인의 법령 찾기', () => {
  it('기관 유형을 못 읽으면 던진다(근거가 빠진 채 판정하지 않음)', () => {
    const src = readFileSync('src/lib/work/workflows/regulations/providers.ts', 'utf8');
    expect(src).toContain("const { data: org, error: orgError } = await supabaseAdmin.from('organizations').select('type')");
    expect(src.indexOf("if (orgError) throw new Error('organization type unavailable');")).toBeLessThan(src.indexOf("const isLocal"));
  });
});
