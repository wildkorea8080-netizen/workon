import { readdirSync, readFileSync } from 'fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * 2026-11-16 — 운영 스키마와 코드가 어긋난 두 곳(0097). 코드가 쓰는 users.password_hash를 만드는 마이그레이션이 없었고,
 * 0002의 security_logs가 운영 DB에 없었다. 다시 생기지 않게 '코드가 쓰는 것을 마이그레이션이 만든다'를 고정한다.
 */

const migrations = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).map((f) => readFileSync(`supabase/migrations/${f}`, 'utf8')).join('\n');

describe('코드가 쓰는 칸·표를 마이그레이션이 만든다', () => {
  it('users.password_hash', () => {
    expect(readFileSync('src/lib/nextAuthOptions.ts', 'utf8')).toContain('password_hash');
    expect(migrations).toMatch(/ALTER TABLE public\.users ADD COLUMN IF NOT EXISTS password_hash text/);
  });
  it('security_logs — 운영에 없어 0097이 IF NOT EXISTS로 다시 만든다(RLS·공개 키 권한 없음)', () => {
    const sql = readFileSync('supabase/migrations/0097_schema_drift_auth.sql', 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.security_logs');
    expect(sql).toContain('ALTER TABLE public.security_logs ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain("REVOKE ALL ON public.security_logs FROM anon");
    // 코드가 넣는 칸이 모두 있다
    for (const col of ['department_id', 'user_id', 'event_type', 'details', 'severity', 'created_at']) expect(sql).toContain(`  ${col} `);
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('0097 (시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
    const sql = readFileSync('supabase/migrations/0097_schema_drift_auth.sql', 'utf8');
    await db.query(sql);
    await db.query(sql);
  });
  afterAll(async () => { await db?.end(); });
  it('users.password_hash 칸·security_logs 표(RLS)', async () => {
    const col = await db.query(`SELECT data_type FROM information_schema.columns WHERE table_name='users' AND column_name='password_hash'`);
    expect(col.rows).toEqual([{ data_type: 'text' }]);
    const rls = await db.query(`SELECT relrowsecurity FROM pg_class WHERE oid='public.security_logs'::regclass`);
    expect(rls.rows[0].relrowsecurity).toBe(true);
  });
});
