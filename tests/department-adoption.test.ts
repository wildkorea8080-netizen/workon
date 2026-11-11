import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import pg from 'pg';

/** 부서별 도입 현황(2026-11-05, 0065) — 부서마다 자기 부서 기록만, 숫자만, 합계·CSV */

const state = vi.hoisted(() => ({ admin: true, rpc: { data: [] as unknown, error: null as { message: string } | null }, calls: [] as unknown[][] }));
vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => ({ user: { id: 'me' } }), isAdminSession: () => state.admin }));
vi.mock('@/lib/actor-scope', () => ({ getActorScope: async () => ({ userId: 'me', isAdmin: true, organizationId: 'org', departmentId: 'd1', visibleDepartmentIds: ['d1'], managedDepartmentIds: ['d1', 'd2'], managesWholeOrganization: false }) }));
vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: { rpc: async (...args: unknown[]) => { state.calls.push(args); return state.rpc; } } }));

import { NextRequest } from 'next/server';
import { departmentAdoptionCsv, departmentTotals, hasActivity, readDepartmentAdoption, type DepartmentAdoption } from '@/lib/department-adoption';
import { GET } from '@/app/api/admin/adoption-report/departments/route';
import { DepartmentAdoptionTable } from '@/components/admin/DepartmentAdoption';

const row = (over: Partial<DepartmentAdoption>): DepartmentAdoption => ({ departmentId: 'd', name: '총무과', registered_users: 0, active_users: 0, regular_users: 0, chat_messages: 0, app_runs: 0, documents_generated: 0, tasks_completed: 0, cost_krw: 0, saved_minutes: 0, ...over });

beforeEach(() => { state.admin = true; state.rpc = { data: [], error: null }; state.calls = []; });

