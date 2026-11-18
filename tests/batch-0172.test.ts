import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-18 — 기관 관리자가 **공개 링크로 공유 중인 대화**를 보고 멈춘다(`/api/admin/shared-conversations`).
 * 직원이 만든 공개 링크(로그인 없이 열림)를 기관이 알 방법도 멈출 방법도 없었다.
 * 관리자는 누가·언제 공유했는지만 본다 — 제목·내용·링크 주소는 내보내지 않는다.
 */

type Call = { table: string; ops: Array<[string, unknown[]]> };
type Result = { data?: unknown; error: unknown };
const ERR = { code: 'XX000', message: 'boom' };
const C1 = '11111111-1111-4111-8111-111111111111';

const state: {
  session: unknown;
  calls: Call[];
  listed: Result;
  users: Result;
  depts: Result;
  target: Result;
  stopped: Result;
  managed: string[];
  logs: Array<{ dept: unknown; user: unknown; type: string; details: Record<string, unknown>; severity: string }>;
} = {
  session: null, calls: [], listed: { data: [], error: null }, users: { data: [], error: null }, depts: { data: [], error: null },
  target: { data: null, error: null }, stopped: { data: [], error: null }, managed: ['d1', 'd2'], logs: [],
};

const did = (c: Call, name: string) => c.ops.some(([n]) => n === name);
const has = (c: Call, name: string, ...args: unknown[]) => c.ops.some(([n, a]) => n === name && JSON.stringify(a) === JSON.stringify(args));

function resolve(c: Call): Result {
  if (c.table === 'users') return state.users;
  if (c.table === 'departments') return state.depts;
  if (did(c, 'update')) return state.stopped;
  if (did(c, 'maybeSingle')) return state.target;
  return state.listed;
}

vi.mock('@/lib/auth', () => ({
  getServerAuthSession: async () => state.session,
  isAdminSession: (s: { user?: { role?: string } } | null) => s?.user?.role === 'ADMIN',
}));
vi.mock('@/lib/department-scope', () => ({ getManagedDepartmentIds: async () => state.managed }));
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
      for (const n of ['select', 'eq', 'in', 'order', 'limit', 'update']) b[n] = (...args: unknown[]) => { call.ops.push([n, args]); return b; };
      b.maybeSingle = async () => { call.ops.push(['maybeSingle', []]); return resolve(call); };
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(resolve(call)).then(res, rej);
      return b;
    },
  },
}));

import { GET } from '@/app/api/admin/shared-conversations/route';
import { DELETE } from '@/app/api/admin/shared-conversations/[id]/route';
import { cleanStopReason } from '@/lib/shared-conversations-admin';
import { SECURITY_EVENT_LABELS, securityDetailParts } from '@/lib/security-event-text';

const list = async () => {
  const res = await GET();
  return { status: res.status, body: await res.json() };
};
const stop = async (body: unknown, id = C1) => {
  const res = await DELETE({ json: async () => body } as never, { params: { id } });
  return { status: res.status, body: await res.json() };
};
const updates = () => state.calls.filter((c) => did(c, 'update'));

beforeEach(() => {
  state.session = { user: { id: 'admin1', role: 'ADMIN', departmentId: 'd1' } };
  state.calls = [];
  state.logs = [];
  state.managed = ['d1', 'd2'];
  state.listed = {
    data: [
      { id: C1, user_id: 'u1', department_id: 'd2', metadata: { shared_at: '2026-11-18T01:00:00.000Z' }, updated_at: '2026-11-18T01:00:00Z', title: '민원 회신 초안', share_token: 'secretTOKEN12' },
      { id: 'c2', user_id: 'u2', department_id: 'd1', metadata: {}, updated_at: '2026-11-10T01:00:00Z' },
    ],
    error: null,
  };
  state.users = { data: [{ id: 'u1', full_name: '김직원', email: 'kim@x.kr' }, { id: 'u2', full_name: null, email: 'lee@x.kr' }], error: null };
  state.depts = { data: [{ id: 'd1', name: '본부' }, { id: 'd2', name: '총무과' }], error: null };
  state.target = { data: { id: C1, user_id: 'u1', metadata: { shared_at: '2026-11-18T01:00:00.000Z', app_schedule: { id: 's1' } } }, error: null };
  state.stopped = { data: [{ id: C1 }], error: null };
});

describe('목록 — 누가·언제 공유했는지만', () => {
  it('관리 범위 부서의 공유 중인 대화만 읽고, 제목·내용·링크 주소는 고르지도 내보내지도 않는다', async () => {
    const out = await list();
    expect(out.status).toBe(200);
    expect(out.body.data).toEqual([
      { id: C1, userId: 'u1', userName: '김직원', departmentName: '총무과', sharedAt: '2026-11-18T01:00:00.000Z' },
      { id: 'c2', userId: 'u2', userName: 'lee@x.kr', departmentName: '본부', sharedAt: null },
    ]);
    const q = state.calls.find((c) => c.table === 'conversations')!;
    expect(has(q, 'eq', 'is_shared', true)).toBe(true);
    expect(has(q, 'in', 'department_id', ['d1', 'd2'])).toBe(true);
    const cols = String((q.ops.find(([n]) => n === 'select')?.[1] as unknown[])[0]);
    expect(cols).not.toContain('title');
    expect(cols).not.toContain('share_token');
    expect(JSON.stringify(out.body)).not.toContain('민원 회신');
    expect(JSON.stringify(out.body)).not.toContain('secretTOKEN12');
  });

  it('못 읽으면 "공유 중인 대화 없음"이 아니라 503 — 대화든 이름이든', async () => {
    state.listed = { data: null, error: ERR };
    expect((await list()).status).toBe(503);
    state.listed = { data: [{ id: C1, user_id: 'u1', department_id: 'd2', metadata: {} }], error: null };
    state.users = { data: null, error: ERR };
    expect((await list()).status).toBe(503);
  });

  it('관리자가 아니면 403, 관리 범위가 비면 읽지 않고 빈 목록', async () => {
    state.session = { user: { id: 'u1', role: 'USER', departmentId: 'd1' } };
    expect((await list()).status).toBe(403);
    expect(state.calls).toHaveLength(0);

    state.session = { user: { id: 'admin1', role: 'ADMIN', departmentId: 'd1' } };
    state.managed = [];
    const out = await list();
    expect(out.body.data).toEqual([]);
    expect(state.calls).toHaveLength(0);
  });
});

