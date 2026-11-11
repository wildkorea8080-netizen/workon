import { readFileSync } from 'fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { OUTBOUND_RETRY_WINDOW_MS, canRetryDelivery } from '@/lib/apps/outbound/spec';
import { retryMyDelivery, type RetryDeps } from '@/lib/apps/outbound/deliver';
import { readDepartmentAdoption } from '@/lib/department-adoption';

/**
 * (2026-11-10) 그만둔 보내기 다시 보내기 — 실행한 직원만·실제로 보내 보고 그만둔 7일 안의 기록만·보낼 곳이 쓰일 때만
 * 일괄 실행의 마치지 못한 줄만 다시 실행 — 만들기와 같은 길, 파일마다 한 건 줄은 뺀다
 * 부서별 도입 현황의 줄인 시간(0085) — 부서마다 자기 부서의 도움됨 + 고른 값만
 */

const NOW = Date.parse('2026-11-10T06:00:00Z');
const D1 = 'dddddddd-1111-4111-8111-111111111111';

describe('다시 보낼 수 있는지(canRetryDelivery)', () => {
  const d = (over: Partial<{ status: string; attempts: number; created_at: string }> = {}) => ({ status: 'gave_up', attempts: 5, created_at: new Date(NOW - 86_400_000).toISOString(), ...over });
  it('실제로 보내 보고 그만둔·7일 안·보낼 곳이 쓰일 때만', () => {
    expect(canRetryDelivery(d(), true, NOW)).toBe(true);
    expect(canRetryDelivery(d({ attempts: 0 }), true, NOW)).toBe(false); // 확인 기한 지남·회수·동작 없어짐
    expect(canRetryDelivery(d({ status: 'sent' }), true, NOW)).toBe(false);
    expect(canRetryDelivery(d({ status: 'rejected', attempts: 0 }), true, NOW)).toBe(false);
    expect(canRetryDelivery(d({ created_at: new Date(NOW - OUTBOUND_RETRY_WINDOW_MS - 1000).toISOString() }), true, NOW)).toBe(false);
    expect(canRetryDelivery(d(), false, NOW)).toBe(false);
  });
});

describe('다시 보내기(retryMyDelivery)', () => {
  const actor = { userId: 'u1', organizationId: 'o1', departmentId: 'dept' };
  const row = (over: Record<string, unknown> = {}) => ({ id: D1, organization_id: 'o1', user_id: 'u1', endpoint_id: 'e1', agent_id: 'a1', status: 'gave_up', attempts: 5, created_at: new Date(NOW - 3_600_000).toISOString(), ...over });
  const deps = (over: Partial<RetryDeps> = {}) => {
    const update = vi.fn(async () => true);
    const log = vi.fn(async () => undefined);
    const d: RetryDeps = { now: () => NOW, load: async () => row() as never, endpointActive: async () => true, update, log, ...over };
    return { d, update, log };
  };
  it('맞으면 다시 차례로 돌리고 보안 로그(기록 id·보낼 곳·앱만)', async () => {
    const t = deps();
    expect(await retryMyDelivery(actor, D1, t.d)).toEqual({ ok: true });
    expect(t.update).toHaveBeenCalledWith(D1, 'u1', new Date(NOW).toISOString());
    expect(t.log).toHaveBeenCalledWith(actor, { delivery_id: D1, endpoint_id: 'e1', agent_id: 'a1' });
  });
  it('남의 것·다른 기관·없음·틀린 id 404, 다시 보낼 수 없는 기록·회수된 곳·그 사이 바뀜 409, 읽기 실패 503', async () => {
    expect(await retryMyDelivery(actor, 'nope', deps().d)).toMatchObject({ status: 404 });
    for (const over of [{ user_id: 'u2' }, { organization_id: 'o2' }]) expect(await retryMyDelivery(actor, D1, deps({ load: async () => row(over) as never }).d)).toMatchObject({ status: 404 });
    expect(await retryMyDelivery(actor, D1, deps({ load: async () => null }).d)).toMatchObject({ status: 404 });
    expect(await retryMyDelivery(actor, D1, deps({ load: async () => row({ attempts: 0 }) as never }).d)).toMatchObject({ status: 409 });
    const revoked = await retryMyDelivery(actor, D1, deps({ endpointActive: async () => false }).d);
    expect(revoked).toMatchObject({ status: 409, message: '보낼 곳이 회수돼 다시 보낼 수 없습니다.' });
    expect(await retryMyDelivery(actor, D1, deps({ update: vi.fn(async () => false) }).d)).toMatchObject({ status: 409 });
    expect(await retryMyDelivery(actor, D1, deps({ load: async () => { throw new Error('db'); } }).d)).toMatchObject({ status: 503 });
  });
});

