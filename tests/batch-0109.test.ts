import { readFileSync } from 'fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));

import { recordSignIn, type SignInRecordDeps } from '@/lib/sign-in-record';

/** 2026-11-16 — 직원 로그인 성공·실패·잠김·거절을 접속 기록으로(0094). 예전엔 슈퍼관리자 로그인만 남았다 */

const UID = '11111111-2222-3333-4444-555555555555';
const DEPT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ORG = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const NOW = new Date('2026-11-16T10:00:00Z');

function deps(o: { found?: boolean; insertFails?: boolean } = {}) {
  const rows: Record<string, unknown>[] = [];
  const touched: string[] = [];
  const d: SignInRecordDeps = {
    findUser: vi.fn(async () => (o.found === false ? null : { id: UID, departmentId: DEPT, orgId: ORG })),
    orgOf: vi.fn(async () => ORG),
    insert: vi.fn(async (r) => { if (o.insertFails) throw new Error('db'); rows.push(r); }),
    touchLastSignIn: vi.fn(async (id, at) => { touched.push(`${id}@${at}`); }),
  };
  return { d, rows, touched };
}

describe('접속 기록', () => {
  it('성공 — 그 사람·부서·기관으로 남기고 마지막 로그인을 적는다', async () => {
    const { d, rows, touched } = deps();
    await recordSignIn(d, { outcome: 'login', email: 'a@x.go.kr', ip: '1.2.3.4', userAgent: 'UA', user: { id: UID, departmentId: DEPT }, now: NOW });
    expect(rows).toEqual([{
      user_id: UID, department_id: DEPT, org_id: ORG, action: 'login', path: '/login', ip_address: '1.2.3.4',
      user_agent: 'UA', status_code: 200, details: {}, created_at: NOW.toISOString(),
    }]);
    expect(touched).toEqual([`${UID}@${NOW.toISOString()}`]);
    expect(d.findUser).not.toHaveBeenCalled();
  });
  it('실패 — 계정이 있으면 그 사람으로(이메일은 남기지 않음), 마지막 로그인은 그대로', async () => {
    const { d, rows, touched } = deps();
    await recordSignIn(d, { outcome: 'login_failed', email: ' A@X.go.kr ', ip: null, now: NOW });
    expect(d.findUser).toHaveBeenCalledWith('a@x.go.kr');
    expect(rows[0]).toMatchObject({ user_id: UID, department_id: DEPT, action: 'login_failed', status_code: 401 });
    expect(JSON.stringify(rows[0])).not.toContain('x.go.kr');
    expect(touched).toEqual([]);
  });
  it('없는 계정 — 사람 없이 시각·IP만', async () => {
    const { d, rows } = deps({ found: false });
    await recordSignIn(d, { outcome: 'login_failed', email: 'nobody@x.go.kr', ip: '9.9.9.9', now: NOW });
    expect(rows[0]).toMatchObject({ user_id: null, department_id: null, org_id: null, ip_address: '9.9.9.9' });
    expect(JSON.stringify(rows[0])).not.toContain('nobody');
  });
  it('잠김 429·거절 403, 긴 브라우저 정보는 300자', async () => {
    const { d, rows } = deps();
    await recordSignIn(d, { outcome: 'login_locked', email: 'a@x.go.kr', ip: null, userAgent: 'x'.repeat(500), now: NOW });
    await recordSignIn(d, { outcome: 'login_rejected', email: 'a@x.go.kr', ip: null, user: { id: UID, departmentId: null }, now: NOW });
    expect(rows.map((r) => r.status_code)).toEqual([429, 403]);
    expect(String(rows[0].user_agent)).toHaveLength(300);
    expect(rows[1]).toMatchObject({ department_id: null, org_id: null });
  });
  it('기록 실패는 던지지 않는다(로그인을 막지 않음)', async () => {
    await expect(recordSignIn(deps({ insertFails: true }).d, { outcome: 'login', email: 'a', ip: null, user: { id: UID, departmentId: DEPT } })).resolves.toBeUndefined();
  });
});

describe('연결(원본)', () => {
  const auth = readFileSync('src/lib/nextAuthOptions.ts', 'utf8');
  it('직원 로그인 — 잠김·실패·성공(두 길)·거절을 남긴다', () => {
    expect(auth.indexOf("await record('login_locked');")).toBeLessThan(auth.indexOf('throw new Error(ACCOUNT_LOCKED);'));
    expect(auth).toContain("await record('login_failed');");
    expect(auth).toContain("await record('login', { id: local.id, departmentId: local.departmentId ?? null });");
    expect(auth).toContain("await record('login', { id: authUser.id, departmentId: decision.departmentId });");
    expect(auth.match(/await record\('login_rejected'/g)).toHaveLength(2);
  });
  it('감사 화면 — 접속 기록을 관리 범위 부서로, CSV 이름', () => {
    const route = readFileSync('src/app/api/admin/audit-logs/route.ts', 'utf8');
    expect(route).toContain("kind === 'access' ? 'access_logs'");
    expect(route).toContain(".in('department_id', managedDeptIds)");
    expect(route).toContain("login_failed: '로그인 실패'");
    expect(route).toContain("kind === 'access' ? '접속'");
    expect(readFileSync('src/components/admin/AuditLogsManager.tsx', 'utf8')).toContain('<option value="access">접속 기록(로그인)</option>');
  });
  it('사용자 목록 — 마지막 로그인', () => {
    expect(readFileSync('src/app/api/users/route.ts', 'utf8')).toContain('last_sign_in_at');
    expect(readFileSync('src/components/admin/UsersManager.tsx', 'utf8')).toContain('user.last_sign_in_at');
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('0094 접속 기록 칸 (시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
    const sql = readFileSync('supabase/migrations/0094_sign_in_records.sql', 'utf8');
    await db.query(sql);
    await db.query(sql);
  });
  afterAll(async () => { await db?.end(); });
  it('access_logs.department_id(부서 외래 키·지우면 비움)·색인, users.last_sign_in_at', async () => {
    const cols = await db.query(`SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE (table_name='access_logs' AND column_name='department_id') OR (table_name='users' AND column_name='last_sign_in_at') ORDER BY table_name`);
    expect(cols.rows).toEqual([
      { table_name: 'access_logs', column_name: 'department_id', data_type: 'uuid' },
      { table_name: 'users', column_name: 'last_sign_in_at', data_type: 'timestamp with time zone' },
    ]);
    const fk = await db.query(`SELECT confdeltype FROM pg_constraint WHERE conrelid='public.access_logs'::regclass AND contype='f' AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.access_logs'::regclass AND attname='department_id')]::smallint[]`);
    expect(fk.rows[0].confdeltype).toBe('n');
    const idx = await db.query(`SELECT 1 FROM pg_indexes WHERE indexname='access_logs_department_created_idx'`);
    expect(idx.rowCount).toBe(1);
  });
});
