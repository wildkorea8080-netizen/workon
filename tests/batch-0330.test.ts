// tests/batch-0330.test.ts
// 입력형 앱 실행이 멈춘 까닭(2026-11-26, 0134) — 멈춘 단계 기록에 정해 둔 코드를 남기고 관리자 '앱 실행 현황'·CSV가 센다.
import { readFileSync } from 'fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { APP_EMPTY_RESULT_MESSAGE, APP_LIMIT_OR_POLICY_MESSAGE, APP_RUN_CAUSES, APP_RUN_CAUSE_LABELS, appRunCause } from '@/lib/apps/run-cause';
import { appRunOverviewCsv, runState, summarizeAppRuns, type OverviewApp, type OverviewRun } from '@/lib/apps/run-overview';
import { AppRunOverviewTable } from '@/components/admin/AppRunOverview';

const base = { message: '', llm: null, appInput: false, timeBudget: false, lookupStep: false } as const;

describe('까닭 가르기', () => {
  it('시간 예산·AI 오류 세 갈래·한도/정책·빈 결과·조회·입력·기타', () => {
    expect(appRunCause({ ...base, appInput: true, timeBudget: true })).toBe('time_budget');
    expect(appRunCause({ ...base, llm: 'unavailable' })).toBe('model_unavailable');
    expect(appRunCause({ ...base, llm: 'busy' })).toBe('model_busy');
    expect(appRunCause({ ...base, llm: 'failed' })).toBe('model_error');
    expect(appRunCause({ ...base, message: APP_LIMIT_OR_POLICY_MESSAGE })).toBe('limit_or_policy');
    expect(appRunCause({ ...base, message: APP_EMPTY_RESULT_MESSAGE })).toBe('empty_result');
    expect(appRunCause({ ...base, appInput: true, lookupStep: true })).toBe('lookup');
    expect(appRunCause({ ...base, appInput: true })).toBe('input');
    expect(appRunCause({ ...base, message: 'TypeError' })).toBe('other');
    for (const c of APP_RUN_CAUSES) expect(APP_RUN_CAUSE_LABELS[c]).toBeTruthy();
  });
  it('실행기 — 멈춘 단계(없으면 처음 실행하지 못한 단계)에 코드만, 같은 글로 가른다', () => {
    const stream = readFileSync('src/lib/assistant/stream.ts', 'utf8');
    expect(stream).toContain('throw new Error(APP_LIMIT_OR_POLICY_MESSAGE);');
    expect(stream).toContain('throw new Error(APP_EMPTY_RESULT_MESSAGE);');
    expect(stream).toContain("appRecords.findIndex(r => r.status === 'not_run')");
    expect(stream).toContain('appRecords[at].cause = appRunCause({');
    expect(stream).toContain('lookupStep: Boolean(step?.lookup || step?.research),');
  });
});

const apps: OverviewApp[] = [{ id: 'a', name: '공문 정리', tier: 'department', departmentName: '총무과' }];
const run = (steps: unknown[]): OverviewRun => ({ agent_id: 'a', created_at: '2026-11-20T01:00:00Z', messages: [{ app_steps: steps }] });

describe('집계', () => {
  it('중단마다 까닭 하나, 많은 순 3개, 까닭 없는 옛 기록·모르는 코드는 세지 않음', () => {
    expect(runState(run([{ name: '조회', status: 'failed', cause: 'lookup' }, { name: '정리', status: 'not_run' }]))).toMatchObject({ state: 'interrupted', cause: 'lookup' });
    expect(runState(run([{ name: '조회', status: 'not_run', cause: 'time_budget' }]))).toMatchObject({ cause: 'time_budget' });
    const o = summarizeAppRuns(apps, [
      run([{ name: '조회', status: 'failed', cause: 'time_budget' }]),
      run([{ name: '조회', status: 'failed', cause: 'time_budget' }]),
      run([{ name: '정리', status: 'failed', cause: 'model_busy' }]),
      run([{ name: '정리', status: 'failed' }]),
      run([{ name: '정리', status: 'failed', cause: 'nope' }]),
    ]);
    expect(o.apps[0].interrupted).toBe(5);
    expect(o.apps[0].failedCauses).toEqual([{ cause: 'time_budget', label: '처리 시간 초과', count: 2 }, { cause: 'model_busy', label: 'AI 요청 몰림', count: 1 }]);
    const csv = appRunOverviewCsv(o, '');
    expect(csv).toContain('자주 멈춘 단계,멈춘 까닭,마지막 중단(KST)');
    expect(csv).toContain('"처리 시간 초과(2), AI 요청 몰림(1)"');
    const html = renderToStaticMarkup(createElement(AppRunOverviewTable, { data: o }));
    expect(html).toContain('멈춘 까닭');
    expect(html).toContain('처리 시간 초과(2), AI 요청 몰림(1)');
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('0134 app_run_states_between(시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('까닭 코드는 내보내고 중간 결과 글은 내보내지 않는다, 까닭 없는 기록은 칸 없음', async () => {
    const sql = readFileSync('supabase/migrations/0134_app_run_states_cause.sql', 'utf8');
    await db.query('BEGIN');
    try {
      await db.query(sql); await db.query(sql);
      const org = (await db.query("INSERT INTO organizations (name) VALUES ('0134 시험 기관') RETURNING id")).rows[0].id;
      const dept = (await db.query("INSERT INTO departments (name, slug, organization_id) VALUES ('총무과', 'run-0134', $1) RETURNING id", [org])).rows[0].id;
      const agent = (await db.query("INSERT INTO agents (name, department_id, organization_id, tier, visibility) VALUES ('시험 앱', $1, $2, 'official', 'organization') RETURNING id", [dept, org])).rows[0].id;
      const conv = (await db.query('INSERT INTO conversations (department_id, agent_id) VALUES ($1, $2) RETURNING id', [dept, agent])).rows[0].id;
      await db.query("INSERT INTO messages (conversation_id, role, content, source_references) VALUES ($1, 'assistant', '결과', $2)", [conv, JSON.stringify({ app_steps: [{ name: '조회', status: 'completed', output: '비밀 결과' }, { name: '정리', status: 'failed', cause: 'model_busy', output: '중간 글' }] })]);
      const r = await db.query("SELECT steps FROM app_run_states_between($1, now() - interval '1 day', now() + interval '1 minute', 10)", [[agent]]);
      expect(r.rows).toEqual([{ steps: [{ name: '조회', status: 'completed' }, { name: '정리', status: 'failed', cause: 'model_busy' }] }]);
      const priv = await db.query("SELECT has_function_privilege('anon', 'public.app_run_states_between(uuid[], timestamptz, timestamptz, int)', 'EXECUTE') a");
      expect(priv.rows[0].a).toBe(false);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
