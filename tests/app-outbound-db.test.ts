import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'crypto';

/**
 * 앱 결과 보낼 곳·보내기 기록(0076)을 실제 Postgres에서 — 시험 DB(`npm run work:testdb -- start`)가 있을 때만.
 * 보는 것: https·길이·회수 짝 CHECK, 같은 결과·같은 곳 한 벌(UNIQUE), 상태·보낸 때·차지 짝 CHECK, 대화(메시지)를 지우면 기록도 사라짐,
 * 보낼 곳을 지우면 기록도, anon·authenticated는 못 씀, 다시 적용해도 안전
 */
const url = process.env.WORK_TEST_DATABASE_URL;

describe.skipIf(!url)('앱 결과 보내기 DB (0076)', () => {
  let db: pg.Client;
  const orgId = randomUUID(); const deptId = randomUUID(); const userId = randomUUID(); const agentId = randomUUID(); const convId = randomUUID();

  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
    await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, `기관-${orgId.slice(0, 6)}`]);
    await db.query('INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)', [deptId, '기획조정실', `d-${deptId.slice(0, 8)}`, orgId]);
    await db.query('INSERT INTO users (id, email, department_id) VALUES ($1, $2, $3)', [userId, `${userId}@test.local`, deptId]);
    await db.query('INSERT INTO agents (id, name, department_id, organization_id, tier, visibility, is_published) VALUES ($1, $2, $3, $4, $5, $6, true)', [agentId, '조사 앱', deptId, orgId, 'official', 'organization']);
    await db.query('INSERT INTO conversations (id, department_id, user_id, title) VALUES ($1, $2, $3, $4)', [convId, deptId, userId, '대화']);
  });
  afterAll(async () => {
    await db?.query('DELETE FROM app_outbound_endpoints WHERE organization_id = $1', [orgId]);
    await db?.query('DELETE FROM conversations WHERE id = $1', [convId]);
    await db?.query('DELETE FROM agents WHERE id = $1', [agentId]);
    await db?.query('DELETE FROM users WHERE id = $1', [userId]);
    await db?.query('DELETE FROM departments WHERE id = $1', [deptId]);
    await db?.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    await db?.end();
  });

  const endpoint = async (patch: { url?: string; name?: string; revoked_at?: string | null; revoked_reason?: string | null } = {}) => (await db.query(
    `INSERT INTO app_outbound_endpoints (organization_id, name, url, secret_encrypted, secret_prefix, created_by, revoked_at, revoked_reason)
     VALUES ($1, $2, $3, 'iv:encrypted-secret', 'wo_out_abcde', $4, $5, $6) RETURNING id`,
    [orgId, patch.name ?? '전자결재 연계', patch.url ?? 'https://hook.example.com/in', userId, patch.revoked_at ?? null, patch.revoked_reason ?? null],
  )).rows[0].id as string;
  const message = async () => (await db.query(
    "INSERT INTO messages (id, conversation_id, role, content) VALUES ($1, $2, 'assistant', '결과') RETURNING id", [randomUUID(), convId],
  )).rows[0].id as string;
  const delivery = (endpointId: string, messageId: string, patch: Record<string, unknown> = {}) => db.query(
    `INSERT INTO app_outbound_deliveries (organization_id, endpoint_id, agent_id, message_id, user_id, status, sent_at, claimed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [orgId, endpointId, agentId, messageId, userId, patch.status ?? 'pending', patch.sent_at ?? null, patch.claimed_at ?? null],
  );

  it('보낼 곳 CHECK — https만·이름 길이·회수 시각과 사유는 짝', async () => {
    expect(await endpoint()).toMatch(/^[0-9a-f-]{36}$/);
    await expect(endpoint({ url: 'http://hook.example.com/in' })).rejects.toThrow(/check/i);
    await expect(endpoint({ name: '' })).rejects.toThrow(/check/i);
    await expect(endpoint({ revoked_at: '2026-11-09T00:00:00Z' })).rejects.toThrow(/check/i);
    expect(await endpoint({ revoked_at: '2026-11-09T00:00:00Z', revoked_reason: '받는 시스템 폐기' })).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('같은 결과·같은 곳은 한 벌, 상태·보낸 때·차지 짝 CHECK', async () => {
    const e = await endpoint(); const m = await message();
    await delivery(e, m);
    await expect(delivery(e, m)).rejects.toThrow(/duplicate|unique/i);
    const m2 = await message();
    await expect(delivery(e, m2, { status: 'sent' })).rejects.toThrow(/check/i);
    await expect(delivery(e, m2, { status: 'sending' })).rejects.toThrow(/check/i);
    await expect(delivery(e, m2, { status: 'lost' })).rejects.toThrow(/check/i);
    await delivery(e, m2, { status: 'sent', sent_at: '2026-11-09T00:00:00Z' });
    const m3 = await message();
    await delivery(e, m3, { status: 'sending', claimed_at: '2026-11-09T00:00:00Z' });
  });

  it('메시지(대화)를 지우면 기록도, 보낼 곳을 지우면 기록도 사라진다', async () => {
    const e = await endpoint(); const m = await message();
    const { rows: [d] } = await delivery(e, m);
    await db.query('DELETE FROM messages WHERE id = $1', [m]);
    expect((await db.query('SELECT 1 FROM app_outbound_deliveries WHERE id = $1', [d.id])).rowCount).toBe(0);
    const m2 = await message();
    const { rows: [d2] } = await delivery(e, m2);
    await db.query('DELETE FROM app_outbound_endpoints WHERE id = $1', [e]);
    expect((await db.query('SELECT 1 FROM app_outbound_deliveries WHERE id = $1', [d2.id])).rowCount).toBe(0);
  });

  it('RLS 켜짐·anon/authenticated는 읽지 못함', async () => {
    const { rows } = await db.query(`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('app_outbound_endpoints', 'app_outbound_deliveries') ORDER BY relname`);
    expect(rows).toEqual([{ relname: 'app_outbound_deliveries', relrowsecurity: true }, { relname: 'app_outbound_endpoints', relrowsecurity: true }]);
    // 시험 DB는 Supabase처럼 anon·authenticated에 표를 GRANT한다(work-testdb) — 같은 조건에서 RLS(정책 없음)가 읽기를 막는지 본다
    await endpoint();
    for (const role of ['anon', 'authenticated']) {
      await db.query(`SET ROLE ${role}`);
      try {
        expect((await db.query('SELECT 1 FROM app_outbound_endpoints')).rowCount).toBe(0);
        expect((await db.query('SELECT 1 FROM app_outbound_deliveries')).rowCount).toBe(0);
      } finally { await db.query('RESET ROLE'); }
    }
  });
  it('0080 — 접수 정보는 보낸 기록에만, 번호 100자·https 주소 500자', async () => {
    const e = await endpoint(); const m = await message();
    const id = (await delivery(e, m, { status: 'sent', sent_at: '2026-11-10T00:00:00Z' })).rows[0].id as string;
    await db.query("UPDATE app_outbound_deliveries SET receipt_ref = '결재-2026-0042', receipt_url = 'https://gw.example.go.kr/doc/42' WHERE id = $1", [id]);
    for (const bad of [
      "receipt_url = 'http://gw.example.go.kr/doc/42'", "receipt_ref = ''", "receipt_ref = repeat('가', 101)", "receipt_url = 'https://x.kr/' || repeat('a', 500)",
    ]) {
      await expect(db.query(`UPDATE app_outbound_deliveries SET ${bad} WHERE id = $1`, [id])).rejects.toMatchObject({ code: '23514' });
    }
    const m2 = await message();
    const pending = (await delivery(e, m2)).rows[0].id as string;
    await expect(db.query("UPDATE app_outbound_deliveries SET receipt_ref = '1' WHERE id = $1", [pending])).rejects.toMatchObject({ code: '23514' });
  });
});