describe('중단', () => {
  it('관리 범위·공유 중일 때만 주소와 공유한 때를 버리고(다른 메타는 그대로) high로 기록한다', async () => {
    const out = await stop({ reason: ' 퇴직 예정자의 공개 링크 정리 ' });
    expect(out.status).toBe(200);
    const u = updates()[0];
    expect((u.ops.find(([n]) => n === 'update')?.[1] as unknown[])[0]).toEqual({ is_shared: false, share_token: null, metadata: { app_schedule: { id: 's1' } } });
    expect(has(u, 'eq', 'id', C1)).toBe(true);
    expect(has(u, 'eq', 'is_shared', true)).toBe(true);
    expect(has(u, 'in', 'department_id', ['d1', 'd2'])).toBe(true);
    expect(state.logs).toEqual([{
      dept: 'd1', user: 'admin1', type: 'conversation_unshared_by_admin', severity: 'high',
      details: { conversation_id: C1, target_user_id: 'u1', reason: '퇴직 예정자의 공개 링크 정리' },
    }]);
  });

  it('사유가 5자 미만이면 400 — 읽지도 쓰지도 않는다', async () => {
    expect((await stop({ reason: '정리' })).status).toBe(400);
    expect((await stop({})).status).toBe(400);
    const res = await DELETE({ json: async () => { throw new Error('bad'); } } as never, { params: { id: C1 } });
    expect(res.status).toBe(400);
    expect(state.calls).toHaveLength(0);
  });

  it('관리 범위 밖이거나 공유 중이 아니면 404(있는지 알리지 않음), 그 사이 직원이 멈췄어도 404 — 기록 없음', async () => {
    state.target = { data: null, error: null };
    expect((await stop({ reason: '공개 링크 정리합니다' })).status).toBe(404);
    expect(updates()).toHaveLength(0);

    state.target = { data: { id: C1, user_id: 'u1', metadata: {} }, error: null };
    state.stopped = { data: [], error: null };
    expect((await stop({ reason: '공개 링크 정리합니다' })).status).toBe(404);
    expect((await stop({ reason: '공개 링크 정리합니다' }, 'not-a-uuid')).status).toBe(404);
    expect(state.logs).toHaveLength(0);
  });

  it('못 읽거나 못 쓰면 500, 기록 없음', async () => {
    state.target = { data: null, error: ERR };
    expect((await stop({ reason: '공개 링크 정리합니다' })).status).toBe(500);
    state.target = { data: { id: C1, user_id: 'u1', metadata: {} }, error: null };
    state.stopped = { data: null, error: ERR };
    expect((await stop({ reason: '공개 링크 정리합니다' })).status).toBe(500);
    expect(state.logs).toHaveLength(0);
  });

  it('관리자가 아니면 403, 대리 접근이면 표시가 남는다', async () => {
    state.session = { user: { id: 'u1', role: 'USER', departmentId: 'd1' } };
    expect((await stop({ reason: '공개 링크 정리합니다' })).status).toBe(403);

    state.session = { user: { id: 'admin1', role: 'ADMIN', departmentId: 'd1', isImpersonating: true } };
    await stop({ reason: '공개 링크 정리합니다' });
    expect(state.logs[0].details).toMatchObject({ impersonating: true });
  });
});

describe('사유·이름표·화면', () => {
  it('사유는 다듬어 5~300자', () => {
    expect(cleanStopReason('  퇴직자  링크\n정리 ')).toBe('퇴직자 링크 정리');
    expect(cleanStopReason('정리')).toBeNull();
    expect(cleanStopReason(12)).toBeNull();
    expect(cleanStopReason('가'.repeat(400))).toHaveLength(300);
  });

  it('보안 사건 이름표와 상세(대상·사유)', () => {
    expect(SECURITY_EVENT_LABELS.conversation_unshared_by_admin).toBe('대화 공개 링크 중단(관리자)');
    const nameOf = (id: string) => (id === C1 ? '김직원' : null);
    expect(securityDetailParts({ conversation_id: 'x', target_user_id: C1, reason: '퇴직자 링크 정리' }, nameOf)).toEqual(['대상: 김직원', '사유: 퇴직자 링크 정리']);
  });

  it('설정 화면에 패널이 있고, 실패를 "없음"으로 보이지 않으며, 사유를 받아 보낸다', () => {
    const page = readFileSync('src/app/admin/settings/page.tsx', 'utf8');
    expect(page).toContain('<SharedLinksPanel />');
    const panel = readFileSync('src/components/admin/SharedLinksPanel.tsx', 'utf8');
    expect(panel).toContain("fetch('/api/admin/shared-conversations')");
    expect(panel).toContain('setRows(null);');
    expect(panel).toContain('body: JSON.stringify({ reason })');
    expect(panel).not.toContain('shareUrl');
  });
});
