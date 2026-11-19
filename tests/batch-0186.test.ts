import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 슈퍼관리자 대리 접근(`POST /api/super/organizations/[id]/impersonate`).
 * 예전: 가장 먼저 만든 관리자 하나(5명 중)로 들어가, 그 사람이 하위 부서 관리자면 슈퍼관리자가 그 부서 아래만 보며
 * 기관 전체를 본 줄 알았다. 부서·관리자를 못 읽으면 '부서가 없습니다'·'관리자가 없습니다'(404)로 답했다.
 */

const state = {
  deptError: null as unknown,
  adminError: null as unknown,
  depts: [] as Array<{ id: string; name: string; parent_id: string | null }>,
  admins: [] as Array<{ id: string; email: string; full_name: string; department_id: string; created_at: string }>,
  encoded: [] as Array<Record<string, unknown>>,
};

vi.mock('@/lib/super-auth', () => ({ getSuperAdminFromRequest: () => ({ sub: 'super-1' }) }));
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn(async () => {}) }));
vi.mock('@/lib/config', () => ({ NEXTAUTH_SECRET: 'x'.repeat(32) }));
vi.mock('next-auth/jwt', () => ({ encode: vi.fn(async ({ token }: { token: Record<string, unknown> }) => { state.encoded.push(token); return 'tok'; }) }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'in', 'is', 'order', 'limit', 'insert']) b[n] = () => b;
      const respond = () => {
        if (table === 'organizations') return { data: { id: 'org-1', name: '가 기관' }, error: null };
        if (table === 'departments') return { data: state.deptError ? null : state.depts, error: state.deptError };
        if (table === 'users') return { data: state.adminError ? null : state.admins, error: state.adminError };
        if (table === 'impersonation_logs') return { data: { id: 'log-1' }, error: null };
        return { data: null, error: null };
      };
      b.maybeSingle = async () => respond();
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(respond()).then(res);
      return b;
    },
  },
}));

import { narrowImpersonationNotice, pickImpersonationTarget } from '@/lib/impersonation-target';
import { POST } from '@/app/api/super/organizations/[id]/impersonate/route';

const top = { id: 'd-top', name: '기관', parent_id: null };
const sub = { id: 'd-sub', name: '총무과', parent_id: 'd-top' };
const admin = (id: string, department_id: string, created_at = '2026-01-01') => ({ id, email: `${id}@x`, full_name: id, department_id, created_at });
const call = () => POST(new Request('http://x/', { method: 'POST' }) as never, { params: { id: 'org-1' } });

beforeEach(() => {
  state.deptError = null; state.adminError = null; state.encoded = [];
  state.depts = [top, sub];
  state.admins = [];
});

describe('pickImpersonationTarget', () => {
  it('먼저 만든 하위 부서 관리자보다 최상위 부서의 관리자', () => {
    const p = pickImpersonationTarget([admin('a-sub', 'd-sub', '2025'), admin('a-top', 'd-top', '2026')], [top, sub], 'super-1');
    expect(p).toMatchObject({ user: { id: 'a-top' }, wholeOrganization: true, departmentName: '기관' });
  });
  it('최상위 관리자가 없으면 하위 부서 관리자 — 그렇다고 표시', () => {
    const p = pickImpersonationTarget([admin('a-sub', 'd-sub')], [top, sub], 'super-1');
    expect(p).toMatchObject({ user: { id: 'a-sub' }, wholeOrganization: false, departmentName: '총무과' });
    expect(narrowImpersonationNotice('총무과')).toContain("'총무과' 관리자로 들어갑니다");
  });
  it('슈퍼관리자 본인은 뒤로, 이 기관 밖 부서·부서 없는 관리자는 빼고, 없으면 null', () => {
    expect(pickImpersonationTarget([admin('super-1', 'd-top'), admin('a2', 'd-top')], [top], 'super-1')?.user.id).toBe('a2');
    expect(pickImpersonationTarget([admin('super-1', 'd-top')], [top], 'super-1')?.user.id).toBe('super-1');
    expect(pickImpersonationTarget([admin('x', 'other'), { id: 'y', department_id: null }], [top], 'super-1')).toBeNull();
  });
});

describe('POST impersonate', () => {
  it('최상위 부서의 관리자로 들어가고 경고 없음', async () => {
    state.admins = [admin('a-sub', 'd-sub', '2025'), admin('a-top', 'd-top', '2026')];
    const res = await call();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.warning).toBeUndefined();
    expect(body.data.wholeOrganization).toBe(true);
    expect(state.encoded[0]).toMatchObject({ id: 'a-top', departmentId: 'd-top', isImpersonating: true });
  });
  it('하위 부서 관리자뿐이면 들어가되 알림', async () => {
    state.admins = [admin('a-sub', 'd-sub')];
    const body = await (await call()).json();
    expect(body.data.wholeOrganization).toBe(false);
    expect(body.warning).toContain('총무과');
  });
  it('부서·관리자를 못 읽으면 404가 아니라 503(토큰 없음)', async () => {
    state.deptError = { code: 'XX000' };
    expect((await call()).status).toBe(503);
    state.deptError = null; state.adminError = { code: 'XX000' };
    expect((await call()).status).toBe(503);
    expect(state.encoded).toHaveLength(0);
  });
  it('관리자가 정말 없으면 404', async () => {
    expect((await call()).status).toBe(404);
  });
});

describe('원본 확인 — 화면', () => {
  it('경고를 알린다', () => {
    for (const p of ['src/app/super/organizations/page.tsx', 'src/app/super/organizations/[id]/page.tsx']) {
      expect(readFileSync(p, 'utf8')).toContain("if (typeof data.warning === 'string') showToast(data.warning);");
    }
  });
});
