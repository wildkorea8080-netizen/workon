import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const state = vi.hoisted(() => ({
  session: 'admin' as 'admin' | 'user' | null,
  actor: true,
  results: {} as Record<string, Array<{ data?: unknown; error?: { message: string } | null }>>,
  calls: [] as unknown[][],
}));
vi.mock('@/lib/auth', () => ({
  getServerAuthSession: async () => (state.session ? { user: { id: 'me', role: state.session === 'admin' ? 'ADMIN' : 'USER' } } : null),
  isAdminSession: (s: { user?: { role?: string } } | null) => s?.user?.role === 'ADMIN',
}));
vi.mock('@/lib/actor-scope', () => ({
  getActorScope: async () => (state.actor ? { userId: 'me', organizationId: 'org', departmentId: 'dept', visibleDepartmentIds: ['dept'], managedDepartmentIds: ['dept', 'sub'] } : null),
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'in', 'not', 'is', 'gte', 'order', 'limit']) {
        q[method] = (...args: unknown[]) => { state.calls.push([table, method, ...args]); return q; };
      }
      q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null, ...(state.results[table]?.shift() ?? {}) }).then(resolve, reject);
      return q;
    },
    rpc(name: string, args: unknown) {
      state.calls.push(['rpc', name, args]);
      return Promise.resolve({ data: [], error: null, ...(state.results.rpc?.shift() ?? {}) });
    },
  },
}));

import { runState, summarizeAppRuns, type OverviewApp, type OverviewRun } from '@/lib/apps/run-overview';
import { AppRunOverviewTable } from '@/components/admin/AppRunOverview';
import { GET } from '@/app/api/admin/app-overview/route';

beforeEach(() => { state.session = 'admin'; state.actor = true; state.results = {}; state.calls = []; });

const steps = (...statuses: string[]) => statuses.map((status, i) => ({ name: `단계${i + 1}`, status, output: '비밀 결과' }));
const run = (agent: string, at: string, appSteps?: unknown[] | null): OverviewRun => ({ agent_id: agent, created_at: at, messages: appSteps === null ? [] : [{ app_steps: appSteps }] });

describe('실행 상태', () => {
  it('직원 기록과 같은 규칙으로 가른다', () => {
    expect(runState(run('a', 't', null)).state).toBe('no_response');
    expect(runState(run('a', 't', undefined)).state).toBe('saved');
    expect(runState(run('a', 't', steps('completed', 'skipped', 'completed'))).state).toBe('saved');
    expect(runState(run('a', 't', steps('completed', 'running'))).state).toBe('uncertain');
    expect(runState(run('a', 't', steps('completed', 'failed', 'not_run')))).toEqual({ state: 'interrupted', failedSteps: ['단계2'] });
    expect(runState(run('a', 't', steps('completed', 'not_run')))).toEqual({ state: 'interrupted', failedSteps: [] });
  });
});

describe('앱별 묶기', () => {
  const apps: OverviewApp[] = [
    { id: 'a', name: '공문 정리', tier: 'department', departmentName: '총무과' },
    { id: 'b', name: '회의 요약', tier: 'department', departmentName: '기획과' },
    { id: 'p1', name: '김주무관 개인 메모 앱', tier: 'personal', departmentName: '총무과' },
    { id: 'p2', name: '개인 앱 둘', tier: 'personal', departmentName: '총무과' },
  ];
  const runs = [
    run('a', '2026-10-20T01:00:00Z', steps('completed', 'failed', 'not_run')),
    run('a', '2026-10-25T01:00:00Z', steps('failed', 'not_run', 'not_run')),
    run('a', '2026-10-26T01:00:00Z', steps('completed', 'failed', 'not_run')),
    run('a', '2026-10-27T01:00:00Z', steps('completed', 'completed', 'completed')),
    run('b', '2026-10-27T01:00:00Z', null),
    run('b', '2026-10-28T01:00:00Z', undefined),
    run('b', '2026-10-28T02:00:00Z', undefined),
    run('p1', '2026-10-28T01:00:00Z', steps('failed', 'not_run')),
    run('ghost', '2026-10-28T01:00:00Z', undefined),
  ];
  const result = summarizeAppRuns(apps, runs);
  it('부서 앱은 이름과 상태 수·자주 멈춘 단계·마지막 중단, 중단 많은 순', () => {
    expect(result.apps.map((a) => a.agentId)).toEqual(['a', 'b']);
    expect(result.apps[0]).toEqual({
      agentId: 'a', name: '공문 정리', departmentName: '총무과', runs: 4, saved: 1, interrupted: 3, uncertain: 0, noResponse: 0,
      failedSteps: [{ name: '단계2', count: 2 }, { name: '단계1', count: 1 }], lastInterruptedAt: '2026-10-26T01:00:00Z',
    });
    expect(result.apps[1]).toMatchObject({ runs: 3, saved: 2, noResponse: 1, interrupted: 0, lastInterruptedAt: null });
  });
  it('개인 앱은 이름 없이 한 묶음, 모르는 앱의 실행은 세지 않는다', () => {
    expect(result.personal).toEqual({ apps: 2, runs: 1, saved: 0, interrupted: 1, uncertain: 0, noResponse: 0 });
    expect(JSON.stringify(result)).not.toContain('김주무관');
    expect(JSON.stringify(result)).not.toContain('비밀 결과');
    expect(result.apps.reduce((n, a) => n + a.runs, 0) + result.personal.runs).toBe(8);
  });
  it('표는 개인 앱을 비공개 묶음으로 보이고 결과 글을 싣지 않는다', () => {
    const html = renderToStaticMarkup(createElement(AppRunOverviewTable, { data: result }));
    expect(html).toContain('공문 정리');
    expect(html).toContain('단계2(2)');
    expect(html).toContain('2026-10-26 10:00');
    expect(html).toContain('개인 앱 2개(이름 비공개)');
    expect(html).not.toContain('비밀 결과');
    expect(renderToStaticMarkup(createElement(AppRunOverviewTable, { data: summarizeAppRuns([], []) }))).toContain('입력형 앱이 없습니다');
    expect(renderToStaticMarkup(createElement(AppRunOverviewTable, { data: summarizeAppRuns(apps, [], true) }))).toContain('최근 실행만');
  });
});