describe('부서별 숫자', () => {
  it('DB 응답을 믿지 않고 다시 만든다 — 배열 아님·id 없음은 버리고, 이상한 숫자는 0, 금액은 원 단위로', () => {
    expect(readDepartmentAdoption(null)).toEqual([]);
    expect(readDepartmentAdoption({})).toEqual([]);
    const rows = readDepartmentAdoption([null, { name: 'x' }, { department_id: 'd1', name: '', chat_messages: '12', cost_krw: 1234.6, active_users: -3, app_runs: 'abc' }]);
    expect(rows).toEqual([row({ departmentId: 'd1', name: '(이름 없음)', chat_messages: 12, cost_krw: 1235 })]);
  });

  it('합계·기록 있는 부서 가르기', () => {
    const rows = [row({ departmentId: 'a', registered_users: 5, active_users: 3, chat_messages: 10 }), row({ departmentId: 'b', registered_users: 2 })];
    expect(departmentTotals(rows)).toMatchObject({ registered_users: 7, active_users: 3, chat_messages: 10 });
    expect(rows.map(hasActivity)).toEqual([true, false]);
  });

  it('CSV — BOM·제목 줄·머리·부서 줄·합계, 부서 이름의 수식 글자는 막는다', () => {
    const csv = departmentAdoptionCsv('2026-11', [row({ name: '=HYPERLINK("x")', chat_messages: 3, cost_krw: 1500 }), row({ name: '기획과', chat_messages: 2 })]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\n');
    expect(lines[0]).toBe('2026-11 부서별 도입 현황');
    expect(lines[1]).toBe('부서,등록 직원,쓴 직원,4일 이상 쓴 직원,질문,앱 실행,만든 파일,업무 작업 완료,사용 금액(원),줄인 시간(분·자기 신고)');
    expect(lines[2].startsWith(`"'=HYPERLINK(""x"")"`)).toBe(true);
    expect(lines[4]).toBe('합계,0,0,0,5,0,0,0,1500,0');
  });

  it('표 — 기록 있는 부서 먼저, 끝 줄 합계', () => {
    const html = renderToStaticMarkup(createElement(DepartmentAdoptionTable, { rows: [row({ departmentId: 'a', name: '조용한과', registered_users: 4 }), row({ departmentId: 'b', name: '바쁜과', chat_messages: 1200 })] }));
    expect(html.indexOf('바쁜과')).toBeLessThan(html.indexOf('조용한과'));
    expect(html).toContain('1,200');
    expect(html).toContain('합계');
  });
});

describe('라우트', () => {
  it('관리자만, 달 꼴·미래 달 거절, 관리 범위로 DB 함수를 부른다', async () => {
    state.admin = false;
    expect((await GET(new NextRequest('http://localhost/api/admin/adoption-report/departments'))).status).toBe(403);
    state.admin = true;
    expect((await GET(new NextRequest('http://localhost/api/admin/adoption-report/departments?month=2026-13'))).status).toBe(400);
    expect((await GET(new NextRequest('http://localhost/api/admin/adoption-report/departments?month=2999-01'))).status).toBe(400);
    state.rpc = { data: [{ department_id: 'd1', name: '총무과', chat_messages: 4 }], error: null };
    const res = await GET(new NextRequest('http://localhost/api/admin/adoption-report/departments?month=2026-10'));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ month: '2026-10', partial: false, departments: [{ departmentId: 'd1', chat_messages: 4 }] });
    expect(state.calls[0]).toEqual(['adoption_by_department', { p_organization_id: 'org', p_department_ids: ['d1', 'd2'], p_from: '2026-09-30T15:00:00.000Z', p_to: '2026-10-31T15:00:00.000Z' }]);
    state.rpc = { data: null, error: { message: 'missing function' } };
    expect((await GET(new NextRequest('http://localhost/api/admin/adoption-report/departments?month=2026-10'))).status).toBe(500);
  });

  it('월별 보고서 화면이 부서별 보기를 단다', () => {
    expect(readFileSync('src/components/admin/AdoptionReport.tsx', 'utf8')).toContain('<DepartmentAdoption month={report.month} />');
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('부서별 집계 (0065, 시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });

  it('부서마다 자기 기록만(하위 부서를 올려 더하지 않음)·기간 밖 제외·숫자 아닌 금액 0·다른 기관 부서는 빠짐', async () => {
    const sql = readFileSync('supabase/migrations/0065_adoption_by_department.sql', 'utf8');
    await db.query(sql);
    await db.query(sql);
    await db.query('BEGIN');
    try {
      const org = (await db.query("INSERT INTO organizations (name) VALUES ('부서별 시험 기관') RETURNING id")).rows[0].id;
      const other = (await db.query("INSERT INTO organizations (name) VALUES ('다른 기관') RETURNING id")).rows[0].id;
      const parent = (await db.query("INSERT INTO departments (name, slug, organization_id) VALUES ('본부', 'adopt-p', $1) RETURNING id", [org])).rows[0].id;
      const child = (await db.query("INSERT INTO departments (name, slug, organization_id, parent_id) VALUES ('총무과', 'adopt-c', $1, $2) RETURNING id", [org, parent])).rows[0].id;
      const foreign = (await db.query("INSERT INTO departments (name, slug, organization_id) VALUES ('남의과', 'adopt-f', $1) RETURNING id", [other])).rows[0].id;
      const u1 = (await db.query("INSERT INTO users (email, department_id, is_active) VALUES ('adopt1@test.invalid', $1, true) RETURNING id", [child])).rows[0].id;
      await db.query("INSERT INTO users (email, department_id, is_active) VALUES ('adopt2@test.invalid', $1, true)", [parent]);
      const log = (dept: string, user: string | null, action: string, at: string, details: unknown) =>
        db.query('INSERT INTO usage_logs (department_id, user_id, action, created_at, details) VALUES ($1, $2, $3, $4, $5)', [dept, user, action, at, JSON.stringify(details)]);
      await log(child, u1, 'chat_message', '2026-10-03T01:00:00Z', { cost_krw: 100 });
      await log(child, u1, 'chat_message', '2026-10-04T01:00:00Z', { cost_krw: 'abc' });
      await log(child, u1, 'document_generated', '2026-10-05T01:00:00Z', {});
      await log(child, u1, 'chat_message', '2026-11-02T01:00:00Z', { cost_krw: 999 });
      await log(foreign, null, 'chat_message', '2026-10-03T01:00:00Z', { cost_krw: 5 });
      const { rows } = await db.query("SELECT adoption_by_department($1, $2, '2026-09-30T15:00:00Z', '2026-10-31T15:00:00Z') AS r", [org, [parent, child, foreign]]);
      const out = rows[0].r as Record<string, unknown>[];
      expect(out.map((d) => d.name)).toEqual(['본부', '총무과']);
      const c = out.find((d) => d.name === '총무과')!;
      expect(c).toMatchObject({ registered_users: 1, active_users: 1, regular_users: 0, chat_messages: 2, documents_generated: 1, app_runs: 0, tasks_completed: 0 });
      expect(Number(c.cost_krw)).toBe(100);
      expect(out.find((d) => d.name === '본부')).toMatchObject({ registered_users: 1, active_users: 0, chat_messages: 0 });
    } finally {
      await db.query('ROLLBACK');
    }
  });

  it('실행 권한은 service_role만', async () => {
    const { rows } = await db.query("SELECT has_function_privilege('anon', 'public.adoption_by_department(uuid, uuid[], timestamptz, timestamptz)', 'EXECUTE') AS anon");
    expect(rows[0].anon).toBe(false);
  });
});
