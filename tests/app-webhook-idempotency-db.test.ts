import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { generateWebhookToken } from '@/lib/apps/webhooks';

/**
 * 0051(연동 재시도 중복 막기)을 실제 Postgres에서 — 시험 DB(`npm run work:testdb -- start`)가 있을 때만.
 * 보는 것: 옛 4인자 호출 그대로, 같은 키 다시 보내기는 처음 응답·사용 횟수·간격을 안 씀, 입력이 다르면 key_mismatch,
 * 처리 중 in_progress·10분 넘은 running은 새로 받음, 24시간 뒤 키 재사용, 동시 재시도는 하나만 running, 무효 토큰은 키가 있어도 invalid, 다시 적용 안전
 */
const url = process.env.WORK_TEST_DATABASE_URL;
const H1 = 'a'.repeat(64); const H2 = 'b'.repeat(64);

describe.skipIf(!url)('앱 연동 재시도 중복 막기 DB (0051)', () => {
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

  const hook = async (status = 'active') => {
    const t = generateWebhookToken();
    await db.query(
      `INSERT INTO app_webhooks (agent_id, user_id, department_id, organization_id, app_version, name, token_hash, token_prefix, status, revoked_at, expires_at, created_at)
       VALUES ($1, $2, $3, $4, 1, '민원 시스템', $5, $6, $7, $8, '2026-12-31T00:00:00Z', '2026-11-01T00:00:00Z')`,
      [agentId, userId, deptId, orgId, t.hash, t.prefix, status, status === 'revoked' ? '2026-11-02T00:00:00Z' : null]);
    return t.hash;
  };
  const claim = async (hash: string, now: string, key: string | null = null, reqHash: string | null = null, client: pg.Client = db) =>
    (await client.query('SELECT app_webhook_claim($1, $2, 60, 100, $3, $4) AS r', [hash, now, key, reqHash])).rows[0].r as Record<string, any>;
  const useCount = async (hash: string) => (await db.query('SELECT use_count FROM app_webhooks WHERE token_hash = $1', [hash])).rows[0].use_count as number;
  const finish = (callId: string, status: number, conversation: string | null, message: string | null) =>
    db.query(`UPDATE app_webhook_calls SET status = 'done', http_status = $2, conversation_id = $3, message = $4 WHERE id = $1`, [callId, status, conversation, message]);

  it('다시 적용해도 안전하고 옛 4인자 호출도 그대로 돈다', async () => {
    await db.query(readFileSync('supabase/migrations/0051_app_webhook_idempotency.sql', 'utf8'));
    const h = await hook();
    const r = (await db.query('SELECT app_webhook_claim($1, $2, 60, 100) AS r', [h, '2026-11-03T00:00:00Z'])).rows[0].r;
    expect(r).toMatchObject({ ok: true, call_id: null, webhook: { agent_id: agentId } });
  });

  it('같은 키·같은 입력은 처음 응답을 돌려주고 사용 횟수·간격을 쓰지 않는다. 입력이 다르면 key_mismatch', async () => {
    const h = await hook();
    const first = await claim(h, '2026-11-03T01:00:00Z', 'order-1', H1);
    expect(first.ok).toBe(true); expect(first.call_id).toEqual(expect.any(String));
    // 처리 중에 다시 오면(간격 안이어도 429가 아니라) in_progress
    expect(await claim(h, '2026-11-03T01:00:05Z', 'order-1', H1)).toEqual({ ok: false, reason: 'in_progress' });
    await finish(first.call_id, 200, null, null);
    expect(await claim(h, '2026-11-03T01:00:10Z', 'order-1', H1)).toEqual({ ok: false, reason: 'replay', call: { http_status: 200, conversation_id: null, message: null } });
    expect(await claim(h, '2026-11-03T01:00:15Z', 'order-1', H2)).toEqual({ ok: false, reason: 'key_mismatch' });
    expect(await useCount(h)).toBe(1);
    // 새 키는 평소처럼 간격을 본다
    expect(await claim(h, '2026-11-03T01:00:20Z', 'order-2', H1)).toMatchObject({ ok: false, reason: 'too_soon' });
    expect((await db.query('SELECT count(*)::int AS n FROM app_webhook_calls c JOIN app_webhooks w ON w.id = c.webhook_id WHERE w.token_hash = $1', [h])).rows[0].n).toBe(1);
  });

  it('10분 넘게 running이면 멈춘 실행으로 보고 새로 받는다. 24시간 지난 키는 다시 쓴다', async () => {
    const h = await hook();
    const first = await claim(h, '2026-11-03T02:00:00Z', 'k', H1);
    const again = await claim(h, '2026-11-03T02:11:00Z', 'k', H1);
    expect(again.ok).toBe(true); expect(again.call_id).not.toBe(first.call_id);
    await finish(again.call_id, 400, null, '제목은 필수입니다');
    expect((await claim(h, '2026-11-04T02:10:00Z', 'k', H1)).reason).toBe('replay');
    const later = await claim(h, '2026-11-04T02:12:00Z', 'k', H2);
    expect(later.ok).toBe(true);
    expect(await useCount(h)).toBe(3);
  });

  it('같은 키를 동시에 보내면 하나만 running이 되고 나머지는 in_progress — 무효 토큰은 키가 있어도 invalid', async () => {
    const h = await hook();
    const clients = await Promise.all([0, 1, 2].map(async () => { const c = new pg.Client({ connectionString: url }); await c.connect(); return c; }));
    try {
      const results = await Promise.all(clients.map(c => claim(h, '2026-11-03T03:00:00Z', 'same', H1, c)));
      expect(results.filter(r => r.ok)).toHaveLength(1);
      expect(results.filter(r => r.reason === 'in_progress')).toHaveLength(2);
    } finally { await Promise.all(clients.map(c => c.end())); }
    expect(await claim(await hook('revoked'), '2026-11-03T03:00:00Z', 'same', H1)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('CHECK: 키 꼴·해시 꼴·done이면 상태 코드, 5xx는 저장할 수 없다', async () => {
    const h = await hook();
    const { rows: [w] } = await db.query('SELECT id FROM app_webhooks WHERE token_hash = $1', [h]);
    const insert = (key: string, hash: string, status = 'running', http: number | null = null) =>
      db.query('INSERT INTO app_webhook_calls (webhook_id, idempotency_key, request_hash, status, http_status) VALUES ($1, $2, $3, $4, $5)', [w.id, key, hash, status, http]);
    await expect(insert('한글', H1)).rejects.toThrow(/check/i);
    await expect(insert('k1', 'nothex')).rejects.toThrow(/check/i);
    await expect(insert('k2', H1, 'done', null)).rejects.toThrow(/check/i);
    await expect(insert('k3', H1, 'done', 502)).rejects.toThrow(/check/i);
    await insert('k4', H1, 'done', 200);
  });
});
