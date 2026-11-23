import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-20 — 부서 계통(상위·하위·기관 부서)을 못 읽은 것을 '자기 부서만'으로 좁히지 않는다.
 * 좁히는 것은 권한을 넓히지 않아 안전해 보이지만, 그 범위로 **거르는** 곳에서는 좁힘이 곧 빠짐이다:
 *  - 관리 범위(`getManagedDepartmentIds`)로 거르는 감사 기록·이용통계·사용자 목록·보안 로그에서 하위 부서가 오류 없이 빠졌다
 *    (감사 CSV가 줄어든 채 나갈 수 있다).
 *  - 보이는 범위(`getVisibleDepartmentIds`)로 거는 금지어 필터에서 상위 부서의 금지어가 그 턴에 빠졌다.
 * 이제 읽기 오류는 `DepartmentScopeReadError`로 던지고, 요청자 범위는 `ActorScopeReadError`(→ 503), 관리 범위를 직접 읽는
 * 라우트는 `managedDepartmentIdsOr503`으로 받는다. 부서가 정말 없거나 계통이 빈 것(오류 없음)은 예전처럼 자기 부서만.
 */

const state = vi.hoisted(() => ({
  rpcError: {} as Record<string, unknown>, rpcData: {} as Record<string, unknown>,
  deptError: null as unknown, dept: { parent_id: null, organization_id: 'o1' } as unknown,
  allError: null as unknown, all: [{ id: 'd1' }, { id: 'd2' }] as unknown,
}));

vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    rpc: async (fn: string) => ({ data: state.rpcError[fn] ? null : state.rpcData[fn] ?? [{ id: 'd1' }], error: state.rpcError[fn] ?? null }),
    from: () => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq']) b[n] = () => b;
      b.maybeSingle = async () => ({ data: state.deptError ? null : state.dept, error: state.deptError });
      b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve({ data: state.allError ? null : state.all, error: state.allError }).then(ok, bad);
      return b;
    },
  },
}));

import { getManagedDepartmentIds, getSharedDepartmentIds, getVisibleDepartmentIds } from '@/lib/department-scope';
import { isDepartmentScopeReadError } from '@/lib/access-scope-error';
import { managedDepartmentIdsOr503 } from '@/lib/managed-scope-response';
import { getActorScope, isActorScopeReadError } from '@/lib/actor-scope';

const BOOM = { code: 'XX000', message: 'boom' };
const session = (role: 'ADMIN' | 'USER') => ({ user: { id: 'u1', role, departmentId: 'd1' }, expires: '' }) as never;

beforeEach(() => {
  state.rpcError = {}; state.rpcData = {}; state.deptError = null; state.allError = null;
  state.dept = { parent_id: null, organization_id: 'o1' }; state.all = [{ id: 'd1' }, { id: 'd2' }];
});

describe('부서 계통 읽기', () => {
  it('상위 부서를 못 읽으면 던진다(자기 부서만으로 좁히지 않음)', async () => {
    state.rpcError.department_ancestors = BOOM;
    const err = await getVisibleDepartmentIds('d1').catch((e) => e);
    expect(isDepartmentScopeReadError(err)).toBe(true);
    expect(err.what).toBe('ancestors');
  });
  it('하위 부서를 못 읽으면 던진다', async () => {
    state.rpcError.department_descendants = BOOM;
    expect(isDepartmentScopeReadError(await getSharedDepartmentIds('d1').catch((e) => e))).toBe(true);
  });
  it('관리 범위 — 자기 부서·기관 부서를 못 읽으면 던진다', async () => {
    state.deptError = BOOM;
    expect(isDepartmentScopeReadError(await getManagedDepartmentIds('d1').catch((e) => e))).toBe(true);
    state.deptError = null; state.allError = BOOM;
    expect(isDepartmentScopeReadError(await getManagedDepartmentIds('d1').catch((e) => e))).toBe(true);
  });
  it('읽히면 예전과 같다 — 최상위 부서 관리자는 기관 전체', async () => {
    expect(await getManagedDepartmentIds('d1')).toEqual(['d1', 'd2']);
    expect(await getVisibleDepartmentIds('d1')).toEqual(['d1']);
  });
  it('정말 없으면(오류 없음) 예전처럼 자기 부서만', async () => {
    state.rpcData.department_ancestors = [];
    expect(await getVisibleDepartmentIds('d1')).toEqual(['d1']);
    state.dept = null;
    expect(await getManagedDepartmentIds('d1')).toEqual(['d1']);
  });
});

describe('managedDepartmentIdsOr503', () => {
  it('못 읽으면 503 응답', async () => {
    state.deptError = BOOM;
    const res = await managedDepartmentIdsOr503('d1');
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(503);
    expect((await (res as Response).json()).error.message).toContain('관리 범위를 지금 확인하지 못했습니다');
  });
  it('읽히면 그 목록', async () => {
    expect(await managedDepartmentIdsOr503('d1')).toEqual(['d1', 'd2']);
  });
});

describe('요청자 범위', () => {
  it('상위 부서를 못 읽으면 ActorScopeReadError — 금지어 필터가 상위 부서를 빠뜨린 채 돌지 않는다', async () => {
    state.rpcError.department_ancestors = BOOM;
    expect(isActorScopeReadError(await getActorScope(session('USER')).catch((e) => e))).toBe(true);
  });
  it('관리자의 관리 범위를 못 읽어도 ActorScopeReadError', async () => {
    state.allError = BOOM;
    expect(isActorScopeReadError(await getActorScope(session('ADMIN')).catch((e) => e))).toBe(true);
  });
  it('읽히면 예전과 같다', async () => {
    expect(await getActorScope(session('ADMIN'))).toMatchObject({ visibleDepartmentIds: ['d1'], managedDepartmentIds: ['d1', 'd2'], managesWholeOrganization: true });
  });
});

describe('라우트 (원본)', () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
  const routes = walk('src/app/api').map((p) => ({ p: p.replace(/\\/g, '/'), s: readFileSync(p, 'utf8').replace(/\r\n/g, '\n') }));

  it('라우트는 관리 범위를 직접 읽지 않는다 — managedDepartmentIdsOr503으로만', () => {
    expect(routes.filter((r) => r.s.includes('getManagedDepartmentIds')).map((r) => r.p)).toEqual([]);
  });
  it('받은 자리마다 바로 응답을 돌려준다', () => {
    const users = routes.filter((r) => r.s.includes('managedDepartmentIdsOr503('));
    expect(users.length).toBeGreaterThanOrEqual(17);
    for (const r of users) {
      const calls = [...r.s.matchAll(/const (\w+) = await managedDepartmentIdsOr503\(/g)];
      expect(calls.length, r.p).toBeGreaterThan(0);
      for (const m of calls) expect(r.s, r.p).toContain(`if (${m[1]} instanceof Response) return ${m[1]};`);
    }
  });
  it('기관 통계 API도 관리 범위를 못 읽으면 503', () => {
    const src = readFileSync('src/lib/org-api/keys.ts', 'utf8');
    expect(src).toContain('if (isDepartmentScopeReadError(error)) return respond(fail(503, ORG_API_SCOPE_UNAVAILABLE));');
  });
});
