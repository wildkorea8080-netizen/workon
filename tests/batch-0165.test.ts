import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-18 — 공식 등록 신청(`POST /api/agents/personal/[id]/request-approval`)·반려(`POST /api/admin/agents/[id]/reject`).
 * - 반려는 어디에도 기록되지 않았다(사유 칸은 다시 신청하면 덮인다) — 승인은 단계 변경으로 변경 기록에 남는다
 * - 반려가 '아직 대기일 때만'이 아니라서, 대기 상태를 본 뒤 다른 관리자가 승인하면 공식이 된 비서의 상태를 '반려'로 덮었다
 * - 반려 응답이 비서 행 전체(지시문까지)를 돌려줬다
 */

type Call = { table: string; ops: Array<[string, unknown[]]> };
type Result = { data?: unknown; error: unknown };
const ERR = { code: 'XX000', message: 'boom' };

const AGENT = {
  id: 'a1', tier: 'personal', department_id: 'd1', created_by: 'u1', deleted_at: null,
  approval_status: 'pending', approval_version: 3, version: 3, visibility: 'department',
};

const state: {
  session: unknown;
  calls: Call[];
  agent: Record<string, unknown> | null;
  updated: Result;
  canApprove: boolean;
  canRequest: boolean;
  events: Array<{ agentId: string; kind: string; actor: unknown; detail: Record<string, unknown> }>;
} = { session: null, calls: [], agent: null, updated: { data: [], error: null }, canApprove: true, canRequest: true, events: [] };

vi.mock('@/lib/auth', () => ({
  getServerAuthSession: async () => state.session,
  isAdminSession: (s: { user?: { role?: string } } | null) => s?.user?.role === 'ADMIN',
}));
vi.mock('@/lib/actor-scope', () => ({
  getActorScope: async (s: { user?: { id?: string } } | null) => (s?.user?.id ? { userId: s.user.id, departmentId: 'd1', organizationId: 'org1' } : null),
}));
vi.mock('@/lib/agent-permissions', () => ({
  canApproveOfficial: () => state.canApprove,
  canRequestOfficial: () => state.canRequest,
}));
vi.mock('@/lib/agent-route-helpers', async () => {
  const { NextResponse } = await import('next/server');
  return { jsonError: (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status }) };
});
vi.mock('@/lib/agent-store', () => ({
  loadAgentAccess: async () => state.agent,
  recordAgentEvent: async (agentId: string, kind: string, actor: unknown, detail: Record<string, unknown>) => {
    state.events.push({ agentId, kind, actor, detail });
  },
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const call: Call = { table, ops: [] };
      state.calls.push(call);
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'is', 'update']) b[n] = (...args: unknown[]) => { call.ops.push([n, args]); return b; };
      b.single = async () => state.updated;
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(state.updated).then(res, rej);
      return b;
    },
  },
}));

import { POST as reject } from '@/app/api/admin/agents/[id]/reject/route';
import { POST as requestApproval } from '@/app/api/agents/personal/[id]/request-approval/route';
import { describeHistoryItem } from '@/lib/agent-form';

const has = (c: Call, name: string, ...args: unknown[]) => c.ops.some(([n, a]) => n === name && JSON.stringify(a) === JSON.stringify(args));
const arg = (c: Call, name: string) => c.ops.find(([n]) => n === name)?.[1];
const rejectWith = async (body: unknown) => {
  const res = await reject({ json: async () => body } as never, { params: { id: 'a1' } });
  return { status: res.status, body: await res.json() };
};
const requestWith = async (body: unknown) => {
  const res = await requestApproval({ json: async () => body } as never, { params: { id: 'a1' } });
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  state.session = { user: { id: 'admin1', role: 'ADMIN', departmentId: 'd1' } };
  state.calls = [];
  state.events = [];
  state.agent = { ...AGENT };
  state.updated = { data: [{ id: 'a1', approval_status: 'rejected', approval_note: '지시문 보완 필요' }], error: null };
  state.canApprove = true;
  state.canRequest = true;
});

