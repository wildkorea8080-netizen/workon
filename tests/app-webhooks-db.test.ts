import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { generateWebhookToken } from '@/lib/apps/webhooks';

/**
 * 앱 연동 표·차지 함수(0049)를 실제 Postgres에서 — 시험 DB(`npm run work:testdb -- start`)가 있을 때만.
 * 보는 것: 무효(없음·회수·만료)는 한 사유, 60초 간격·하루 상한(한국 날짜), 동시 호출은 하나만, CHECK, anon·authenticated는 함수·표를 못 씀
 */
const url = process.env.WORK_TEST_DATABASE_URL;

describe.skipIf(!url)('앱 연동 DB (0049)', () => {
  let db: pg.Client;
  const orgId = randomUUID(); const deptId = randomUUID(); const userId = randomUUID(); const agentId = randomUUID();

  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
    await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, `기관-${orgId.slice(0, 6)}`]);
    await db.query('INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)', [deptId, '민원과', `d-${deptId.slice(0, 8)}`, orgId]);
    await db.query('INSERT INTO users (id, email, department_id) VALUES ($1, $2, $3)', [userId, `${userId}@test.local`, deptId]);
    await db.query('INSERT INTO agents (id, name, department_id, organization_id, tier, visibility, is_published) VALUES ($1, $2, $3, $4, $5, $6, true)', [agentId, '민원 앱', deptId, orgId, 'official', 'organization']);
  });
  afterAll(async () => {
    await db?.query('DELETE FROM app_webhooks WHERE organization_id = $1', [orgId]);
    await db?.query('DELETE FROM agents WHERE department_id = $1', [deptId]);
    await db?.query('DELETE FROM users WHERE id = $1', [userId]);
    await db?.query('DELETE FROM departments WHERE id = $1', [deptId]);
    await db?.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    await db?.end();
  });

  async function hook(patch: { status?: string; revoked_at?: string | null; expires_at?: string; created_at?: string } = {}) {
    const t = generateWebhookToken();
    await db.query(
      `INSERT INTO app_webhooks (agent_id, user_id, department_id, organization_id, app_version, name, token_hash, token_prefix, status, revoked_at, expires_at, created_at)
       VALUES ($1, $2, $3, $4, 3, '민원 시스템', $5, $6, $7, $8, $9, $10)`,
      [agentId, userId, deptId, orgId, t.hash, t.prefix, patch.status ?? 'active', patch.revoked_at ?? null, patch.expires_at ?? '2026-12-31T00:00:00Z', patch.created_at ?? '2026-11-01T00:00:00Z'],
    );
    return t.hash;
  }
  const claim = async (hash: string, now: string, interval = 60, daily = 100) =>
    (await db.query('SELECT app_webhook_claim($1, $2, $3, $4) AS r', [hash, now, interval, daily])).rows[0].r as Record<string, unknown>;

  it('없는·회수·만료 토큰은 모두 invalid 하나로, 유효하면 연동 정보를 돌려주고 사용 기록을 올린다', async () => {
    expect(await claim('0'.repeat(64), '2026-11-03T00:00:00Z')).toEqual({ ok: false, reason: 'invalid' });
    expect(await claim(await hook({ status: 'revoked', revoked_at: '2026-11-02T00:00:00Z' }), '2026-11-03T00:00:00Z')).toEqual({ ok: false, reason: 'invalid' });
    expect(await claim(await hook({ expires_at: '2026-11-02T00:00:00Z' }), '2026-11-03T00:00:00Z')).toEqual({ ok: false, reason: 'invalid' });
    const h = await hook();
    const r = await claim(h, '2026-11-03T00:00:00Z');
    expect(r).toMatchObject({ ok: true, webhook: { agent_id: agentId, user_id: userId, department_id: deptId, organization_id: orgId, app_version: 3 } });
    const { rows: [row] } = await db.query('SELECT use_count, day_count, day_key::text, last_used_at FROM app_webhooks WHERE token_hash = $1', [h]);
    expect(row).toMatchObject({ use_count: 1, day_count: 1, day_key: '2026-11-03' });
  });

  it('60초 안의 둘째 호출은 too_soon(남은 초), 지나면 통과. 하루 상한은 한국 날짜로 세고 다음 날 0부터', async () => {
    const h = await hook();
    expect((await claim(h, '2026-11-03T01:00:00Z')).ok).toBe(true);
    expect(await claim(h, '2026-11-03T01:00:20Z')).toEqual({ ok: false, reason: 'too_soon', retry_after: 40 });
    expect((await claim(h, '2026-11-03T01:01:01Z')).ok).toBe(true);
    // 상한 2: 셋째는 같은 날 거절
    const d = await hook();
    expect((await claim(d, '2026-11-03T02:00:00Z', 1, 2)).ok).toBe(true);
    expect((await claim(d, '2026-11-03T02:00:05Z', 1, 2)).ok).toBe(true);
    expect(await claim(d, '2026-11-03T02:00:10Z', 1, 2)).toEqual({ ok: false, reason: 'daily_limit' });
    // UTC 15:00 = 한국 자정 — 날이 바뀌면 다시 센다
    expect((await claim(d, '2026-11-03T15:00:01Z', 1, 2)).ok).toBe(true);
    const { rows: [row] } = await db.query('SELECT day_count, day_key::text FROM app_webhooks WHERE token_hash = $1', [d]);
    expect(row).toEqual({ day_count: 1, day_key: '2026-11-04' });
  });

  it('같은 토큰을 동시에 부르면 하나만 통과한다(행 잠금)', async () => {
    const h = await hook();
    const others = await Promise.all([0, 1, 2].map(async () => { const c = new pg.Client({ connectionString: url }); await c.connect(); return c; }));
    try {
      const results = await Promise.all(others.map(c => c.query('SELECT app_webhook_claim($1, $2, 60, 100) AS r', [h, '2026-11-03T03:00:00Z']).then(r => r.rows[0].r)));
      expect(results.filter(r => r.ok)).toHaveLength(1);
      expect(results.filter(r => r.reason === 'too_soon')).toHaveLength(2);
    } finally { await Promise.all(others.map(c => c.end())); }
  });

  it('CHECK: 해시 꼴·회수 짝·이름 길이·만료가 만든 때 뒤', async () => {
    const base = [agentId, userId, deptId, orgId];
    const insert = (hash: string, status: string, revoked: string | null, name: string, expires: string) => db.query(
      `INSERT INTO app_webhooks (agent_id, user_id, department_id, organization_id, app_version, name, token_hash, token_prefix, status, revoked_at, expires_at, created_at)
       VALUES ($1, $2, $3, $4, 1, $5, $6, 'wo_wh_abcdef', $7, $8, $9, '2026-11-01T00:00:00Z')`, [...base, name, hash, status, revoked, expires]);
    await expect(insert('nothex', 'active', null, 'x', '2026-12-01T00:00:00Z')).rejects.toThrow(/check/i);
    await expect(insert('a'.repeat(64), 'revoked', null, 'x', '2026-12-01T00:00:00Z')).rejects.toThrow(/check/i);
    await expect(insert('b'.repeat(64), 'active', '2026-11-02T00:00:00Z', 'x', '2026-12-01T00:00:00Z')).rejects.toThrow(/check/i);
    await expect(insert('c'.repeat(64), 'active', null, 'x'.repeat(41), '2026-12-01T00:00:00Z')).rejects.toThrow(/check/i);
    await expect(insert('d'.repeat(64), 'active', null, 'x', '2026-10-01T00:00:00Z')).rejects.toThrow(/check/i);
  });

  it('anon·authenticated는 표를 못 읽고 차지 함수를 부르지 못한다', async () => {
    const h = await hook();
    for (const role of ['anon', 'authenticated']) {
      await db.query(`SET ROLE ${role}`);
      try {
        expect((await db.query('SELECT 1 FROM app_webhooks')).rowCount).toBe(0);
        await expect(db.query('SELECT app_webhook_claim($1, now(), 60, 100)', [h])).rejects.toMatchObject({ code: '42501' });
      } finally { await db.query('RESET ROLE'); }
    }
  });
});
