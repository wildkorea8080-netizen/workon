import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { generateWebhookToken } from '@/lib/apps/webhooks';

/**
 * 0050(앱 예약·연동 관리자 통제)을 실제 Postgres에서 — 시험 DB(`npm run work:testdb -- start`)가 있을 때만.
 * 보는 것: 다시 적용해도 안전, 회수 사유는 회수된 연동에만, 관리자 잠금은 멈춘 예약에만(코드가 잊어도 DB가 직원의 다시 켜기를 막음),
 * 직원의 조건부 다시 켜기는 잠긴 예약에서 0행
 */
const url = process.env.WORK_TEST_DATABASE_URL;

describe.skipIf(!url)('앱 예약·연동 관리자 통제 DB (0050)', () => {
  let db: pg.Client;
  const orgId = randomUUID(); const deptId = randomUUID(); const userId = randomUUID(); const agentId = randomUUID();

  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
    await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, `기관-${orgId.slice(0, 6)}`]);
    await db.query('INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)', [deptId, '총무과', `d-${deptId.slice(0, 8)}`, orgId]);
    await db.query('INSERT INTO users (id, email, department_id) VALUES ($1, $2, $3)', [userId, `${userId}@test.local`, deptId]);
    await db.query('INSERT INTO agents (id, name, department_id, organization_id, tier, visibility, is_published) VALUES ($1, $2, $3, $4, $5, $6, true)', [agentId, '주간 보고 앱', deptId, orgId, 'official', 'organization']);
  });
  afterAll(async () => {
    await db?.query('DELETE FROM app_webhooks WHERE organization_id = $1', [orgId]);
    await db?.query('DELETE FROM app_schedules WHERE organization_id = $1', [orgId]);
    await db?.query('DELETE FROM agents WHERE department_id = $1', [deptId]);
    await db?.query('DELETE FROM users WHERE id = $1', [userId]);
    await db?.query('DELETE FROM departments WHERE id = $1', [deptId]);
    await db?.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    await db?.end();
  });

  const hook = async () => {
    const t = generateWebhookToken();
    const { rows: [row] } = await db.query(
      `INSERT INTO app_webhooks (agent_id, user_id, department_id, organization_id, app_version, name, token_hash, token_prefix, expires_at)
       VALUES ($1, $2, $3, $4, 1, '민원 시스템', $5, $6, now() + interval '30 days') RETURNING id`, [agentId, userId, deptId, orgId, t.hash, t.prefix]);
    return row.id as string;
  };
  const schedule = async () => {
    const { rows: [row] } = await db.query(
      `INSERT INTO app_schedules (agent_id, user_id, department_id, organization_id, app_version, inputs, frequency, run_hour, run_minute, next_run_at)
       VALUES ($1, $2, $3, $4, 1, '{"title":"주간 보고"}', 'daily', 9, 0, now() + interval '1 day') RETURNING id`, [agentId, userId, deptId, orgId]);
    return row.id as string;
  };

  it('다시 적용해도 오류 없이 그대로다', async () => {
    await db.query(readFileSync('supabase/migrations/0050_app_automation_admin.sql', 'utf8'));
    const { rows } = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name IN ('app_webhooks','app_schedules') AND column_name IN ('revoked_reason','admin_paused_at') ORDER BY 1`);
    expect(rows.map(r => r.column_name)).toEqual(['admin_paused_at', 'revoked_reason']);
  });

  it('회수 사유는 회수된 연동에만, 300자까지', async () => {
    const id = await hook();
    await expect(db.query(`UPDATE app_webhooks SET revoked_reason = '관리자가 회수했습니다 — 퇴사' WHERE id = $1`, [id])).rejects.toThrow(/check/i);
    await expect(db.query(`UPDATE app_webhooks SET status = 'revoked', revoked_at = now(), revoked_reason = $2 WHERE id = $1`, [id, 'x'.repeat(301)])).rejects.toThrow(/check/i);
    await db.query(`UPDATE app_webhooks SET status = 'revoked', revoked_at = now(), revoked_reason = '관리자가 회수했습니다 — 퇴사' WHERE id = $1`, [id]);
    const { rows: [row] } = await db.query('SELECT status, revoked_reason FROM app_webhooks WHERE id = $1', [id]);
    expect(row).toEqual({ status: 'revoked', revoked_reason: '관리자가 회수했습니다 — 퇴사' });
  });

  it('관리자 잠금은 멈춘 예약에만 — 잠긴 예약을 켜면 DB가 거절하고, 직원 길의 조건부 다시 켜기는 0행이다. 잠금을 풀면 켤 수 있다', async () => {
    const id = await schedule();
    await expect(db.query('UPDATE app_schedules SET admin_paused_at = now() WHERE id = $1', [id])).rejects.toThrow(/check/i);
    await db.query(`UPDATE app_schedules SET status = 'paused', paused_reason = '관리자가 멈췄습니다 — 비용 점검', admin_paused_at = now() WHERE id = $1`, [id]);
    await expect(db.query(`UPDATE app_schedules SET status = 'active' WHERE id = $1`, [id])).rejects.toThrow(/check/i);
    const resumed = await db.query(`UPDATE app_schedules SET status = 'active', paused_reason = NULL WHERE id = $1 AND user_id = $2 AND admin_paused_at IS NULL RETURNING id`, [id, userId]);
    expect(resumed.rowCount).toBe(0);
    // 실행기 차지 조건(status = 'active')에도 걸리지 않는다
    const due = await db.query(`SELECT id FROM app_schedules WHERE id = $1 AND status = 'active'`, [id]);
    expect(due.rowCount).toBe(0);
    await db.query('UPDATE app_schedules SET admin_paused_at = NULL WHERE id = $1 AND admin_paused_at IS NOT NULL', [id]);
    const again = await db.query(`UPDATE app_schedules SET status = 'active', paused_reason = NULL WHERE id = $1 AND user_id = $2 AND admin_paused_at IS NULL RETURNING id`, [id, userId]);
    expect(again.rowCount).toBe(1);
  });
});
