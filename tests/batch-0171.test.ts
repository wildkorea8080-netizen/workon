import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-18 — 대화 공개 공유(로그인 없이 보는 링크).
 * - 링크가 대화의 '지금'을 보여 줘, 공유한 뒤 이어 쓴 대화가 링크를 받은 사람에게 그대로 보였다 → 공유한 때까지만
 * - 로그인 없이 열리는 링크를 누가 언제 만들었는지 어디에도 남지 않았다 → 보안 로그
 * - 사용 중지·탈퇴한 계정이 만들어 둔 링크가 계속 열렸다 → 닫는다
 */

type Call = { table: string; ops: Array<[string, unknown[]]> };
type Result = { data?: unknown; error: unknown };
const ERR = { code: 'XX000', message: 'boom' };

const state: {
  session: unknown;
  calls: Call[];
  conversation: Result;
  updated: Result;
  owner: Result;
  logs: Array<{ dept: unknown; user: unknown; type: string; details: Record<string, unknown>; severity: string }>;
} = { session: null, calls: [], conversation: { data: null, error: null }, updated: { data: [{ id: 'c1' }], error: null }, owner: { data: null, error: null }, logs: [] };

const did = (c: Call, name: string) => c.ops.some(([n]) => n === name);
const arg = (c: Call, name: string) => c.ops.find(([n]) => n === name)?.[1];
const has = (c: Call, name: string, ...args: unknown[]) => c.ops.some(([n, a]) => n === name && JSON.stringify(a) === JSON.stringify(args));

function resolve(c: Call): Result {
  if (c.table === 'users') return state.owner;
  if (did(c, 'update')) return state.updated;
  return state.conversation;
}

vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => state.session }));
vi.mock('@/lib/config', () => ({ APP_URL: 'https://app.test' }));
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
      for (const n of ['select', 'eq', 'order', 'update']) b[n] = (...args: unknown[]) => { call.ops.push([n, args]); return b; };
      b.single = async () => resolve(call);
      b.maybeSingle = async () => resolve(call);
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(resolve(call)).then(res, rej);
      return b;
    },
  },
}));

import { DELETE, POST } from '@/app/api/conversations/[id]/share/route';
import { GET as viewShared } from '@/app/api/shared/[token]/route';
import { messagesUntil } from '@/lib/shared-conversation';
import { SECURITY_EVENT_LABELS, securityDetailParts } from '@/lib/security-event-text';

const share = async () => {
  const res = await POST({} as never, { params: { id: 'c1' } });
  return { status: res.status, body: await res.json() };
};
const unshare = async () => {
  const res = await DELETE({} as never, { params: { id: 'c1' } });
  return { status: res.status, body: await res.json() };
};
const view = async () => {
  const res = await viewShared({} as never, { params: { token: 'tok' } });
  return { status: res.status, body: await res.json() };
};
const updates = () => state.calls.filter((c) => did(c, 'update'));
const patchOf = (c: Call) => (arg(c, 'update') as [Record<string, unknown>])[0];

const MESSAGES = [
  { id: 'm1', role: 'user', content: '질문 1', created_at: '2026-11-18T01:00:00.000Z' },
  { id: 'm2', role: 'assistant', content: '답 1', created_at: '2026-11-18T01:00:00.000Z' },
  { id: 'm3', role: 'user', content: '공유 뒤 질문', created_at: '2026-11-18T03:00:00.000Z' },
  { id: 'm4', role: 'assistant', content: '공유 뒤 답', created_at: '2026-11-18T03:00:00.000Z' },
];

beforeEach(() => {
  state.session = { user: { id: 'u1', role: 'USER', departmentId: 'd1' } };
  state.calls = [];
  state.logs = [];
  state.conversation = { data: { id: 'c1', share_token: null, is_shared: false, department_id: 'd1', metadata: { app_schedule: { id: 's1' } } }, error: null };
  state.updated = { data: [{ id: 'c1' }], error: null };
  state.owner = { data: { is_active: true, deleted_at: null }, error: null };
});