describe('반려', () => {
  it('아직 승인 대기일 때만 반려로 바꾸고, 변경 기록에 누가·왜를 남긴다', async () => {
    const out = await rejectWith({ note: '  지시문 보완 필요  ' });
    expect(out.status).toBe(200);
    const update = state.calls[0];
    expect(update.table).toBe('agents');
    expect(arg(update, 'update')).toEqual([{ approval_status: 'rejected', approval_note: '지시문 보완 필요', approval_version: null, updated_by: 'admin1' }]);
    expect(has(update, 'eq', 'id', 'a1')).toBe(true);
    expect(has(update, 'eq', 'approval_status', 'pending')).toBe(true);
    expect(has(update, 'is', 'deleted_at', null)).toBe(true);
    expect(state.events).toEqual([{ agentId: 'a1', kind: 'tier', actor: 'admin1', detail: { event: 'official_rejected', note: '지시문 보완 필요', requested_version: 3 } }]);
  });

  it('응답은 필요한 칸만 — 행 전체(지시문)를 돌려주지 않는다', async () => {
    const out = await rejectWith({ note: '사유' });
    expect(arg(state.calls[0], 'select')).toEqual(['id, approval_status, approval_note']);
    expect(Object.keys(out.body.data).sort()).toEqual(['approval_note', 'approval_status', 'id']);
  });

  it('그 사이 다른 관리자가 처리했으면(바뀐 줄 없음) 409, 기록 없음', async () => {
    state.updated = { data: [], error: null };
    const out = await rejectWith({ note: '사유' });
    expect(out.status).toBe(409);
    expect(out.body.error.message).toContain('다른 관리자가 처리');
    expect(state.events).toHaveLength(0);
  });

  it('저장 실패면 500, 기록 없음', async () => {
    state.updated = { data: null, error: ERR };
    expect((await rejectWith({ note: '사유' })).status).toBe(500);
    expect(state.events).toHaveLength(0);
  });

  it('사유가 없거나 깨진 요청은 400, 사유는 500자까지', async () => {
    expect((await rejectWith({ note: '   ' })).status).toBe(400);
    expect((await rejectWith({ note: 12 })).status).toBe(400);
    const res = await reject({ json: async () => { throw new Error('bad'); } } as never, { params: { id: 'a1' } });
    expect(res.status).toBe(400);
    expect(state.calls).toHaveLength(0);

    await rejectWith({ note: '가'.repeat(600) });
    expect((arg(state.calls[0], 'update') as [{ approval_note: string }])[0].approval_note).toHaveLength(500);
  });

  it('대기가 아니면 409, 권한이 없으면 403, 지운 비서는 404 — 쓰지 않는다', async () => {
    state.agent = { ...AGENT, approval_status: 'approved' };
    expect((await rejectWith({ note: '사유' })).status).toBe(409);
    state.agent = { ...AGENT };
    state.canApprove = false;
    expect((await rejectWith({ note: '사유' })).status).toBe(403);
    state.canApprove = true;
    state.agent = { ...AGENT, deleted_at: '2026-11-01T00:00:00Z' };
    expect((await rejectWith({ note: '사유' })).status).toBe(404);
    expect(state.calls).toHaveLength(0);
    expect(state.events).toHaveLength(0);
  });
});

describe('공식 등록 신청', () => {
  beforeEach(() => {
    state.session = { user: { id: 'u1', role: 'USER', departmentId: 'd1' } };
    state.agent = { ...AGENT, approval_status: 'none', approval_version: null, version: 4 };
    state.updated = { data: [{ id: 'a1' }], error: null };
  });

  it('신청하면 변경 기록에 누가·어느 판을 남긴다', async () => {
    const out = await requestWith({ note: ' 전 직원이 쓰면 좋겠습니다 ' });
    expect(out.status).toBe(200);
    const update = state.calls[0];
    expect(arg(update, 'update')).toEqual([{ approval_status: 'pending', approval_note: '전 직원이 쓰면 좋겠습니다', approval_version: 4, approval_requested_by: 'u1' }]);
    expect(has(update, 'is', 'deleted_at', null)).toBe(true);
    expect(state.events).toEqual([{ agentId: 'a1', kind: 'tier', actor: 'u1', detail: { event: 'official_requested', requested_version: 4, note: '전 직원이 쓰면 좋겠습니다' } }]);
  });

  it('메모 없이도 신청되고 기록에는 메모 칸이 없다', async () => {
    await requestWith({});
    expect(state.events[0].detail).toEqual({ event: 'official_requested', requested_version: 4 });
  });

  it('그 사이 지워졌으면(바뀐 줄 없음) 성공으로 답하지 않는다(404), 저장 실패면 500 — 기록 없음', async () => {
    state.updated = { data: [], error: null };
    expect((await requestWith({})).status).toBe(404);
    state.updated = { data: null, error: ERR };
    expect((await requestWith({})).status).toBe(500);
    expect(state.events).toHaveLength(0);
  });

  it('이미 신청 중·권한 없음은 그대로 막는다', async () => {
    state.agent = { ...AGENT };
    expect((await requestWith({})).status).toBe(409);
    state.agent = { ...AGENT, approval_status: 'none' };
    state.canRequest = false;
    expect((await requestWith({})).status).toBe(403);
    expect(state.calls).toHaveLength(0);
  });
});

describe('변경 기록의 문장', () => {
  it('신청·반려를 읽을 말로, 단계가 바뀐 기록은 그대로', () => {
    expect(describeHistoryItem({ kind: 'tier', version: null, detail: { event: 'official_requested', requested_version: 4 } })).toBe('공식 등록을 신청함');
    expect(describeHistoryItem({ kind: 'tier', version: null, detail: { event: 'official_rejected', note: '지시문 보완 필요' } }))
      .toBe('공식 등록 신청이 반려됨 — 지시문 보완 필요');
    expect(describeHistoryItem({ kind: 'tier', version: null, detail: { event: 'official_rejected' } })).toBe('공식 등록 신청이 반려됨');
    expect(describeHistoryItem({ kind: 'tier', version: null, detail: { from: 'personal', to: 'official' } })).toContain('→');
  });
});
