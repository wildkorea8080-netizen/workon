import { readFileSync, readdirSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-23 — 기관 전체 '대화 공개 링크' 스위치(0098).
 * 직원은 대화를 로그인 없이 열리는 링크로 공유할 수 있고 관리자는 하나씩 멈출 수 있었지만(2026-11-18),
 * 기관이 공개 공유 자체를 막을 길이 없었다. 이제 기관 전체 관리자가 막으면 새 링크를 만들지 못하고(403)
 * 이미 만든 링크도 열리지 않는다(403). 링크는 지우지 않아 다시 열면 그대로. 스위치를 못 읽으면 닫는다(503).
 */

type Call = { table: string; ops: Array<[string, unknown[]]> };
type Result = { data?: unknown; error: unknown };
const ERR = { code: 'XX000', message: 'boom' };

const state: {
  session: unknown;
  actor: unknown;
  calls: Call[];
  conversation: Result;
  updated: Result;
  owner: Result;
  department: Result;
  orgUpdate: Result;
  logs: Array<{ dept: unknown; user: unknown; type: string; details: Record<string, unknown>; severity: string }>;
} = {
  session: null, actor: null, calls: [], conversation: { data: null, error: null }, updated: { data: [{ id: 'c1' }], error: null },
  owner: { data: null, error: null }, department: { data: null, error: null }, orgUpdate: { data: [{ id: 'o1' }], error: null }, logs: [],
};

const did = (c: Call, name: string) => c.ops.some(([n]) => n === name);
const arg = (c: Call, name: string) => c.ops.find(([n]) => n === name)?.[1];

function resolve(c: Call): Result {
  if (c.table === 'users') return state.owner;
  if (c.table === 'departments') return state.department;
  if (c.table === 'organizations') return state.orgUpdate;
  if (did(c, 'update')) return state.updated;
  return state.conversation;
}

vi.mock('@/lib/auth', () => ({
  getServerAuthSession: async () => state.session,
  isAdminSession: (s: { user?: { role?: string } } | null) => s?.user?.role === 'ADMIN',
}));
vi.mock('@/lib/config', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), APP_URL: 'https://app.test' }));
vi.mock('@/lib/actor-scope-response', () => ({ actorScopeOr503: async () => state.actor }));
vi.mock('@/lib/security-log', () => ({
  logSecurityEvent: async (dept: unknown, user: unknown, type: string, details: Record<string, unknown>, severity: string) => {
    state.logs.push({ dept, user, type, details, severity });
    return true;
  },
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const call: Call = { table, ops: [] };
      state.calls.push(call);
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'order', 'update', 'is', 'not']) b[n] = (...args: unknown[]) => { call.ops.push([n, args]); return b; };
      b.single = async () => resolve(call);
      b.maybeSingle = async () => resolve(call);
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(resolve(call)).then(res, rej);
      return b;
    },
  },
}));

import { POST } from '@/app/api/conversations/[id]/share/route';
import { GET as viewShared } from '@/app/api/shared/[token]/route';
import { PUT as putSwitch } from '@/app/api/admin/shared-conversations/switch/route';
import { SHARE_OPEN_BLOCKED_MESSAGE, shareCreateBlockedMessage, shareSwitchForDepartment } from '@/lib/share-switch';
import { SECURITY_EVENT_LABELS } from '@/lib/security-event-text';
import { API_ROUTES } from '@/lib/api-route-ids';

const OPEN: Result = { data: { organization: { conversation_share_disabled_at: null, conversation_share_disabled_reason: null } }, error: null };
const BLOCKED: Result = { data: { organization: { conversation_share_disabled_at: '2026-11-23T01:00:00.000Z', conversation_share_disabled_reason: '외부 공개 금지 지침' } }, error: null };

const share = async () => {
  const res = await POST({} as never, { params: { id: 'c1' } });
  return { status: res.status, body: await res.json() };
};
const view = async () => {
  const res = await viewShared({} as never, { params: { token: 'tok' } });
  return { status: res.status, body: await res.json() };
};
const toggle = async (body: unknown) => {
  const req = { json: async () => body } as never;
  const res = await putSwitch(req);
  return { status: res.status, body: await res.json() };
};
const conversationUpdates = () => state.calls.filter((c) => c.table === 'conversations' && did(c, 'update'));

beforeEach(() => {
  state.session = { user: { id: 'u1', role: 'USER', departmentId: 'd1' } };
  state.actor = null;
  state.calls = [];
  state.logs = [];
  state.conversation = { data: { id: 'c1', share_token: null, is_shared: false, department_id: 'd1', metadata: {} }, error: null };
  state.updated = { data: [{ id: 'c1' }], error: null };
  state.owner = { data: { is_active: true, deleted_at: null }, error: null };
  state.department = OPEN;
  state.orgUpdate = { data: [{ id: 'o1' }], error: null };
});

