import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * (2026-11-11, 0086) 기관 통계 API 끝점 셋 — 답변 평가 요약·입력형 앱 실행 현황·예산 소진 현황.
 * 관리자 화면과 같은 읽기 함수를 쓰는지, 범위(usage)·숫자만·개인 한도/직원 없음, 호출 기록 CHECK가 새 끝점을 받는지
 */

const feedback = vi.hoisted(() => ({
  loadFeedbackSummary: vi.fn(async () => ({ total: { up: 3, down: 1, helpfulPercent: 75, savedMinutes: 40, savedReports: 2 }, agents: [], truncated: false })),
}));
const runs = vi.hoisted(() => ({ loadAppRunOverview: vi.fn(async () => ({ days: 30, apps: [], personal: { runs: 0, saved: 0, interrupted: 0, uncertain: 0, noResponse: 0, apps: 0 }, truncated: false })) }));
const budget = vi.hoisted(() => ({
  organizationBudgetStatus: vi.fn(async (): Promise<unknown> => ({ kind: 'annual_budget', periodKey: 'contract:c1', used: 1_200_000, limit: 10_000_000, percent: 12, alertPercent: 80, periodEndsAt: '2026-12-31T15:00:00Z' })),
  departmentBudgetStatuses: vi.fn(async () => ({
    statuses: [
      { departmentId: 'd1', departmentName: '민원과', periodKey: 'month:2026-11', used: 50_000, limit: 100_000, percent: 50 },
      { departmentId: 'other', departmentName: '범위 밖', periodKey: 'month:2026-11', used: 1, limit: 2, percent: 50 },
    ],
    failed: 1,
  })),
}));
vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/message-feedback', async (orig) => ({ ...(await orig<typeof import('@/lib/message-feedback')>()), loadFeedbackSummary: feedback.loadFeedbackSummary }));
vi.mock('@/lib/apps/run-overview-load', () => ({ loadAppRunOverview: runs.loadAppRunOverview }));
vi.mock('@/lib/usage-limit', () => ({ organizationBudgetStatus: budget.organizationBudgetStatus, departmentBudgetStatuses: budget.departmentBudgetStatuses }));

import { appRunsReport, budgetReport, feedbackSummaryReport } from '@/lib/org-api/reports';
import { ORG_API_ENDPOINTS } from '@/lib/org-api/spec';

const ctx = { keyId: 'k1', organizationId: 'o1', departmentIds: ['d1', 'd2'] };
const NOW = Date.parse('2026-11-11T03:00:00Z');

beforeEach(() => { vi.clearAllMocks(); });

describe('끝점 표', () => {
  it('셋 모두 범위 usage, 주소는 /api/v1/…', () => {
    for (const e of ['feedback-summary', 'app-runs', 'budget'] as const) {
      expect(ORG_API_ENDPOINTS[e].scope).toBe('usage');
      expect(ORG_API_ENDPOINTS[e].path.startsWith(`/api/v1/${e}`)).toBe(true);
    }
  });
});

describe('답변 평가 요약', () => {
  it('기간을 관리자 화면과 같은 규칙으로 읽고 키 범위의 부서로 센다', async () => {
    const out = await feedbackSummaryReport(ctx, { from: '2026-10-01', to: '2026-10-31' }, NOW);
    expect(out).toMatchObject({ data: { from: '2026-10-01', to: '2026-10-31', total: { up: 3, savedMinutes: 40 } } });
    expect(feedback.loadFeedbackSummary).toHaveBeenCalledWith({ organizationId: 'o1', departmentIds: ['d1', 'd2'] }, expect.objectContaining({ fromIso: '2026-10-01T00:00:00+09:00', toIso: '2026-11-01T00:00:00+09:00' }));
  });
  it('비우면 최근 30일, 틀린 날짜·1년 넘음은 400(읽지 않음)', async () => {
    expect(await feedbackSummaryReport(ctx, { from: null, to: null }, NOW)).toMatchObject({ data: { from: '2026-10-13', to: '2026-11-11' } });
    expect(await feedbackSummaryReport(ctx, { from: '2026-13-01', to: null }, NOW)).toMatchObject({ status: 400 });
    expect(await feedbackSummaryReport(ctx, { from: null, to: '2026-02-30' }, NOW)).toMatchObject({ status: 400 });
    expect(await feedbackSummaryReport(ctx, { from: '2024-01-01', to: '2026-01-01' }, NOW)).toMatchObject({ status: 400 });
    expect(feedback.loadFeedbackSummary).toHaveBeenCalledTimes(1);
  });
});

