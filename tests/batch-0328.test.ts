// tests/batch-0328.test.ts
// 관리자 '앱 실행 현황'의 기간 고르기·CSV(2026-11-26, 0133) — 끝 시각까지 DB에서 걸고(app_run_states_between), 같은 표를 CSV로.
import { readFileSync } from 'fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  results: {} as Record<string, Array<{ data?: unknown; error?: { message: string } | null }>>,
  calls: [] as unknown[][],
}));
vi.mock('@/lib/auth', () => ({
  getServerAuthSession: async () => ({ user: { id: 'me', role: 'ADMIN' } }),
  isAdminSession: (s: { user?: { role?: string } } | null) => s?.user?.role === 'ADMIN',
}));
vi.mock('@/lib/actor-scope', () => ({
  getActorScope: async () => ({ userId: 'me', organizationId: 'org', departmentId: 'dept', visibleDepartmentIds: ['dept'], managedDepartmentIds: ['dept'] }),
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'in', 'not', 'is', 'gte', 'lt', 'order', 'limit']) q[method] = (...args: unknown[]) => { state.calls.push([table, method, ...args]); return q; };
      q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve({ data: [], error: null, ...(state.results[table]?.shift() ?? {}) }).then(resolve, reject);
      return q;
    },
    rpc(name: string, args: unknown) {
      state.calls.push(['rpc', name, args]);
      return Promise.resolve({ data: [], error: null, ...(state.results.rpc?.shift() ?? {}) });
    },
  },
}));

import { GET } from '@/app/api/admin/app-overview/route';
import { appRunOverviewCsv, summarizeAppRuns } from '@/lib/apps/run-overview';
import { appRunsReport } from '@/lib/org-api/reports';

beforeEach(() => { state.results = {}; state.calls = []; });
const req = (q: string) => new NextRequest(`https://workon.test/api/admin/app-overview${q}`);
const withApp = () => {
  state.results.agents = [{ data: [{ id: 'a', name: '=HYPERLINK("x")', tier: 'department', department_id: 'dept' }, { id: 'p', name: '내 비밀 앱', tier: 'personal', department_id: 'dept' }] }];
  state.results.departments = [{ data: [{ id: 'dept', name: '총무과' }] }];
  state.results.rpc = [{ data: [
    { agent_id: 'a', created_at: '2026-10-05T01:00:00Z', has_answer: true, steps: [{ name: '정리', status: 'failed' }] },
    { agent_id: 'p', created_at: '2026-10-04T01:00:00Z', has_answer: true, steps: [{ name: 'x', status: 'completed' }] },
  ] }];
};

describe('기간', () => {
  it('고른 기간의 시작·다음 날 0시(KST)를 DB 함수에 넘기고, 응답에 기간을 싣는다', async () => {
    withApp();
    const body = await (await GET(req('?from=2026-10-01&to=2026-10-31'))).json();
    const rpc = state.calls.find((c) => c[0] === 'rpc')!;
    expect(rpc[1]).toBe('app_run_states_between');
    expect(rpc[2]).toMatchObject({ p_since: '2026-10-01T00:00:00+09:00', p_until: '2026-11-01T00:00:00+09:00', p_limit: 2001 });
    expect(body.data).toMatchObject({ from: '2026-10-01', to: '2026-10-31', days: 31 });
    expect(body.data.apps[0]).toMatchObject({ interrupted: 1, failedSteps: [{ name: '정리', count: 1 }] });
  });
  it('비우면 최근 30일, 틀린 날짜·뒤집힘·1년 넘음은 DB를 읽지 않고 400', async () => {
    withApp();
    expect((await (await GET(req(''))).json()).data.days).toBe(30);
    state.calls = [];
    for (const q of ['?from=2026-13-01', '?from=2026-10-31&to=2026-10-01', '?from=2024-01-01&to=2026-01-01']) expect((await GET(req(q))).status).toBe(400);
    expect(state.calls).toEqual([]);
  });
  it('기관 통계 API도 같은 기간 규칙', async () => {
    expect(await appRunsReport({ organizationId: 'org', departmentIds: ['dept'] } as never, Date.now(), { from: 'x', to: null })).toMatchObject({ status: 400 });
    withApp();
    expect(await appRunsReport({ organizationId: 'org', departmentIds: ['dept'] } as never, Date.now(), { from: '2026-10-01', to: '2026-10-31' })).toMatchObject({ data: { from: '2026-10-01', to: '2026-10-31' } });
  });
});

describe('CSV', () => {
  it('같은 표를 BOM·수식 막기와 함께, 개인 앱은 이름 없이', async () => {
    withApp();
    const res = await GET(req('?from=2026-10-01&to=2026-10-31&format=csv'));
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('app-runs-2026-10-01-2026-10-31.csv');
    // res.text()는 BOM을 떼므로 바이트로 본다
    const bytes = Buffer.from(await res.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.subarray(3).toString('utf8');
    expect(text.startsWith('기간,2026-10-01 ~ 2026-10-31')).toBe(true);
    expect(text).toContain(`"'=HYPERLINK(""x"")",총무과,1,0,1,0,0,정리(1),2026-10-05 10:00`);
    expect(text).toContain('개인 앱 1개(이름 비공개)');
    expect(text).not.toContain('내 비밀 앱');
  });
  it('잘린 표는 그렇다고 적는다', () => {
    expect(appRunOverviewCsv(summarizeAppRuns([], [], true), '')).toContain('최근 30일,실행이 많아 최근 실행만 셈');
  });
  it('화면 — 기간 칸·CSV 단추·늦은 응답 버리기', () => {
    const ui = readFileSync('src/components/admin/AppRunOverview.tsx', 'utf8');
    expect(ui).toContain('aria-label="실행 현황 시작일"');
    expect(ui).toContain("q.set('format', 'csv');");
    expect(ui).toContain('if (!gate.current.isLatest(ticket)) return;');
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('0133(시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('네 인자 함수·옛 함수도 남음·두 번 적용해도 안전', async () => {
    const sql = readFileSync('supabase/migrations/0133_app_run_states_between.sql', 'utf8');
    await db.query('BEGIN');
    try {
      await db.query(sql); await db.query(sql);
      const fns = await db.query(`SELECT p.proname, pg_get_function_identity_arguments(p.oid) a FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'app_run_states%' ORDER BY 1`);
      expect(fns.rows).toEqual([
        { proname: 'app_run_states', a: 'p_agent_ids uuid[], p_since timestamp with time zone, p_limit integer' },
        { proname: 'app_run_states_between', a: 'p_agent_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone, p_limit integer' },
      ]);
      const r = await db.query(`SELECT count(*)::int n FROM public.app_run_states_between(ARRAY[]::uuid[], now() - interval '1 day', now(), 10)`);
      expect(r.rows[0].n).toBe(0);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