describe('스위치 읽기(shareSwitchForDepartment)', () => {
  it('막힘·열림·사유, 부서가 없으면 열림, 못 읽으면 던진다', async () => {
    state.department = BLOCKED;
    expect(await shareSwitchForDepartment('d1')).toEqual({ disabled: true, reason: '외부 공개 금지 지침' });
    state.department = OPEN;
    expect(await shareSwitchForDepartment('d1')).toEqual({ disabled: false, reason: null });
    state.department = { data: { organization: [{ conversation_share_disabled_at: '2026-11-23T01:00:00.000Z', conversation_share_disabled_reason: null }] }, error: null };
    expect(await shareSwitchForDepartment('d1')).toEqual({ disabled: true, reason: null });
    state.calls = [];
    expect(await shareSwitchForDepartment(null)).toEqual({ disabled: false, reason: null });
    expect(state.calls).toHaveLength(0);
    state.department = { data: null, error: ERR };
    await expect(shareSwitchForDepartment('d1')).rejects.toThrow();
  });

  it('직원 안내에는 사유를, 링크를 받은 사람의 안내에는 사유를 싣지 않는다', () => {
    expect(shareCreateBlockedMessage('외부 공개 금지 지침')).toContain('외부 공개 금지 지침');
    expect(shareCreateBlockedMessage(null)).not.toContain('사유');
    expect(SHARE_OPEN_BLOCKED_MESSAGE).not.toContain('사유');
  });
});

describe('공유 만들기', () => {
  it('기관이 막았으면 403 share_disabled(사유 포함) — 링크를 만들지도 기록하지도 않는다', async () => {
    state.department = BLOCKED;
    const out = await share();
    expect(out.status).toBe(403);
    expect(out.body.error.code).toBe('share_disabled');
    expect(out.body.error.message).toContain('외부 공개 금지 지침');
    expect(conversationUpdates()).toHaveLength(0);
    expect(state.logs).toHaveLength(0);
  });

  it('이미 공유 중인 대화도 범위를 늘리지 않는다', async () => {
    state.department = BLOCKED;
    state.conversation = { data: { id: 'c1', share_token: 'abcDEF123456', is_shared: true, department_id: 'd1', metadata: { shared_at: '2026-11-01T00:00:00.000Z' } }, error: null };
    expect((await share()).status).toBe(403);
    expect(conversationUpdates()).toHaveLength(0);
  });

  it('스위치를 못 읽으면 만들지 않고 503(닫힘)', async () => {
    state.department = { data: null, error: ERR };
    expect((await share()).status).toBe(503);
    expect(conversationUpdates()).toHaveLength(0);
  });

  it('열려 있으면 그대로 만든다', async () => {
    const out = await share();
    expect(out.status).toBe(200);
    expect(conversationUpdates()).toHaveLength(1);
    expect(state.logs[0]).toMatchObject({ type: 'conversation_shared' });
  });
});

describe('공개 링크 열기', () => {
  beforeEach(() => {
    state.conversation = {
      data: { id: 'c1', title: '제목', created_at: '2026-11-18T00:00:00.000Z', user_id: 'u1', department_id: 'd1', metadata: null, agent: null, messages: [] },
      error: null,
    };
  });

  it('기관이 막았으면 403 — 사유는 싣지 않는다(로그인 없이 보이는 글)', async () => {
    state.department = BLOCKED;
    const out = await view();
    expect(out.status).toBe(403);
    expect(out.body.error).toEqual({ message: SHARE_OPEN_BLOCKED_MESSAGE, code: 'share_disabled' });
    expect(JSON.stringify(out.body)).not.toContain('외부 공개 금지 지침');
    expect(out.body.data).toBeUndefined();
  });

  it('스위치를 못 읽으면 열지 않고 503', async () => {
    state.department = { data: null, error: ERR };
    const out = await view();
    expect(out.status).toBe(503);
    expect(out.body.data).toBeUndefined();
  });

  it('열려 있으면 그대로 연다', async () => {
    const out = await view();
    expect(out.status).toBe(200);
    expect(out.body.data.id).toBe('c1');
  });
});

