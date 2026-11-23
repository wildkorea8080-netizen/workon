import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-18 — 관리자 설정 화면 '보안 이벤트 로그'(`GET /api/security-logs`)가 기록 원문(`details`)을 통째로 돌려줬고 화면이 그대로 펼쳤다.
 * 금지어 기록에는 직원 질문의 앞 100자(`context`)가 들어 있어, 사유를 적고 열람하는 길(감사 화면)을 거치지 않고 질문이 보였다.
 * 자기 부서 한 곳만 봐 감사 화면(관리 범위)과 달랐고, 사건 이름은 영어 코드, 읽기 실패는 '보안 이벤트가 없습니다'였다.
 */

type Call = { table: string; ops: Array<[string, unknown[]]> };
const state: {
  session: unknown;
  calls: Call[];
  logs: { data: unknown; error: unknown };
  count: { count: number | null; error: unknown };
  names: { data: unknown; error: unknown };
} = { session: null, calls: [], logs: { data: [], error: null }, count: { count: 0, error: null }, names: { data: [], error: null } };

const MANAGED = ['d1', 'd2'];
const T_IN = '11111111-1111-4111-8111-111111111111';
const T_OUT = '22222222-2222-4222-8222-222222222222';

vi.mock('@/lib/auth', () => ({
  getServerAuthSession: async () => state.session,
  isAdminSession: (s: { user?: { role?: string } } | null) => s?.user?.role === 'ADMIN',
}));
vi.mock('@/lib/department-scope', () => ({ getManagedDepartmentIds: async () => MANAGED }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const call: Call = { table, ops: [] };
      state.calls.push(call);
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'in', 'order', 'range']) b[n] = (...args: unknown[]) => { call.ops.push([n, args]); return b; };
      b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
        const isCount = call.ops.some(([n, a]) => n === 'select' && (a[1] as { head?: boolean } | undefined)?.head === true);
        const result = table === 'users' ? state.names : isCount ? state.count : state.logs;
        return Promise.resolve(result).then(ok, bad);
      };
      return b;
    },
  },
}));

import { GET } from '@/app/api/security-logs/route';

const get = (q = 'limit=20') => GET({ url: `http://x/api/security-logs?${q}` } as never);
const has = (c: Call, name: string, ...args: unknown[]) => c.ops.some(([n, a]) => n === name && JSON.stringify(a) === JSON.stringify(args));
const ERR = { code: 'XX000', message: 'boom' };

beforeEach(() => {
  state.session = { user: { id: 'admin1', role: 'ADMIN', departmentId: 'd1' } };
  state.calls = [];
  state.logs = {
    data: [
      { id: 's1', event_type: 'forbidden_word_detected', severity: 'high', created_at: '2026-11-18T01:00:00Z', users: { full_name: '김직원', email: 'k@x.kr' }, details: { word: '기밀', context: '기밀 문서 내용을 요약해 줘' } },
      { id: 's2', event_type: 'user_deactivated', severity: 'high', created_at: '2026-11-18T00:00:00Z', users: [{ full_name: '박관리', email: 'p@x.kr' }], details: { target_user_id: T_IN, reason: '퇴직' } },
      { id: 's3', event_type: 'password_reset_by_admin', severity: 'high', created_at: '2026-11-17T00:00:00Z', users: null, details: { target_user_id: T_OUT } },
      { id: 's4', event_type: 'new_unknown_event', severity: 'weird', created_at: '2026-11-16T00:00:00Z', users: null, details: null },
    ],
    error: null,
  };
  state.count = { count: 4, error: null };
  state.names = { data: [{ id: T_IN, full_name: '이대상' }], error: null };
});

