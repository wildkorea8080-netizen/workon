import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 요청자의 소속을 못 읽으면 '소속 없음'이 아니다.
 * 예전 `getActorScope`는 사용자·부서 읽기 실패도 '소속 없음'(null·기관 null)이라 라우트가 '소속 부서가 지정되지 않았습니다'(403)로
 * 답했고, **예약·일괄 실행은 대화 준비의 그 403을 '앱을 쓸 수 없음'으로 보아 예약을 바로 멈추고 직원에게 메일을 보냈다.**
 */

const state = { userError: null as unknown, deptError: null as unknown, userDept: 'd1' as string | null, dept: { organization_id: 'o1', parent_id: null } as Record<string, unknown> | null };

vi.mock('@/lib/department-scope', () => ({
  getVisibleDepartmentIds: vi.fn(async (d: string) => [d]),
  getManagedDepartmentIds: vi.fn(async (d: string) => [d]),
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq']) b[n] = () => b;
      b.maybeSingle = async () => (table === 'users'
        ? { data: state.userError ? null : { department_id: state.userDept }, error: state.userError }
        : { data: state.deptError ? null : state.dept, error: state.deptError });
      return b;
    },
  },
}));

import { ActorScopeReadError, getActorScope, isActorScopeReadError } from '@/lib/actor-scope';

const session = (departmentId?: string) => ({ user: { id: 'u1', role: 'USER', ...(departmentId ? { departmentId } : {}) }, expires: '' }) as never;

beforeEach(() => { state.userError = null; state.deptError = null; state.userDept = 'd1'; state.dept = { organization_id: 'o1', parent_id: null }; });

describe('getActorScope', () => {
  it('정상 — 기관까지', async () => {
    expect(await getActorScope(session('d1'))).toMatchObject({ userId: 'u1', departmentId: 'd1', organizationId: 'o1' });
  });
  it('정말 소속이 없으면 null·기관 null', async () => {
    state.userDept = null;
    expect(await getActorScope(session())).toBeNull();
    state.dept = null;
    expect(await getActorScope(session('d1'))).toMatchObject({ organizationId: null });
  });
  it('사용자·부서를 못 읽으면 던짐', async () => {
    state.userError = { code: '57014' };
    const e1 = await getActorScope(session()).catch((e) => e);
    expect(e1).toBeInstanceOf(ActorScopeReadError);
    expect(e1).toMatchObject({ what: 'user', code: '57014' });
    state.userError = null; state.deptError = { code: 'XX000' };
    const e2 = await getActorScope(session('d1')).catch((e) => e);
    expect(isActorScopeReadError(e2)).toBe(true);
    expect(e2).toMatchObject({ what: 'department' });
  });
});

describe('원본 확인 — 받는 곳', () => {
  it('대화 준비는 503으로 거절(예약·일괄 실행이 멈추는 403·404가 아님)', () => {
    const s = readFileSync('src/lib/assistant/prepare.ts', 'utf8');
    expect(s).toContain('if (isActorScopeReadError(err)) return reject(ACTOR_SCOPE_UNAVAILABLE_MESSAGE, 503);');
    // 예약 실행기는 403·404·409만 멈춘다 — 503은 실패로 세어 다시 해 본다
    const sched = readFileSync('src/lib/apps/schedules.ts', 'utf8');
    expect(sched).toContain("if (outcome.status === 403 || outcome.status === 404) return { kind: 'pause', reason: PAUSED_APP_UNAVAILABLE };");
  });
  it('업무 작업은 503 WorkError', () => {
    expect(readFileSync('src/lib/work/server.ts', 'utf8')).toContain("throw new WorkError('ACTOR_UNAVAILABLE', ACTOR_SCOPE_UNAVAILABLE_MESSAGE, 503);");
    expect(readFileSync('src/lib/work/types.ts', 'utf8')).toContain("ACTOR_UNAVAILABLE: 'ACTOR_UNAVAILABLE',");
  });
});