describe('관리자 API', () => {
  it('로그인·관리자·관리 범위가 없으면 DB를 읽지 않는다', async () => {
    state.session = null;
    expect((await GET()).status).toBe(401);
    state.session = 'user';
    expect((await GET()).status).toBe(403);
    state.session = 'admin';
    state.actor = false;
    expect((await GET()).status).toBe(403);
    expect(state.calls).toEqual([]);
  });
  it('기관·관리 범위 부서의 앱만, 실행 기록은 단계 상태만 돌려주는 함수로 읽는다', async () => {
    state.results.agents = [{ data: [{ id: 'a', name: '공문 정리', tier: 'department', department_id: 'dept' }] }];
    state.results.departments = [{ data: [{ id: 'dept', name: '총무과' }] }];
    state.results.rpc = [{ data: [
      { agent_id: 'a', created_at: '2026-10-27T01:00:00Z', has_answer: true, steps: [{ name: '단계1', status: 'completed' }, { name: '단계2', status: 'failed' }] },
      { agent_id: 'a', created_at: '2026-10-26T01:00:00Z', has_answer: true, steps: null },
      { agent_id: 'a', created_at: '2026-10-25T01:00:00Z', has_answer: false, steps: null },
    ] }];
    const res = await GET();
    const body = await res.json();
    expect(body.data.apps[0]).toMatchObject({ name: '공문 정리', departmentName: '총무과', runs: 3, saved: 1, interrupted: 1, noResponse: 1, failedSteps: [{ name: '단계2', count: 1 }] });
    expect(state.calls).toContainEqual(['agents', 'eq', 'organization_id', 'org']);
    expect(state.calls).toContainEqual(['agents', 'in', 'department_id', ['dept', 'sub']]);
    expect(state.calls).toContainEqual(['agents', 'is', 'deleted_at', null]);
    const rpc = state.calls.find((c) => c[0] === 'rpc')!;
    expect(rpc[1]).toBe('app_run_states');
    expect(rpc[2]).toMatchObject({ p_agent_ids: ['a'], p_limit: 2001 });
    expect(state.calls.some((c) => c[0] === 'conversations' || c[0] === 'messages')).toBe(false);
  });
  it('앱이 없으면 실행 기록을 읽지 않고, DB 오류는 503', async () => {
    state.results.agents = [{ data: [] }];
    expect((await (await GET()).json()).data.apps).toEqual([]);
    expect(state.calls.some((c) => c[0] === 'rpc')).toBe(false);
    state.results.agents = [{ error: { message: 'down' } }];
    expect((await GET()).status).toBe(503);
  });
});

describe('0046 app_run_states', () => {
  it('단계 이름·상태만 내보내고 실행 권한은 service_role만', async () => {
    const { readFileSync } = await import('fs');
    const sql = readFileSync('supabase/migrations/0046_app_run_states.sql', 'utf8');
    expect(sql).toContain("jsonb_build_object('name', left(e.s ->> 'name', 40), 'status', e.s ->> 'status')");
    expect(sql).not.toMatch(/'output'|app_inputs|content|user_id/);
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.app_run_states(uuid[], timestamptz, int) FROM PUBLIC, anon, authenticated');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.app_run_states(uuid[], timestamptz, int) TO service_role');
  });
});
