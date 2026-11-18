import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-18 — 비서 양식·나만의 비서 저장·앱 시험 판의 읽기 실패.
 * - 양식을 더할 때 지금 양식을 못 읽으면 빈 목록으로 보아 `template_ids`를 새 양식 하나로 덮어써 **있던 양식이 모두 비서에서 빠졌다**
 * - 나만의 비서 저장이 지금 값을 못 읽으면 모든 칸을 '바뀜'으로 저장했다(빈 판·틀린 변경 기록 — `/api/agents/[id]`는 0149에서 고침)
 * - 앱 시험 판 저장이 유형을 못 읽으면 외부 연결형에도 시험 판을 남길 수 있었고, 배포는 읽기 실패를 '시험 판이 바뀜'(409)으로 답했다
 */

type Call = { table: string; ops: Array<[string, unknown[]]> };
type Result = { data?: unknown; error: unknown };
const ERR = { code: 'XX000', message: 'boom' };

const state: {
  calls: Call[];
  templates: Result;
  current: Result;
  uploads: string[];
  saves: Array<{ agentId: string; base: number; patch: Record<string, unknown> }>;
} = { calls: [], templates: { data: [], error: null }, current: { data: null, error: null }, uploads: [], saves: [] };

const did = (c: Call, name: string) => c.ops.some(([n]) => n === name);

vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => ({ user: { id: 'u1', role: 'USER', departmentId: 'd1' } }) }));
vi.mock('@/lib/config', () => ({ SUPABASE_DOCUMENTS_BUCKET: 'documents' }));
vi.mock('@/lib/actor-scope', () => ({ getActorScope: async () => ({ userId: 'u1', departmentId: 'd1', organizationId: 'org1' }) }));
vi.mock('@/lib/agent-permissions', () => ({ canEditAgent: () => true, canDeleteAgent: () => true }));
vi.mock('@/lib/agent-store', () => ({
  loadAgentAccess: async () => ({ id: 'a1', tier: 'personal', version: 4, organization_id: 'org1', deleted_at: null, agent_type: 'chat' }),
  saveAgentSettings: async (agentId: string, base: number, patch: Record<string, unknown>) => { state.saves.push({ agentId, base, patch }); return { ok: true, version: base + 1 }; },
  saveFailureResponse: () => ({ status: 500, message: 'x' }),
  softDeleteAgent: async () => true,
}));
vi.mock('@/lib/agent-route-helpers', async () => {
  const { NextResponse } = await import('next/server');
  return {
    jsonError: (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status }),
    knownIds: () => ({ capabilityIds: [], connectorIds: [], modelIds: [] }),
    validateModelForOrganization: async () => null,
    checkCapabilityScope: async () => null,
  };
});
vi.mock('@/lib/agent-patch', () => ({
  parseBaseVersion: (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v)),
  splitAgentBody: (body: Record<string, unknown>) => ({ settings: { name: body.name }, operational: {} }),
  changedSettingKeys: (current: Record<string, unknown>, next: Record<string, unknown>) => Object.keys(next).filter((k) => current[k] !== next[k]),
  SNAPSHOT_KEYS: ['name', 'template_ids'],
}));
vi.mock('@/lib/template-files', () => ({
  validateTemplateFile: () => null,
  templateStoragePath: (_o: string, _a: string, id: string) => `templates/${id}`,
  MAX_TEMPLATES: 10,
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    storage: { from: () => ({ upload: async (path: string) => { state.uploads.push(path); return { error: null }; } }) },
    from: (table: string) => {
      const call: Call = { table, ops: [] };
      state.calls.push(call);
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'is', 'order', 'insert']) b[n] = (...args: unknown[]) => { call.ops.push([n, args]); return b; };
      const resolve = (): Result => (table === 'agent_templates' ? (did(call, 'insert') ? { error: null } : state.templates) : state.current);
      b.single = async () => resolve();
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(resolve()).then(res, rej);
      return b;
    },
  },
}));

import { GET as listTemplates, POST as addTemplate } from '@/app/api/agents/[id]/templates/route';
import { DELETE as removeTemplate } from '@/app/api/agents/[id]/templates/[templateId]/route';
import { PUT as savePersonal } from '@/app/api/agents/personal/[id]/route';

const form = () => {
  const f = new FormData();
  f.set('file', new File([new Uint8Array([1, 2, 3])], '양식.hwpx'));
  f.set('name', '결과보고서');
  f.set('base_version', '4');
  return { formData: async () => f } as never;
};
const out = async (res: Response) => ({ status: res.status, body: await res.json() });

