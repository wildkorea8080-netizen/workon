import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'crypto';

/**
 * 입력형 앱 일괄 실행 표(0077)를 실제 Postgres에서 — 시험 DB(`npm run work:testdb -- start`)가 있을 때만.
 * 보는 것: 상태·마친 때·멈춘 사유 짝 CHECK, 줄 수 1~100, 같은 묶음·같은 번호 한 줄(UNIQUE), 줄 상태·차지·마친 때 짝 CHECK,
 * 묶음을 지우면 줄도, 대화를 지우면 줄의 대화·답변 칸만 비움, RLS로 anon·authenticated는 못 읽음
 */
const url = process.env.WORK_TEST_DATABASE_URL;

describe.skipIf(!url)('앱 일괄 실행 DB (0077)', () => {
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
    await db?.query('DELETE FROM app_batches WHERE organization_id = $1', [orgId]);
    await db?.query('DELETE FROM conversations WHERE user_id = $1', [userId]);
    await db?.query('DELETE FROM agents WHERE id = $1', [agentId]);
    await db?.query('DELETE FROM users WHERE id = $1', [userId]);
    await db?.query('DELETE FROM departments WHERE id = $1', [deptId]);
    await db?.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    await db?.end();
  });

  const batch = (patch: { status?: string; total?: number; finished_at?: string | null; stop_reason?: string | null } = {}) => db.query(
    `INSERT INTO app_batches (organization_id, department_id, user_id, agent_id, app_version, name, status, total, finished_at, stop_reason)
     VALUES ($1, $2, $3, $4, 1, '11월 민원', $5, $6, $7, $8) RETURNING id`,
    [orgId, deptId, userId, agentId, patch.status ?? 'running', patch.total ?? 2, patch.finished_at ?? null, patch.stop_reason ?? null],
  );
  const item = (batchId: string, position: number, patch: { status?: string; claimed_at?: string | null; finished_at?: string | null; conversation_id?: string | null } = {}) => db.query(
    `INSERT INTO app_batch_items (batch_id, position, inputs, status, claimed_at, finished_at, conversation_id) VALUES ($1, $2, '{"topic":"여비"}', $3, $4, $5, $6) RETURNING id`,
    [batchId, position, patch.status ?? 'pending', patch.claimed_at ?? null, patch.finished_at ?? null, patch.conversation_id ?? null],
  );

  it('묶음 CHECK — 상태와 마친 때·멈춘 사유 짝, 줄 수 1~100', async () => {
    await batch();
    await expect(batch({ status: 'done' })).rejects.toThrow(/check/i);
    await batch({ status: 'done', finished_at: '2026-11-09T00:00:00Z' });
    await expect(batch({ status: 'stopped', finished_at: '2026-11-09T00:00:00Z' })).rejects.toThrow(/check/i);
    await batch({ status: 'stopped', finished_at: '2026-11-09T00:00:00Z', stop_reason: '앱 설정이 바뀌어 멈췄습니다.' });
    await expect(batch({ total: 0 })).rejects.toThrow(/check/i);
    await expect(batch({ total: 101 })).rejects.toThrow(/check/i);
  });

  it('줄 CHECK — 같은 번호 한 줄, 실행 중은 차지 시각, 끝난 줄은 마친 때', async () => {
    const { rows: [b] } = await batch();
    await item(b.id, 1);
    await expect(item(b.id, 1)).rejects.toThrow(/duplicate|unique/i);
    await expect(item(b.id, 2, { status: 'running' })).rejects.toThrow(/check/i);
    await item(b.id, 2, { status: 'running', claimed_at: '2026-11-09T00:00:00Z' });
    await expect(item(b.id, 3, { status: 'done' })).rejects.toThrow(/check/i);
    await item(b.id, 3, { status: 'done', finished_at: '2026-11-09T00:00:00Z' });
    await expect(item(b.id, 0)).rejects.toThrow(/check/i);
  });

  it('묶음을 지우면 줄도, 대화를 지우면 줄의 대화 칸만 비운다', async () => {
    const conv = randomUUID();
    await db.query('INSERT INTO conversations (id, department_id, user_id, title) VALUES ($1, $2, $3, $4)', [conv, deptId, userId, '[일괄] 대화']);
    const { rows: [b] } = await batch();
    const { rows: [it1] } = await item(b.id, 1, { status: 'done', finished_at: '2026-11-09T00:00:00Z', conversation_id: conv });
    await db.query('DELETE FROM conversations WHERE id = $1', [conv]);
    expect((await db.query('SELECT conversation_id, status FROM app_batch_items WHERE id = $1', [it1.id])).rows[0]).toEqual({ conversation_id: null, status: 'done' });
    await db.query('DELETE FROM app_batches WHERE id = $1', [b.id]);
    expect((await db.query('SELECT 1 FROM app_batch_items WHERE id = $1', [it1.id])).rowCount).toBe(0);
  });

  it('RLS 켜짐 — anon·authenticated는 읽지 못함', async () => {
    const { rows: [b] } = await batch();
    await item(b.id, 1);
    for (const role of ['anon', 'authenticated']) {
      await db.query(`SET ROLE ${role}`);
      try {
        expect((await db.query('SELECT 1 FROM app_batches')).rowCount).toBe(0);
        expect((await db.query('SELECT 1 FROM app_batch_items')).rowCount).toBe(0);
      } finally { await db.query('RESET ROLE'); }
    }
  });
});
