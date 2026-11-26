// tests/batch-0320.test.ts
// 자료함 내용 찾기 100,000자(2026-11-26, 0127) — 20,000자 밖의 낱말로도 찾고, 20,000자에서 잘렸을 파일은 다시 읽게 한다.
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { LIBRARY_CONTENT_MAX, LIBRARY_CONTENT_SEARCH_NOTE, libraryContentText, librarySnippet } from '@/lib/my-library-spec';

describe('담아 두는 글', () => {
  it('100,000자까지 — 20,000자 뒤의 낱말도 남고 찾기 자리가 보인다', () => {
    expect(LIBRARY_CONTENT_MAX).toBe(100_000);
    expect(LIBRARY_CONTENT_SEARCH_NOTE).toContain('100,000자');
    const long = `${'가'.repeat(50_000)} 국외출장 숙박비 기준 ${'나'.repeat(80_000)}`;
    const kept = libraryContentText(long)!;
    expect(Array.from(kept)).toHaveLength(LIBRARY_CONTENT_MAX);
    expect(kept).toContain('국외출장 숙박비');
    expect(librarySnippet(kept, '보고서.hwpx', '숙박비')?.hit).toBe('숙박비');
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0127 — CHECK 넓힘·잘렸을 파일 다시 읽게(시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });

  it('100,000자 받고 100,001자 거절, 19,990~20,000자 파일만 확인 안 함으로 — 두 번 적용해도 같음', async () => {
    const sql = readFileSync('supabase/migrations/0127_library_content_100k.sql', 'utf8');
    await db.query('BEGIN');
    try {
      const org = randomUUID(); const dept = randomUUID(); const user = randomUUID();
      await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [org, '0127 기관']);
      await db.query("INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, '총무과', $2, $3)", [dept, `d-${dept.slice(0, 8)}`, org]);
      await db.query("INSERT INTO users (id, email, role, department_id) VALUES ($1, $2, 'USER', $3)", [user, `${user}@x.test`, dept]);
      const file = (content: string | null) => db.query(
        "INSERT INTO my_library_files (user_id, organization_id, space, folder, file_name, size_bytes, storage_path, source, content_text, content_checked_at) VALUES ($1, $2, 'personal', '', '서식.xlsx', 1, $3, 'attachment', $4, now()) RETURNING id",
        [user, org, `my-library/${randomUUID()}`, content]);
      const cut = await file('가'.repeat(20_000));
      const nearCut = await file('가'.repeat(19_995));
      const short = await file('짧은 글');
      const big = await file('가'.repeat(LIBRARY_CONTENT_MAX));
      await db.query('SAVEPOINT s');
      await expect(file('가'.repeat(LIBRARY_CONTENT_MAX + 1))).rejects.toThrow(/check/i);
      await db.query('ROLLBACK TO SAVEPOINT s');
      await db.query(sql); await db.query(sql);
      const rows = await db.query('SELECT id, content_checked_at FROM my_library_files WHERE user_id = $1', [user]);
      const checked = new Map(rows.rows.map((r) => [r.id, r.content_checked_at !== null]));
      expect(checked.get(cut.rows[0].id)).toBe(false);
      expect(checked.get(nearCut.rows[0].id)).toBe(false);
      expect(checked.get(short.rows[0].id)).toBe(true);
      expect(checked.get(big.rows[0].id)).toBe(true);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