describe('연결', () => {
  it('되돌리기는 그만둠·이 직원·시도 1번 이상 조건, 목록에 다시 보낼 수 있는지, 라우트·화면', () => {
    const lib = readFileSync('src/lib/apps/outbound/deliver.ts', 'utf8');
    expect(lib).toContain(".eq('id', id).eq('user_id', userId).eq('status', 'gave_up').gte('attempts', 1)");
    expect(lib).toContain("status: 'pending', attempts: 0, next_attempt_at: nowIso");
    expect(lib).toContain('retryable: canRetryDelivery(r, activeEndpoints.has(r.endpoint_id), nowMs)');
    expect(readFileSync('src/app/api/apps/outbound-deliveries/[id]/route.ts', 'utf8')).toContain('session.user.id');
    expect(readFileSync('src/components/apps/OutboundDeliveriesPanel.tsx', 'utf8')).toContain('다시 보내기');
  });
  it('마치지 못한 줄만 다시 — 끝난 내 묶음의 실패·건너뜀, 파일 줄은 빼고, 만들기와 같은 길', () => {
    const lib = readFileSync('src/lib/apps/batches.ts', 'utf8');
    const fn = lib.slice(lib.indexOf('export async function retryUnfinished'), lib.indexOf('export async function removeBatchFiles'));
    expect(fn).toContain('ownBatch(actor.userId, batchId)');
    expect(fn).toContain("if (batch.status === 'running')");
    expect(fn).toContain(".in('status', ['failed', 'skipped'])");
    expect(fn).toContain('r.file === null || r.file === undefined');
    expect(fn).toContain('createBatch(actor, { agent_id: batch.agent_id');
    expect(readFileSync('src/app/api/apps/batches/[id]/route.ts', 'utf8')).toContain("body?.action !== 'retry_unfinished'");
    expect(readFileSync('src/components/apps/AppBatchPanel.tsx', 'utf8')).toContain('마치지 못한 줄 다시 실행');
  });
  it('부서별 줄인 시간 — 읽기 꼴·0085', () => {
    expect(readDepartmentAdoption([{ department_id: 'd1', name: '민원과', saved_minutes: '90' }])[0].saved_minutes).toBe(90);
    expect(readDepartmentAdoption([{ department_id: 'd1', name: '민원과' }])[0].saved_minutes).toBe(0);
    const sql = readFileSync('supabase/migrations/0085_adoption_by_department_saved.sql', 'utf8');
    expect(sql).toContain("'saved_minutes', COALESCE((SELECT minutes FROM saved s WHERE s.department_id = d.id), 0)");
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.adoption_by_department(uuid, uuid[], timestamptz, timestamptz) TO service_role');
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('부서별 줄인 시간 (0085, 시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('부서마다 자기 부서의 그 달 도움됨 + 고른 값만', async () => {
    const sql = readFileSync('supabase/migrations/0085_adoption_by_department_saved.sql', 'utf8');
    await db.query(sql);
    await db.query(sql);
    await db.query('BEGIN');
    try {
      const org = (await db.query("INSERT INTO organizations (name) VALUES ('부서 줄인 시간') RETURNING id")).rows[0].id;
      const a = (await db.query("INSERT INTO departments (name, slug, organization_id) VALUES ('가과', 'dsv-a', $1) RETURNING id", [org])).rows[0].id;
      const b = (await db.query("INSERT INTO departments (name, slug, organization_id) VALUES ('나과', 'dsv-b', $1) RETURNING id", [org])).rows[0].id;
      const user = (await db.query("INSERT INTO users (email, department_id, is_active) VALUES ('dsv@test.invalid', $1, true) RETURNING id", [a])).rows[0].id;
      const conv = (await db.query("INSERT INTO conversations (department_id, user_id, title) VALUES ($1, $2, '대화') RETURNING id", [a, user])).rows[0].id;
      const fb = async (dept: string, rating: string, minutes: number | null, at: string) => {
        const m = (await db.query("INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'assistant', '답') RETURNING id", [conv])).rows[0].id;
        await db.query('INSERT INTO message_feedback (message_id, conversation_id, user_id, department_id, organization_id, rating, saved_minutes, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [m, conv, user, dept, org, rating, minutes, at]);
      };
      await fb(a, 'up', 30, '2026-10-05T00:00:00Z');
      await fb(a, 'up', 60, '2026-10-06T00:00:00Z');
      await fb(b, 'up', 120, '2026-10-07T00:00:00Z');
      await fb(b, 'up', 240, '2026-09-07T00:00:00Z'); // 지난달
      await fb(b, 'down', null, '2026-10-07T00:00:00Z');
      const r = (await db.query('SELECT adoption_by_department($1, $2, $3, $4) AS r', [org, [a, b], '2026-09-30T15:00:00Z', '2026-10-31T15:00:00Z'])).rows[0].r;
      const rows = readDepartmentAdoption(r);
      expect(rows.find((x) => x.name === '가과')?.saved_minutes).toBe(90);
      expect(rows.find((x) => x.name === '나과')?.saved_minutes).toBe(120);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