describe('GET /api/security-logs', () => {
  it('기록 원문을 싣지 않음 — 질문 글이 응답 어디에도 없음', async () => {
    const res = await get();
    const text = JSON.stringify(await res.json());
    expect(res.status).toBe(200);
    expect(text).not.toContain('기밀 문서 내용을 요약해 줘');
    expect(text).not.toContain('"details"');
    expect(text).not.toContain('context');
  });

  it('사건 이름·심각도는 한국어로, 상세는 대상·사유 한 줄', async () => {
    const body = await (await get()).json();
    expect(body.data.total).toBe(4);
    expect(body.data.logs).toEqual([
      { id: 's1', event_type: 'forbidden_word_detected', label: '금지어 감지', severity: 'high', severity_label: '높음', created_at: '2026-11-18T01:00:00Z', users: { full_name: '김직원', email: 'k@x.kr' }, detail: '탐지어: 기밀' },
      { id: 's2', event_type: 'user_deactivated', label: '계정 사용 중지(관리자)', severity: 'high', severity_label: '높음', created_at: '2026-11-18T00:00:00Z', users: { full_name: '박관리', email: 'p@x.kr' }, detail: '대상: 이대상 / 사유: 퇴직' },
      { id: 's3', event_type: 'password_reset_by_admin', label: '임시 비밀번호 재발급(관리자)', severity: 'high', severity_label: '높음', created_at: '2026-11-17T00:00:00Z', users: null, detail: '대상: (관리 범위 밖이거나 삭제된 계정)' },
      { id: 's4', event_type: 'new_unknown_event', label: 'new_unknown_event', severity: 'weird', severity_label: 'weird', created_at: '2026-11-16T00:00:00Z', users: null, detail: '' },
    ]);
  });

  it('관리 범위로 본다 — 목록·수·대상 이름 모두', async () => {
    await get('limit=20&event_type=user_deactivated&severity=high');
    expect(state.calls.map((c) => c.table)).toEqual(['security_logs', 'security_logs', 'users']);
    for (const c of state.calls) {
      expect(has(c, 'in', 'department_id', MANAGED), c.table).toBe(true);
      expect(c.ops.some(([n, a]) => n === 'eq' && a[0] === 'department_id')).toBe(false);
    }
    for (const c of state.calls.slice(0, 2)) {
      expect(has(c, 'eq', 'event_type', 'user_deactivated')).toBe(true);
      expect(has(c, 'eq', 'severity', 'high')).toBe(true);
    }
    // 대상 이름은 이 쪽에 나온 대상만 찾는다
    expect(has(state.calls[2], 'in', 'id', [T_IN, T_OUT])).toBe(true);
  });

  it('대상이 없으면 이름을 찾지 않음', async () => {
    state.logs = { data: [{ id: 's1', event_type: 'ip_blocked', severity: 'medium', created_at: 'x', users: null, details: {} }], error: null };
    await get();
    expect(state.calls.map((c) => c.table)).toEqual(['security_logs', 'security_logs']);
  });

  it('목록·수·대상 이름을 못 읽으면 500 — 0건·모름으로 꾸미지 않음', async () => {
    state.logs = { data: null, error: ERR };
    expect((await get()).status).toBe(500);
    state.logs = { data: [], error: null };
    state.count = { count: null, error: ERR };
    expect((await get()).status).toBe(500);
    state.count = { count: null, error: null };
    expect((await get()).status).toBe(500);
  });

  it('대상 이름 읽기가 실패해도 500', async () => {
    state.names = { data: null, error: ERR };
    expect((await get()).status).toBe(500);
  });

  it('이상한 limit·offset은 기본값으로', async () => {
    await get('limit=abc&offset=-5');
    expect(has(state.calls[0], 'range', 0, 49)).toBe(true);
    state.calls = [];
    await get('limit=9999&offset=40');
    expect(has(state.calls[0], 'range', 40, 89)).toBe(true);
    state.calls = [];
    await get('limit=20&offset=20');
    expect(has(state.calls[0], 'range', 20, 39)).toBe(true);
  });

  it('로그인 없으면 401, 직원은 403', async () => {
    state.session = null;
    expect((await get()).status).toBe(401);
    state.session = { user: { id: 'u', role: 'USER', departmentId: 'd1' } };
    expect((await get()).status).toBe(403);
    expect(state.calls).toEqual([]);
  });
});

describe('원본', () => {
  const route = readFileSync('src/app/api/security-logs/route.ts', 'utf8');
  const ui = readFileSync('src/components/admin/SettingsManager.tsx', 'utf8');
  it('라우트가 칸을 골라 읽음 — 통째(*)로 읽지 않음', () => {
    expect(route).not.toMatch(/select\(`\s*\*/);
    expect(route).toContain('managedDepartmentIdsOr503(departmentId)');
  });
  it('화면이 기록 원문을 펼치지 않고, 실패를 "없음"으로 보이지 않음', () => {
    expect(ui).not.toContain('JSON.stringify(log.details');
    expect(ui).not.toContain('log.details');
    expect(ui).toContain('{log.label}');
    expect(ui).toContain('{log.detail}');
    expect(ui).toContain('securityLogs.length === 0 && !logsLoading && !logsError');
  });
  it('이름표는 한 곳 — 감사 라우트에 따로 두지 않음', () => {
    const audit = readFileSync('src/app/api/admin/audit-logs/route.ts', 'utf8');
    expect(audit).not.toContain('const SECURITY_LABEL');
    expect(audit).toContain('SECURITY_EVENT_LABELS[log.event_type] ?? log.event_type');
  });
});
