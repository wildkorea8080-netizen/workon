import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'crypto';

/**
 * 앱 예약 표(0048)를 실제 Postgres에서 — 시험 DB(`npm run work:testdb -- start`)가 있을 때만.
 * 보는 것: 주기와 요일/날 짝 CHECK, 조건부 차지(두 실행기가 같은 예약을 잡지 못함·멈춘 차지는 다시 잡힘), RLS·권한 회수, 연쇄 삭제
 */
const url = process.env.WORK_TEST_DATABASE_URL;

describe.skipIf(!url)('앱 예약 DB (0048)', () => {
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
    // departments.organization_id는 NOT NULL인데 FK가 SET NULL이라 기관을 먼저 지우면 실패한다 — 아래에서 위로 지운다
    await db?.query('DELETE FROM app_schedules WHERE organization_id = $1', [orgId]);
    await db?.query('DELETE FROM agents WHERE department_id = $1', [deptId]);
    await db?.query('DELETE FROM users WHERE id = $1', [userId]);
    await db?.query('DELETE FROM departments WHERE id = $1', [deptId]);
    await db?.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    await db?.end();
  });

  const insert = (patch: Record<string, unknown> = {}) => {
    const row = { frequency: 'daily', weekday: null, month_day: null, run_hour: 9, run_minute: 0, next_run_at: '2026-11-03T00:00:00Z', inputs: { title: '주간 보고' }, ...patch };
    return db.query(
      `INSERT INTO app_schedules (agent_id, user_id, department_id, organization_id, app_version, inputs, frequency, weekday, month_day, run_hour, run_minute, next_run_at)
       VALUES ($1, $2, $3, $4, 3, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [agentId, userId, deptId, orgId, JSON.stringify(row.inputs), row.frequency, row.weekday, row.month_day, row.run_hour, row.run_minute, row.next_run_at],
    );
  };

  it('주기와 요일/날 짝·시각 범위·입력 꼴을 CHECK가 막는다', async () => {
    await expect(insert({ frequency: 'weekly' })).rejects.toThrow(/check/i);
    await expect(insert({ frequency: 'daily', weekday: 1 })).rejects.toThrow(/check/i);
    await expect(insert({ frequency: 'monthly', month_day: 31 })).rejects.toThrow(/check/i);
    await expect(insert({ run_minute: 15 })).rejects.toThrow(/check/i);
    await expect(insert({ frequency: 'hourly' })).rejects.toThrow(/check/i);
    await expect(insert({ inputs: ['x'] })).rejects.toThrow(/check/i);
    const ok = await insert({ frequency: 'weekly', weekday: 1 });
    expect(ok.rowCount).toBe(1);
  });

  it('조건부 차지: 같은 예약을 두 번 잡지 못하고, 15분 넘은 차지는 다시 잡힌다 — 멈춘 예약은 잡히지 않는다', async () => {
    const { rows: [{ id }] } = await insert();
    const claim = (now: string) => db.query(
      `UPDATE app_schedules SET claimed_at = $2 WHERE id = $1 AND status = 'active' AND next_run_at <= $2
         AND (claimed_at IS NULL OR claimed_at < $2::timestamptz - interval '15 minutes') RETURNING id`,
      [id, now],
    );
    expect((await claim('2026-11-03T00:01:00Z')).rowCount).toBe(1);
    expect((await claim('2026-11-03T00:02:00Z')).rowCount).toBe(0);
    expect((await claim('2026-11-03T00:17:00Z')).rowCount).toBe(1);
    await db.query(`UPDATE app_schedules SET status = 'paused', claimed_at = NULL WHERE id = $1`, [id]);
    expect((await claim('2026-11-03T01:00:00Z')).rowCount).toBe(0);
    await expect(db.query(`UPDATE app_schedules SET status = 'running' WHERE id = $1`, [id])).rejects.toThrow(/check/i);
  });

  it('RLS가 켜져 있어 anon·authenticated는 읽지도 쓰지도 못한다(정책 없음). 앱을 지우면 예약도 함께 지워진다', async () => {
    const { rows: [rls] } = await db.query(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.app_schedules'::regclass`);
    expect(rls.relrowsecurity).toBe(true);
    const { rows: [{ id }] } = await insert();
    // 시험 DB 스크립트는 Supabase처럼 모든 표에 anon·authenticated GRANT를 다시 준다 — 그 조건에서도 정책 없는 RLS가 막아야 한다
    for (const role of ['anon', 'authenticated']) {
      await db.query(`SET ROLE ${role}`);
      try {
        const { rowCount } = await db.query('SELECT 1 FROM app_schedules WHERE id = $1', [id]);
        expect(rowCount, `${role} select`).toBe(0);
        await expect(db.query(`UPDATE app_schedules SET status = 'paused' WHERE id = $1 RETURNING id`, [id])).resolves.toMatchObject({ rowCount: 0 });
        await expect(db.query(
          `INSERT INTO app_schedules (agent_id, user_id, department_id, organization_id, app_version, inputs, frequency, run_hour, run_minute, next_run_at)
           VALUES ($1, $2, $3, $4, 1, '{}', 'daily', 9, 0, now())`, [agentId, userId, deptId, orgId])).rejects.toMatchObject({ code: '42501' });
      } finally { await db.query('RESET ROLE'); }
    }
    expect((await db.query('SELECT status FROM app_schedules WHERE id = $1', [id])).rows[0].status).toBe('active');
    const other = randomUUID();
    await db.query('INSERT INTO agents (id, name, department_id, organization_id, tier, visibility, is_published) VALUES ($1, $2, $3, $4, $5, $6, true)', [other, '지울 앱', deptId, orgId, 'official', 'organization']);
    const { rows: [{ id: ofOther }] } = await db.query(
      `INSERT INTO app_schedules (agent_id, user_id, department_id, organization_id, app_version, inputs, frequency, run_hour, run_minute, next_run_at)
       VALUES ($1, $2, $3, $4, 1, '{}', 'daily', 9, 0, now()) RETURNING id`, [other, userId, deptId, orgId]);
    await db.query('DELETE FROM agents WHERE id = $1', [other]);
    const { rowCount } = await db.query('SELECT 1 FROM app_schedules WHERE id = ANY($1)', [[id, ofOther]]);
    expect(rowCount).toBe(1);
  });
});