describe('막기·다시 열기(PUT /api/admin/shared-conversations/switch)', () => {
  const WHOLE = { organizationId: 'o1', departmentId: 'd1', isAdmin: true, managesWholeOrganization: true };

  it('로그인 401 · 관리자 아님 403 · 깨진 몸·짧은 사유 400 — 아무것도 바꾸지 않는다', async () => {
    state.session = null;
    expect((await toggle({ enabled: false, reason: '외부 공개 금지 지침' })).status).toBe(401);
    state.session = { user: { id: 'u1', role: 'USER', departmentId: 'd1' } };
    expect((await toggle({ enabled: false, reason: '외부 공개 금지 지침' })).status).toBe(403);
    state.session = { user: { id: 'a1', role: 'ADMIN', departmentId: 'd1' } };
    state.actor = WHOLE;
    expect((await toggle(null)).status).toBe(400);
    expect((await toggle({ enabled: 'no', reason: '외부 공개 금지 지침' })).status).toBe(400);
    expect((await toggle({ enabled: false, reason: '짧음' })).status).toBe(400);
    expect(state.calls.filter((c) => c.table === 'organizations')).toHaveLength(0);
    expect(state.logs).toHaveLength(0);
  });

  it('하위 부서 관리자는 403', async () => {
    state.session = { user: { id: 'a1', role: 'ADMIN', departmentId: 'd2' } };
    state.actor = { ...WHOLE, managesWholeOrganization: false };
    expect((await toggle({ enabled: false, reason: '외부 공개 금지 지침' })).status).toBe(403);
    expect(state.calls.filter((c) => c.table === 'organizations')).toHaveLength(0);
  });

  it('막으면 막은 때·사유를 저장하고 보안 로그(high)', async () => {
    state.session = { user: { id: 'a1', role: 'ADMIN', departmentId: 'd1' } };
    state.actor = WHOLE;
    const out = await toggle({ enabled: false, reason: '외부 공개 금지 지침' });
    expect(out.status).toBe(200);
    const up = state.calls.find((c) => c.table === 'organizations' && did(c, 'update'))!;
    const patch = (arg(up, 'update') as [Record<string, unknown>])[0];
    expect(patch.conversation_share_disabled_reason).toBe('외부 공개 금지 지침');
    expect(typeof patch.conversation_share_disabled_at).toBe('string');
    expect(state.logs[0]).toMatchObject({ type: 'conversation_share_org_disabled', severity: 'high' });
  });

  it('다시 열면 두 칸을 비우고 기록', async () => {
    state.session = { user: { id: 'a1', role: 'ADMIN', departmentId: 'd1' } };
    state.actor = WHOLE;
    expect((await toggle({ enabled: true, reason: '지침 해제로 다시 엶' })).status).toBe(200);
    const up = state.calls.find((c) => c.table === 'organizations' && did(c, 'update'))!;
    expect((arg(up, 'update') as [Record<string, unknown>])[0]).toEqual({ conversation_share_disabled_at: null, conversation_share_disabled_reason: null });
    expect(state.logs[0]).toMatchObject({ type: 'conversation_share_org_enabled', severity: 'high' });
  });
});

describe('붙인 곳', () => {
  it('마이그레이션 0098 — 두 칸과 짝 CHECK, 여러 번 적용해도 안전', () => {
    const files = readdirSync('supabase/migrations').filter((f) => f.startsWith('0098_'));
    expect(files).toEqual(['0098_org_share_switch.sql']);
    const sql = readFileSync('supabase/migrations/0098_org_share_switch.sql', 'utf8');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS conversation_share_disabled_at timestamptz/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS conversation_share_disabled_reason text/);
    expect(sql).toMatch(/organizations_conversation_share_switch_check/);
  });

  it('보안 로그 이름표·주소 목록', () => {
    expect(SECURITY_EVENT_LABELS.conversation_share_org_disabled).toBeTruthy();
    expect(SECURITY_EVENT_LABELS.conversation_share_org_enabled).toBeTruthy();
    expect(API_ROUTES).toContain('admin/shared-conversations/switch');
  });

  it('관리자 화면은 스위치를 못 읽은 것을 \'열림\'으로 보이지 않고, 사이드바는 서버 안내를 보인다', () => {
    const panel = readFileSync('src/components/admin/SharedLinksPanel.tsx', 'utf8');
    expect(panel).toContain("'/api/admin/shared-conversations/switch'");
    expect(panel).toMatch(/shareSwitch === null &&/);
    expect(panel).toContain('setShareSwitch(null)');
    const route = readFileSync('src/app/api/admin/shared-conversations/route.ts', 'utf8');
    expect(route).toMatch(/readOrgSwitch\('shares'/);
    const sidebar = readFileSync('src/components/layout/Sidebar.tsx', 'utf8');
    expect(sidebar).toContain("serverErrorText(result, '공유 링크 생성에 실패했습니다.')");
    expect(sidebar).not.toMatch(/catch \{\s*showToast\('공유 링크 생성에 실패했습니다\.'\)/);
  });
});
