import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-20 — 기관 관리자 감사 화면(`/api/admin/audit-logs`)이 직원 목록을 못 읽으면 내지 않는다.
 * 예전엔 못 읽어도 이어 가 모든 줄의 직원이 '(삭제된 계정)'으로 보였고 감사 CSV(기관 밖으로 나갈 수 있음)에도 그렇게 나갔으며,
 * 직원을 골라 조회하면 '관리 권한이 없는 직원입니다'(403)라고 답했다.
 * 화면의 CSV 내려받기는 받아 본 뒤 저장한다 — 예전엔 주소로 바로 이동해 거절되면 오류 JSON 화면으로 넘어갔다.
 */

const state = { membersError: null as unknown, members: [] as unknown[], logs: [] as unknown[] };

vi.mock('@/lib/auth', () => ({
  getServerAuthSession: async () => ({ user: { id: 'admin1', role: 'ADMIN', departmentId: 'd1' } }),
  isAdminSession: () => true,
}));
vi.mock('@/lib/department-scope', () => ({ getManagedDepartmentIds: async () => ['d1'] }));
vi.mock('@/lib/filter', () => ({ logSecurityEvent: vi.fn() }));
vi.mock('@/lib/paged-select', () => ({
  pagedRows: async () => (state.membersError
    ? { data: [], error: state.membersError, truncated: false, total: null }
    : { data: state.members, error: null, truncated: false, total: state.members.length }),
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: () => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'in', 'is', 'not', 'lt', 'lte', 'gte', 'order', 'range', 'limit']) b[n] = () => b;
      b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
        Promise.resolve({ data: state.logs, error: null, count: state.logs.length }).then(ok, bad);
      return b;
    },
  },
}));

import { GET } from '@/app/api/admin/audit-logs/route';

const get = (q = '') => GET(new Request(`http://x/api/admin/audit-logs${q}`) as never);

beforeEach(() => {
  state.membersError = null;
  state.members = [{ id: 'u1', full_name: '김직원', email: 'a@x', department_id: 'd1', departments: { name: '총무과' } }];
  state.logs = [{ id: 'l1', user_id: 'u1', action: 'chat_message', details: {}, created_at: '2026-11-19T00:00:00Z', department_id: 'd1' }];
});

describe('GET /api/admin/audit-logs', () => {
  it('직원 목록을 못 읽으면 503(목록·CSV 모두)', async () => {
    state.membersError = { message: 'down' };
    for (const q of ['', '?format=csv', '?userId=u1']) {
      const res = await get(q);
      expect(res.status).toBe(503);
      expect((await res.json()).error.message).toContain('직원 목록을 지금 읽지 못했습니다');
    }
  });
  it('읽으면 이름이 그대로', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain('김직원');
  });
  it('정말 범위 밖 직원이면 403', async () => {
    expect((await get('?userId=someone-else')).status).toBe(403);
  });
});

describe('화면 CSV 내려받기', () => {
  const src = readFileSync('src/components/admin/AuditLogsManager.tsx', 'utf8');
  it('받아 본 뒤 저장하고, 거절은 화면에 알린다', () => {
    expect(src).not.toContain('window.location.href = `/api/admin/audit-logs?${params}`');
    expect(src).toContain('const res = await fetch(`/api/admin/audit-logs?${params}`);');
    expect(src).toContain("setError(body?.error?.message ?? '내보내기에 실패했습니다. 잠시 뒤 다시 시도해 주세요.');");
    expect(src).toContain('a.download = name ? decodeURIComponent(name) : ');
  });
});
