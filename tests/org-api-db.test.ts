import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { generateOrgApiToken } from '@/lib/org-api/keys';

/**
 * 기관 통계 API 키 표·차지 함수(0075)를 실제 Postgres에서 — 시험 DB(`npm run work:testdb -- start`)가 있을 때만.
 * 보는 것: 무효(없음·회수·만료)는 한 사유, 하루 상한(한국 날짜)·다음 날 0부터, 동시 호출, CHECK(범위·해시·회수 짝·이름·만료), 호출 기록 CHECK, anon·authenticated는 못 씀
 */
const url = process.env.WORK_TEST_DATABASE_URL;

describe.skipIf(!url)('기관 통계 API 키 DB (0075)', () => {
  let db: pg.Client;
  const orgId = randomUUID(); const deptId = randomUUID(); const userId = randomUUID();

  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
    await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, `기관-${orgId.slice(0, 6)}`]);
    await db.query('INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)', [deptId, '기획조정실', `d-${deptId.slice(0, 8)}`, orgId]);
    await db.query('INSERT INTO users (id, email, department_id) VALUES ($1, $2, $3)', [userId, `${userId}@test.local`, deptId]);
  });
  afterAll(async () => {
    await db?.query('DELETE FROM org_api_keys WHERE organization_id = $1', [orgId]);
    await db?.query('DELETE FROM users WHERE id = $1', [userId]);
    await db?.query('DELETE FROM departments WHERE id = $1', [deptId]);
    await db?.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    await db?.end();
  });

  async function key(patch: { status?: string; revoked_at?: string | null; expires_at?: string; scopes?: string[] } = {}) {
    const t = generateOrgApiToken();
    const { rows: [row] } = await db.query(
      `INSERT INTO org_api_keys (organization_id, created_by, name, token_hash, token_prefix, scopes, status, revoked_at, expires_at, created_at)
       VALUES ($1, $2, '경영정보 대시보드', $3, $4, $5, $6, $7, $8, '2026-11-01T00:00:00Z') RETURNING id`,
      [orgId, userId, t.hash, t.prefix, patch.scopes ?? ['adoption'], patch.status ?? 'active', patch.revoked_at ?? null, patch.expires_at ?? '2026-12-31T00:00:00Z'],
    );
    return { hash: t.hash, id: row.id as string };
  }
  const claim = async (hash: string, now: string, daily = 1000) =>
    (await db.query('SELECT org_api_key_claim($1, $2, $3) AS r', [hash, now, daily])).rows[0].r as Record<string, unknown>;

  it('없는·회수·만료 키는 모두 invalid 하나로, 유효하면 키 정보(범위 포함)를 돌려주고 사용 기록을 올린다', async () => {
    expect(await claim('0'.repeat(64), '2026-11-09T00:00:00Z')).toEqual({ ok: false, reason: 'invalid' });
    expect(await claim((await key({ status: 'revoked', revoked_at: '2026-11-02T00:00:00Z' })).hash, '2026-11-09T00:00:00Z')).toEqual({ ok: false, reason: 'invalid' });
    expect(await claim((await key({ expires_at: '2026-11-02T00:00:00Z' })).hash, '2026-11-09T00:00:00Z')).toEqual({ ok: false, reason: 'invalid' });
    const k = await key({ scopes: ['adoption', 'usage'] });
    expect(await claim(k.hash, '2026-11-09T00:00:00Z')).toEqual({ ok: true, key: { id: k.id, organization_id: orgId, created_by: userId, scopes: ['adoption', 'usage'] } });
    const { rows: [row] } = await db.query('SELECT use_count, day_count, day_key::text FROM org_api_keys WHERE id = $1', [k.id]);
    expect(row).toEqual({ use_count: 1, day_count: 1, day_key: '2026-11-09' });
  });

  it('하루 상한은 한국 날짜로 세고(넘으면 키 id와 함께 daily_limit) 다음 날 0부터', async () => {
    const k = await key();
    expect((await claim(k.hash, '2026-11-09T02:00:00Z', 2)).ok).toBe(true);
    expect((await claim(k.hash, '2026-11-09T02:00:01Z', 2)).ok).toBe(true);
    expect(await claim(k.hash, '2026-11-09T02:00:02Z', 2)).toEqual({ ok: false, reason: 'daily_limit', key_id: k.id, organization_id: orgId });
    // UTC 15:00 = 한국 자정
    expect((await claim(k.hash, '2026-11-09T15:00:01Z', 2)).ok).toBe(true);
    const { rows: [row] } = await db.query('SELECT day_count, day_key::text, use_count FROM org_api_keys WHERE id = $1', [k.id]);
    expect(row).toEqual({ day_count: 1, day_key: '2026-11-10', use_count: 3 });
  });

  it('상한 1에서 동시에 부르면 하나만 통과한다(행 잠금)', async () => {
    const k = await key();
    const others = await Promise.all([0, 1, 2].map(async () => { const c = new pg.Client({ connectionString: url }); await c.connect(); return c; }));
    try {
      const results = await Promise.all(others.map((c) => c.query('SELECT org_api_key_claim($1, $2, 1) AS r', [k.hash, '2026-11-09T03:00:00Z']).then((r) => r.rows[0].r)));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => r.reason === 'daily_limit')).toHaveLength(2);
    } finally { await Promise.all(others.map((c) => c.end())); }
  });

  it('CHECK: 범위(1~2개·정해 둔 값만)·해시 꼴·회수 짝·이름 길이·만료가 만든 때 뒤', async () => {
    const insert = (hash: string, scopes: string[], status = 'active', revoked: string | null = null, name = 'x', expires = '2026-12-01T00:00:00Z') => db.query(
      `INSERT INTO org_api_keys (organization_id, created_by, name, token_hash, token_prefix, scopes, status, revoked_at, expires_at, created_at)
       VALUES ($1, $2, $3, $4, 'wo_api_abcde', $5, $6, $7, $8, '2026-11-01T00:00:00Z')`, [orgId, userId, name, hash, scopes, status, revoked, expires]);
    await expect(insert('a'.repeat(64), [])).rejects.toThrow(/check/i);
    await expect(insert('b'.repeat(64), ['users'])).rejects.toThrow(/check/i);
    await expect(insert('c'.repeat(64), ['adoption', 'usage', 'adoption'])).rejects.toThrow(/check/i);
    await expect(insert('nothex', ['adoption'])).rejects.toThrow(/check/i);
    await expect(insert('d'.repeat(64), ['adoption'], 'revoked', null)).rejects.toThrow(/check/i);
    await expect(insert('e'.repeat(64), ['adoption'], 'active', null, 'x'.repeat(41))).rejects.toThrow(/check/i);
    await expect(insert('f'.repeat(64), ['adoption'], 'active', null, 'x', '2026-10-01T00:00:00Z')).rejects.toThrow(/check/i);
  });

  it('호출 기록: 정해 둔 끝점·상태 코드만, 키를 지우면 함께 지워진다', async () => {
    const k = await key();
    await db.query('INSERT INTO org_api_key_calls (key_id, organization_id, endpoint, http_status) VALUES ($1, $2, $3, 200)', [k.id, orgId, 'usage-summary']);
    await expect(db.query('INSERT INTO org_api_key_calls (key_id, organization_id, endpoint, http_status) VALUES ($1, $2, $3, 200)', [k.id, orgId, 'users'])).rejects.toThrow(/check/i);
    await expect(db.query('INSERT INTO org_api_key_calls (key_id, organization_id, endpoint, http_status) VALUES ($1, $2, $3, 42)', [k.id, orgId, 'usage-summary'])).rejects.toThrow(/check/i);
    await db.query('DELETE FROM org_api_keys WHERE id = $1', [k.id]);
    expect((await db.query('SELECT 1 FROM org_api_key_calls WHERE key_id = $1', [k.id])).rowCount).toBe(0);
  });

  it('anon·authenticated는 표를 못 읽고 차지 함수를 부르지 못한다', async () => {
    const k = await key();
    for (const role of ['anon', 'authenticated']) {
      await db.query(`SET ROLE ${role}`);
      try {
        expect((await db.query('SELECT 1 FROM org_api_keys')).rowCount).toBe(0);
        expect((await db.query('SELECT 1 FROM org_api_key_calls')).rowCount).toBe(0);
        await expect(db.query('SELECT org_api_key_claim($1, now(), 1000)', [k.hash])).rejects.toMatchObject({ code: '42501' });
      } finally { await db.query('RESET ROLE'); }
    }
  });
});
