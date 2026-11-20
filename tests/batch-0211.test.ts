import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-20 — 비서·앱 저장 뒤 다시 읽기를 못 하면 '성공·빈 값'으로 답하지 않는다.
 * `PATCH /api/agents/[id]`·`POST /api/agents/[id]/app-draft`(배포)는 저장한 뒤 행을 다시 읽어 돌려주는데, 그 읽기의 오류를 보지 않아
 * `{ ok: true, data: null }`이었다 — 앱 빌더는 `result.data.version`을 읽다 멈추고, 관리자 비서 목록은 그 비서를 빈 값으로 바꿔 깨졌다.
 * 이제 503 '저장(배포)했지만 다시 읽지 못했다 — 새로 고쳐 확인'(화면들은 실패 안내를 이미 보인다).
 */

const AGENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SAVED = '2026-11-04T12:00:00.000Z';
const form = { schemaVersion: 1, fields: [{ key: 'memo', label: '메모', type: 'text', required: true }], output: 'bullets' };

const state = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  updated: 0,
  rereadFails: false,
}));

vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => ({ user: { id: 'u1' } }) }));
vi.mock('@/lib/actor-scope', () => ({ getActorScope: async () => ({ userId: 'u1', departmentId: 'd1', organizationId: 'o1' }) }));
vi.mock('@/lib/agent-permissions', () => ({ canEditAgent: () => true }));
vi.mock('@/lib/agent-store', () => ({
  loadAgentAccess: async () => ({ id: AGENT, tier: 'department', version: 3, deleted_at: null }),
  saveAgentSettings: async () => ({ ok: true, version: 4 }),
  saveFailureResponse: () => ({ message: '저장 실패', status: 500 }),
}));
vi.mock('@/lib/agent-route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent-route-helpers')>();
  return { ...actual, knownIds: () => ({ knownConnectorIds: ['law'], knownModelIds: [] }), checkCapabilityScope: async () => null };
});
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn() }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from() {
      let op = 'select';
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.update = () => { op = 'update'; state.updated += 1; return q; };
      for (const m of ['eq', 'is']) q[m] = () => q;
      // 시험 판을 비운(update) 뒤의 다시 읽기만 실패시킨다
      q.single = async () => (state.rereadFails && state.updated > 0
        ? { data: null, error: { code: 'XX000' } }
        : { data: state.row, error: null });
      q.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(op === 'update' ? { data: [{ id: AGENT }], error: null } : { data: state.row, error: null }).then(resolve);
      return q;
    },
  },
}));

import { POST } from '@/app/api/agents/[id]/app-draft/route';

const params = { params: { id: AGENT } };
const publish = () => POST(new (require('next/server').NextRequest)(`http://x/api/agents/${AGENT}/app-draft`, {
  method: 'POST', body: JSON.stringify({ draft_saved_at: SAVED }), headers: { 'Content-Type': 'application/json' },
}), params);

beforeEach(() => {
  state.updated = 0;
  state.rereadFails = false;
  state.row = {
    version: 3, name: '옛 이름', description: '설명', category: '총무', system_prompt: '옛 지시', app_definition: form, capabilities: {},
    app_draft: { saved_at: SAVED, base_version: 3, settings: { name: '새 이름', description: '설명', category: '총무', system_prompt: '새 지시', app_definition: form, capabilities: {} } },
  };
});

describe('POST /api/agents/[id]/app-draft(배포)', () => {
  it('배포 뒤 다시 읽기를 못 하면 성공·빈 값이 아니라 503', async () => {
    state.rereadFails = true;
    const res = await publish();
    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toContain('배포했지만 바뀐 설정을 지금 다시 읽지 못했습니다');
  });
  it('읽으면 그 행을 돌려준다', async () => {
    const res = await publish();
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ name: '옛 이름' });
  });
});

describe('PATCH /api/agents/[id]', () => {
  it('저장 뒤 다시 읽기의 오류를 본다', () => {
    const src = readFileSync('src/app/api/agents/[id]/route.ts', 'utf8');
    expect(src).toContain("const { data: agentRow, error: savedRowError } = await supabaseAdmin.from('agents').select('*').eq('id', params.id).single();");
    expect(src).toContain("if (savedRowError || !agentRow) return jsonError('저장했지만 바뀐 설정을 지금 다시 읽지 못했습니다. 화면을 새로 고쳐 확인해 주세요.', 503);");
  });
});
