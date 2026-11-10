import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'crypto';

/**
 * 보내기 전 확인(0078)을 실제 Postgres에서 — 시험 DB(`npm run work:testdb -- start`)가 있을 때만.
 * 보는 것: 보낼 곳의 확인 칸 기본값 false, 새 상태 둘(awaiting_approval·rejected)과 옛 상태가 함께 들어감,
 * 확인 기다림은 정한 때가 없고 보내지 않음은 정한 때가 있음, 정한 사람이 탈퇴해도 정한 때는 남음
 */
const url = process.env.WORK_TEST_DATABASE_URL;

describe.skipIf(!url)('앱 결과 보내기 전 확인 DB (0078)', () => {
  let db: pg.Client;
  const orgId = randomUUID(); const deptId = randomUUID(); const userId = randomUUID(); const agentId = randomUUID(); const convId = randomUUID();
  let endpointId = '';

  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
    await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, `기관-${orgId.slice(0, 6)}`]);
    await db.query('INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)', [deptId, '기획조정실', `d-${deptId.slice(0, 8)}`, orgId]);
    await db.query('INSERT INTO users (id, email, department_id) VALUES ($1, $2, $3)', [userId, `${userId}@test.local`, deptId]);
    await db.query('INSERT INTO agents (id, name, department_id, organization_id, tier, visibility, is_published) VALUES ($1, $2, $3, $4, $5, $6, true)', [agentId, '조사 앱', deptId, orgId, 'official', 'organization']);
    await db.query('INSERT INTO conversations (id, department_id, user_id, title) VALUES ($1, $2, $3, $4)', [convId, deptId, userId, '대화']);
    endpointId = (await db.query(
      `INSERT INTO app_outbound_endpoints (organization_id, name, url, secret_encrypted, secret_prefix) VALUES ($1, '연계', 'https://hook.example.com/in', 'iv:encrypted-secret', 'wo_out_abcde') RETURNING id, require_approval`,
      [orgId],
    )).rows[0].id;
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

  const message = async () => (await db.query(`INSERT INTO messages (id, conversation_id, role, content) VALUES ($1, $2, 'assistant', '결과') RETURNING id`, [randomUUID(), convId])).rows[0].id as string;
  const delivery = async (patch: { status: string; decided_at?: string | null; decided_by?: string | null; sent_at?: string | null; claimed_at?: string | null }) => db.query(
    `INSERT INTO app_outbound_deliveries (organization_id, endpoint_id, agent_id, message_id, user_id, status, decided_at, decided_by, sent_at, claimed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [orgId, endpointId, agentId, await message(), userId, patch.status, patch.decided_at ?? null, patch.decided_by ?? null, patch.sent_at ?? null, patch.claimed_at ?? null],
  );

  it('보낼 곳의 보내기 전 확인은 기본 꺼짐', async () => {
    expect((await db.query('SELECT require_approval FROM app_outbound_endpoints WHERE id = $1', [endpointId])).rows[0].require_approval).toBe(false);
  });

  it('상태 — 확인 기다림·보내지 않음과 옛 상태, 모르는 상태는 거절', async () => {
    await delivery({ status: 'awaiting_approval' });
    await delivery({ status: 'rejected', decided_at: '2026-11-10T00:00:00Z', decided_by: userId });
    await delivery({ status: 'pending' });
    await delivery({ status: 'pending', decided_at: '2026-11-10T00:00:00Z', decided_by: userId });
    await delivery({ status: 'sent', sent_at: '2026-11-10T00:00:00Z' });
    await expect(delivery({ status: 'approved' })).rejects.toThrow(/check/i);
  });

  it('확인 기다림은 정한 때 없음, 보내지 않음은 정한 때 있음, 정한 사람만 있고 때가 없으면 거절', async () => {
    await expect(delivery({ status: 'awaiting_approval', decided_at: '2026-11-10T00:00:00Z' })).rejects.toThrow(/check/i);
    await expect(delivery({ status: 'rejected' })).rejects.toThrow(/check/i);
    await expect(delivery({ status: 'pending', decided_by: userId })).rejects.toThrow(/check/i);
    // 정한 사람이 지워져(SET NULL) 칸이 비어도 정한 때는 남을 수 있다
    await delivery({ status: 'rejected', decided_at: '2026-11-10T00:00:00Z' });
  });
});