beforeEach(() => {
  state.calls = [];
  state.uploads = [];
  state.saves = [];
  state.templates = { data: [{ id: 't-old1', name: '공문' }, { id: 't-old2', name: '회의록' }], error: null };
  state.current = { data: { name: '옛 이름' }, error: null };
});

describe('양식 더하기', () => {
  it('있던 양식을 지키고 새 양식을 더한다', async () => {
    const r = await out(await addTemplate(form(), { params: { id: 'a1' } }));
    expect(r.status).toBe(201);
    const ids = state.saves[0].patch.template_ids as string[];
    expect(ids.slice(0, 2)).toEqual(['t-old1', 't-old2']);
    expect(ids).toHaveLength(3);
  });

  it('지금 양식을 못 읽으면 파일을 올리지도 저장하지도 않는다(503) — 있던 양식이 빠지지 않게', async () => {
    state.templates = { data: null, error: ERR };
    const r = await out(await addTemplate(form(), { params: { id: 'a1' } }));
    expect(r.status).toBe(503);
    expect(state.uploads).toHaveLength(0);
    expect(state.saves).toHaveLength(0);
    expect(state.calls.some((c) => did(c, 'insert'))).toBe(false);
  });
});

describe('양식 목록·빼기', () => {
  it('목록을 못 읽으면 "양식 없음"이 아니라 503', async () => {
    state.templates = { data: null, error: ERR };
    expect((await out(await listTemplates({} as never, { params: { id: 'a1' } }))).status).toBe(503);
    state.templates = { data: [], error: null };
    const ok = await out(await listTemplates({} as never, { params: { id: 'a1' } }));
    expect(ok.body.data).toEqual({ version: 4, items: [] });
  });

  it('빼기 — 못 읽으면 "찾을 수 없음"(404)이 아니라 503, 읽으면 그 양식만 뺀다', async () => {
    const req = { url: 'https://app.test/api/agents/a1/templates/t-old1?base_version=4' } as never;
    state.templates = { data: null, error: ERR };
    expect((await out(await removeTemplate(req, { params: { id: 'a1', templateId: 't-old1' } }))).status).toBe(503);
    expect(state.saves).toHaveLength(0);

    state.templates = { data: [{ id: 't-old1', name: '공문' }, { id: 't-old2', name: '회의록' }], error: null };
    expect((await out(await removeTemplate(req, { params: { id: 'a1', templateId: 't-old1' } }))).status).toBe(200);
    expect(state.saves[0].patch.template_ids).toEqual(['t-old2']);
  });
});

describe('나만의 비서 저장', () => {
  const put = (body: unknown) => savePersonal({ json: async () => body } as never, { params: { id: 'a1' } });

  it('지금 값을 못 읽으면 저장하지 않는다(503)', async () => {
    state.current = { data: null, error: ERR };
    expect((await out(await put({ name: '옛 이름' }))).status).toBe(503);
    expect(state.saves).toHaveLength(0);
  });

  it('읽었으면 바뀐 칸만 저장하고, 바뀐 것이 없으면 저장하지 않는다', async () => {
    expect((await out(await put({ name: '옛 이름' }))).body.data).toEqual({ version: 4 });
    expect(state.saves).toHaveLength(0);
    await put({ name: '새 이름' });
    expect(state.saves[0].patch).toEqual({ name: '새 이름' });
  });
});

describe('앱 시험 판 — 원본 확인', () => {
  const src = readFileSync('src/app/api/agents/[id]/app-draft/route.ts', 'utf8');

  it('저장(PUT)은 유형을 못 읽으면 저장하지 않는다', () => {
    const put = src.slice(src.indexOf('export async function PUT'), src.indexOf('export async function POST'));
    expect(put).toContain("const { data: row, error: rowError } = await supabaseAdmin.from('agents').select('agent_type')");
    expect(put).toMatch(/if \(rowError \|\| !row\) return jsonError\([^)]*503\);/);
  });

  it('배포(POST)는 못 읽은 것을 "시험 판이 바뀜"(409)으로 답하지 않는다', () => {
    const post = src.slice(src.indexOf('export async function POST'), src.indexOf('export async function DELETE'));
    const readFail = post.indexOf('if (rowError || !row)');
    expect(readFail).toBeGreaterThan(-1);
    expect(readFail).toBeLessThan(post.indexOf('배포할 시험 판이 바뀌었거나 없습니다'));
  });
});