describe('공유 시작', () => {
  it('공유한 때를 남기고(다른 메타는 그대로) 보안 로그에 — 대화 id만', async () => {
    const out = await share();
    expect(out.status).toBe(200);
    expect(out.body.data.shareUrl).toMatch(/^https:\/\/app\.test\/shared\/[\w-]{12}$/);
    expect(out.body.data.updated).toBe(false);
    const patch = patchOf(updates()[0]);
    expect(patch.is_shared).toBe(true);
    expect(patch.metadata).toMatchObject({ app_schedule: { id: 's1' }, shared_at: out.body.data.sharedAt });
    expect(Number.isFinite(Date.parse(out.body.data.sharedAt))).toBe(true);
    expect(has(updates()[0], 'eq', 'user_id', 'u1')).toBe(true);
    expect(state.logs).toEqual([{ dept: 'd1', user: 'u1', type: 'conversation_shared', severity: 'medium', details: { conversation_id: 'c1' } }]);
  });

  it('이미 공유 중이면 같은 주소로, 범위만 지금까지로 갱신(low로 기록)', async () => {
    state.conversation = { data: { id: 'c1', share_token: 'abcDEF123456', is_shared: true, department_id: 'd1', metadata: { shared_at: '2026-11-01T00:00:00.000Z' } }, error: null };
    const out = await share();
    expect(out.body.data.token).toBe('abcDEF123456');
    expect(out.body.data.updated).toBe(true);
    expect((patchOf(updates()[0]).metadata as { shared_at: string }).shared_at).not.toBe('2026-11-01T00:00:00.000Z');
    expect(state.logs[0]).toMatchObject({ type: 'conversation_shared', severity: 'low', details: { conversation_id: 'c1', share_updated: true } });
  });

  it('남의 대화·없는 대화는 404, 못 읽으면 500 — 쓰지 않고 기록도 없다', async () => {
    state.conversation = { data: null, error: null };
    expect((await share()).status).toBe(404);
    state.conversation = { data: null, error: ERR };
    expect((await share()).status).toBe(500);
    expect(updates()).toHaveLength(0);
    expect(state.logs).toHaveLength(0);
  });

  it('저장하지 못했거나 그 사이 지워졌으면 기록하지 않는다', async () => {
    state.updated = { data: null, error: ERR };
    expect((await share()).status).toBe(500);
    state.updated = { data: [], error: null };
    expect((await share()).status).toBe(404);
    expect(state.logs).toHaveLength(0);
  });

  it('로그인하지 않았으면 401', async () => {
    state.session = null;
    expect((await share()).status).toBe(401);
    expect((await unshare()).status).toBe(401);
    expect(state.calls).toHaveLength(0);
  });
});

describe('공유 중단', () => {
  it('주소와 공유한 때를 버리고(다른 메타는 그대로) 기록한다', async () => {
    state.conversation = { data: { id: 'c1', is_shared: true, department_id: 'd1', metadata: { shared_at: '2026-11-01T00:00:00.000Z', app_schedule: { id: 's1' } } }, error: null };
    const out = await unshare();
    expect(out.status).toBe(200);
    expect(patchOf(updates()[0])).toEqual({ is_shared: false, share_token: null, metadata: { app_schedule: { id: 's1' } } });
    expect(has(updates()[0], 'eq', 'user_id', 'u1')).toBe(true);
    expect(state.logs).toEqual([{ dept: 'd1', user: 'u1', type: 'conversation_unshared', severity: 'low', details: { conversation_id: 'c1' } }]);
  });

  it('공유 중이 아니던 대화는 기록하지 않는다', async () => {
    await unshare();
    expect(state.logs).toHaveLength(0);
  });
});