describe('앱 실행 현황', () => {
  it('관리자 화면과 같은 읽기 함수(기관·키 범위 부서)', async () => {
    expect(await appRunsReport(ctx, NOW)).toMatchObject({ data: { days: 30, apps: [] } });
    expect(runs.loadAppRunOverview).toHaveBeenCalledWith('o1', ['d1', 'd2'], NOW);
  });
});

describe('예산 소진 현황', () => {
  it('기관(단위 표시)·키 범위 부서만·집계 못 한 부서 수 — 개인 한도·직원은 없음', async () => {
    const out = await budgetReport(ctx) as { data: Record<string, unknown> };
    expect(out.data).toEqual({
      organization: { kind: 'annual_budget', unit: 'krw', used: 1_200_000, limit: 10_000_000, percent: 12, alertPercent: 80, periodEndsAt: '2026-12-31T15:00:00Z' },
      departments: [{ departmentId: 'd1', name: '민원과', usedKrw: 50_000, limitKrw: 100_000, percent: 50 }],
      departmentsFailed: 1,
    });
    expect(JSON.stringify(out)).not.toContain('periodKey');
  });
  it('종량제는 토큰, 한도가 없으면 null', async () => {
    budget.organizationBudgetStatus.mockResolvedValueOnce({ kind: 'monthly_tokens', periodKey: 'month:2026-11', used: 10, limit: 100, percent: 10, alertPercent: 80, periodEndsAt: null });
    expect(((await budgetReport(ctx)) as { data: { organization: { unit: string } } }).data.organization.unit).toBe('tokens');
    budget.organizationBudgetStatus.mockResolvedValueOnce(null);
    expect(((await budgetReport(ctx)) as { data: { organization: unknown } }).data.organization).toBeNull();
  });
});

describe('연결(원본)', () => {
  it('관리자 앱 실행 현황 라우트도 같은 읽기 함수를 쓴다', () => {
    const route = readFileSync('src/app/api/admin/app-overview/route.ts', 'utf8');
    expect(route).toContain('loadAppRunOverview(actor.organizationId, actor.managedDepartmentIds)');
    expect(route).not.toContain("rpc('app_run_states'");
  });
  it('0086은 호출 기록 CHECK만 넓힌다', () => {
    const sql = readFileSync('supabase/migrations/0086_org_api_more_endpoints.sql', 'utf8');
    expect(sql).toContain("'feedback-summary', 'app-runs', 'budget'");
    expect(sql).not.toContain('ALTER TABLE public.org_api_keys ');
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('호출 기록 CHECK (0086, 시험 DB)', () => {
  let db: pg.Client;
  const orgId = randomUUID(); const deptId = randomUUID(); const userId = randomUUID();
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
    const sql = readFileSync('supabase/migrations/0086_org_api_more_endpoints.sql', 'utf8');
    await db.query(sql);
    await db.query(sql);
  });
  afterAll(async () => { await db?.end(); });
  it('새 끝점 셋은 받고 모르는 끝점은 거절', async () => {
    await db.query('BEGIN');
    try {
      await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, '0086 기관']);
      await db.query('INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)', [deptId, '기획', `d86-${deptId.slice(0, 6)}`, orgId]);
      await db.query('INSERT INTO users (id, email, department_id) VALUES ($1, $2, $3)', [userId, `${userId}@test.local`, deptId]);
      const { rows: [k] } = await db.query(
        `INSERT INTO org_api_keys (organization_id, created_by, name, token_hash, token_prefix, scopes, expires_at) VALUES ($1, $2, '대시보드', $3, 'wo_api_abcde', ARRAY['usage'], now() + interval '30 days') RETURNING id`,
        [orgId, userId, 'a'.repeat(64)],
      );
      for (const e of ['feedback-summary', 'app-runs', 'budget', 'usage-summary']) {
        await db.query('INSERT INTO org_api_key_calls (key_id, organization_id, endpoint, http_status) VALUES ($1, $2, $3, 200)', [k.id, orgId, e]);
      }
      await db.query('SAVEPOINT s');
      await expect(db.query('INSERT INTO org_api_key_calls (key_id, organization_id, endpoint, http_status) VALUES ($1, $2, $3, 200)', [k.id, orgId, 'users'])).rejects.toThrow(/check/i);
      await db.query('ROLLBACK TO SAVEPOINT s');
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