describe('공개 조회 — 로그인 없이', () => {
  const shared = (over: Record<string, unknown> = {}) => ({
    data: { id: 'c1', title: '출장 여비', created_at: '2026-11-18T00:00:00.000Z', is_shared: true, user_id: 'u1', metadata: { shared_at: '2026-11-18T02:00:00.000Z' }, agent: { id: 'a1', name: '규정 비서', description: null }, messages: MESSAGES, ...over },
    error: null,
  });

  it('공유한 때까지의 대화만 보인다 — 이후에 이어 쓴 대화는 없다', async () => {
    state.conversation = shared();
    const out = await view();
    expect(out.status).toBe(200);
    expect(out.body.data.messages.map((m: { id: string }) => m.id)).toEqual(['m1', 'm2']);
    expect(JSON.stringify(out.body)).not.toContain('공유 뒤');
  });

  it('응답은 정해 둔 칸만 — 주인 id·메타는 싣지 않는다', async () => {
    state.conversation = shared();
    const out = await view();
    expect(Object.keys(out.body.data).sort()).toEqual(['agent', 'created_at', 'id', 'messages', 'title']);
    expect(JSON.stringify(out.body)).not.toContain('u1');
    expect(JSON.stringify(out.body)).not.toContain('shared_at');
  });

  it('공유한 때가 없는 옛 공유는 예전처럼 전부 보인다', async () => {
    state.conversation = shared({ metadata: {} });
    expect((await view()).body.data.messages).toHaveLength(4);
  });

  it('주인의 계정이 사용 중지·탈퇴면 열지 않는다, 주인을 확인하지 못해도 열지 않는다', async () => {
    state.conversation = shared();
    state.owner = { data: { is_active: false, deleted_at: null }, error: null };
    expect((await view()).status).toBe(404);
    state.owner = { data: { is_active: true, deleted_at: '2026-11-10T00:00:00Z' }, error: null };
    expect((await view()).status).toBe(404);
    state.owner = { data: null, error: null };
    expect((await view()).status).toBe(404);
    state.owner = { data: null, error: ERR };
    expect((await view()).status).toBe(404);
    state.conversation = shared({ user_id: null });
    state.owner = { data: { is_active: true, deleted_at: null }, error: null };
    expect((await view()).status).toBe(404);
  });

  it('토큰이 맞지 않으면 404', async () => {
    state.conversation = { data: null, error: { code: 'PGRST116' } };
    expect((await view()).status).toBe(404);
    expect(state.calls.some((c) => c.table === 'users')).toBe(false);
  });
});

describe('messagesUntil', () => {
  it('같은 시각(한 턴의 질문·답)은 함께 들어간다', () => {
    expect(messagesUntil(MESSAGES, '2026-11-18T01:00:00.000Z').map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(messagesUntil(MESSAGES, '2026-11-18T00:59:59.999Z')).toEqual([]);
    expect(messagesUntil(MESSAGES, '2026-11-18T03:00:00.000Z')).toHaveLength(4);
  });

  it('공유한 때가 없거나 날짜가 아니면 전부', () => {
    expect(messagesUntil(MESSAGES, undefined)).toHaveLength(4);
    expect(messagesUntil(MESSAGES, 'not-a-date')).toHaveLength(4);
    expect(messagesUntil(MESSAGES, 12345)).toHaveLength(4);
  });
});

describe('이름표·화면', () => {
  it('보안 사건 이름표와 상세', () => {
    expect(SECURITY_EVENT_LABELS.conversation_shared).toBe('대화 공개 링크 만들기(직원)');
    expect(SECURITY_EVENT_LABELS.conversation_unshared).toBe('대화 공개 링크 중단(직원)');
    expect(securityDetailParts({ conversation_id: 'c1', share_updated: true }, () => null)).toEqual(['공유 범위를 지금까지로 갱신']);
    expect(securityDetailParts({ conversation_id: 'c1' }, () => null)).toEqual([]);
  });

  it('사이드바는 지금까지의 대화만 보인다는 것을 알린다', () => {
    const sidebar = readFileSync('src/components/layout/Sidebar.tsx', 'utf8');
    expect(sidebar).toContain('지금까지의 대화만 보입니다');
    expect(sidebar).toContain('지금까지의 대화로 갱신했습니다');
  });

  it('공개 조회 라우트는 도우미를 내보내지 않는다(빌드가 깨진다)', () => {
    const view = readFileSync('src/app/api/shared/[token]/route.ts', 'utf8');
    expect(view).not.toContain('export function');
    expect(view).toContain("from '@/lib/shared-conversation'");
  });
});
