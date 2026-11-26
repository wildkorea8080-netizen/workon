import { readFileSync } from 'fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'crypto';

/**
 * 0309 — 일괄 실행 처리량(2026-11-26, 0123). 수백 건을 한 번에:
 * ① 기관 전체 관리자가 정하면 한 번에 500줄까지(기본 100줄 그대로) — 0123이 묶음 줄 수·줄 번호·기관 상한 CHECK를 1~500으로
 * ② 기다리는 줄이 많으면 5분 실행기가 일괄 실행 전용 실행기(`/api/cron/app-batches?lane=N`)를 1~3개 더 띄워 나란히(실행기마다 3줄씩)
 * ③ 묶음을 번갈아 — 큰 묶음 하나가 다른 직원의 묶음을 뒤로 밀지 않게
 * ④ 사용량 예약(0122)에 막혔지만 다른 실행이 쥔 예약이 풀리면 될 줄은 묶음을 멈추지 않고 대기로 돌려 다음 차례에(시도 횟수 그대로)
 * ⑤ 500줄의 답변 id를 `.in()` 한 번에 싣지 않고 100개씩, 묶음 목록의 줄 수는 쪽마다 끝까지(1,000행 상한)
 */

const state = vi.hoisted(() => ({ worker: 'w'.repeat(64) as string | undefined, cron: undefined as string | undefined, lanes: [] as number[] }));
vi.mock('@/lib/config', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  get WORK_WORKER_SECRET() { return state.worker; },
  get CRON_SECRET() { return state.cron; },
}));

import { BATCH_EXTRA_LANES_MAX, BATCH_QUEUE_LIMIT, BATCH_WAITING_RESERVATION, batchExtraLanes, idChunks, interleaveBatchItems, runDueBatchItems, type BatchDeps, type BatchItemRun, type ItemPatch } from '@/lib/apps/batches';
import { BATCH_MAX_ROWS, BATCH_ROWS_CEILING, parseBatchTable } from '@/lib/apps/batch-spec';
import { parseBatchLimit } from '@/lib/apps/batch-limit';
import { dispatchBatchLanes, laneBaseUrl } from '@/lib/apps/batch-lanes';
import { runAppAs, type RunAsIo, type RunAsOutcome } from '@/lib/apps/run-as';
import { reservationWaitable } from '@/lib/usage-reservation';

const read = (p: string) => readFileSync(p, 'utf8');

describe('① 500줄', () => {
  it('기본은 100줄, 기관이 정하면 500줄까지 — 표 읽기는 500줄까지 받고 상한 저장은 1~500', () => {
    expect(BATCH_MAX_ROWS).toBe(100);
    expect(BATCH_ROWS_CEILING).toBe(500);
    const fields = [{ key: 'topic', label: '주제' }];
    const table = (n: number) => `주제\n${Array.from({ length: n }, (_, i) => `q${i}`).join('\n')}`;
    expect(parseBatchTable(table(500), fields)).toMatchObject({ ok: true });
    expect(parseBatchTable(table(501), fields)).toMatchObject({ ok: false, errors: [expect.stringContaining('500줄')] });
    expect(parseBatchLimit(500)).toEqual({ ok: true, value: 500 });
    expect(parseBatchLimit(501).ok).toBe(false);
  });
  it('기관이 정하지 않았으면 만들 때 기본 100줄로 막고 상한을 늘릴 수 있다고 알린다', () => {
    const lib = read('src/lib/apps/batches.ts');
    expect(lib).toContain('if (orgLimit === null && inputs.length > BATCH_MAX_ROWS)');
    expect(lib).toContain('일괄 실행 상한(${BATCH_ROWS_CEILING}줄까지)을 요청하세요');
    expect(lib).toContain('if (b.rows.length > BATCH_ROWS_CEILING)');
  });
  it('답변 id는 100개씩 나눠 `.in()` — 결과 글·보내기 상태·마침 메일의 확인 기다림 수', () => {
    expect(idChunks(Array.from({ length: 250 }, (_, i) => i)).map((c) => c.length)).toEqual([100, 100, 50]);
    expect(idChunks([])).toEqual([]);
    const lib = read('src/lib/apps/batches.ts');
    expect(lib).not.toContain(".in('id', rows.map((r) => r.message_id))");
    expect(lib).not.toContain(".in('message_id', rows.map((r) => r.message_id))");
    expect(lib).not.toContain(".in('message_id', messageIds)");
    expect(lib.match(/for \(const ids of idChunks\(/g)?.length).toBe(3);
  });
  it('묶음 목록의 줄 수는 쪽마다 끝까지(예전 `.limit(100 × 묶음 수)`는 1,000행에서 잘렸다)', () => {
    const lib = read('src/lib/apps/batches.ts');
    expect(lib).not.toContain('.limit(BATCH_MAX_ROWS * batchIds.length)');
    expect(lib).toMatch(/pagedRows<[^>]+>\(\(from, to, withCount\) =>\s*supabaseAdmin\.from\('app_batch_items'\)[^\n]+\.in\('batch_id', batchIds\)\.order\('id'/);
    expect(lib).not.toContain('.limit(BATCH_MAX_ROWS)');
  });
  it('0123은 값만 넓힌다(묶음 줄 수·줄 번호·기관 상한 1~500)', () => {
    const sql = read('supabase/migrations/0123_app_batch_rows_500.sql');
    expect(sql).toContain('CHECK (total BETWEEN 1 AND 500)');
    expect(sql).toContain('CHECK (position BETWEEN 1 AND 500)');
    expect(sql).toContain('app_batch_max_rows BETWEEN 1 AND 500');
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|DELETE FROM|UPDATE /);
  });
});

describe('② 더 띄우기', () => {
  it('기다리는 줄 6개마다 하나, 많아야 셋', () => {
    expect([0, 1, 6, 7, 12, 13, 18, 19, 500, NaN].map(batchExtraLanes)).toEqual([0, 0, 0, 1, 1, 2, 2, 3, 3, 0]);
    expect(BATCH_EXTRA_LANES_MAX).toBe(3);
  });
  it('주소는 서버 설정의 http(s)만 — 끝 / 떼고 origin', () => {
    expect(laneBaseUrl('https://workon.example/')).toBe('https://workon.example');
    expect(laneBaseUrl('https://workon.example/path?x=1')).toBe('https://workon.example');
    expect(laneBaseUrl('http://localhost:3000')).toBe('http://localhost:3000');
    for (const bad of ['', null, undefined, 'ftp://x', 'javascript:alert(1)', 'not a url']) expect(laneBaseUrl(bad as never)).toBeNull();
  });
  it('lane 1~N을 받은 Bearer 그대로 부르고 성공·실패를 센다 — 0개·주소 없음·자격 없음이면 부르지 않음', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('lane=2')) return new Response('{}', { status: 500 });
      if (url.endsWith('lane=3')) throw new Error('timeout');
      return new Response('{}', { status: 200 });
    });
    const out = await dispatchBatchLanes({ baseUrl: 'https://workon.example', authorization: 'Bearer s', lanes: 9, fetchImpl: fetchImpl as never });
    expect(out).toEqual({ requested: 3, started: 1, failed: 2 });
    expect(calls.map((c) => c.url).sort()).toEqual([1, 2, 3].map((n) => `https://workon.example/api/cron/app-batches?lane=${n}`));
    expect(calls[0].init).toMatchObject({ method: 'POST', headers: { authorization: 'Bearer s' }, redirect: 'manual' });
    fetchImpl.mockClear();
    expect(await dispatchBatchLanes({ baseUrl: 'https://workon.example', authorization: 'Bearer s', lanes: 0, fetchImpl: fetchImpl as never })).toEqual({ requested: 0, started: 0, failed: 0 });
    expect(await dispatchBatchLanes({ baseUrl: null, authorization: 'Bearer s', lanes: 2, fetchImpl: fetchImpl as never })).toMatchObject({ started: 0 });
    expect(await dispatchBatchLanes({ baseUrl: 'https://workon.example', authorization: '', lanes: 2, fetchImpl: fetchImpl as never })).toMatchObject({ started: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('5분 실행기는 기다리는 줄을 세어 자기 몫과 나란히 띄운다 — 서버 설정 주소와 받은 Bearer로', () => {
    const route = read('src/app/api/cron/app-schedules/route.ts');
    expect(route).toContain('workerSecretRejection(request)');
    expect(route).toContain('pendingBatchRows().then((pending) => dispatchBatchLanes({ baseUrl: laneBaseUrl(APP_URL), authorization: header, lanes: batchExtraLanes(pending) }))');
    expect(route).toMatch(/Promise\.all\(\[[\s\S]*runDueBatchItems\(batchDeps\(\)\)[\s\S]*\r?\n {4}lanes,\r?\n[\s\S]*\]\);/);
    expect(route).not.toMatch(/request\.url|headers\.get\('host'\)/);
  });
});

describe('② 일괄 실행 전용 실행기 라우트', () => {
  beforeEach(() => { state.worker = 'w'.repeat(64); state.cron = undefined; state.lanes = []; });
  // 이 파일의 다른 묶음은 진짜 실행기를 쓰므로 라우트만 따로 불러 실행기를 바꿔 끼운다(vi.mock은 파일 전체로 올라간다)
  const post = async (auth: string | null, lane: string) => {
    vi.resetModules();
    vi.doMock('@/lib/apps/batches', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      batchDeps: () => ({}),
      runDueBatchItems: async (_deps: unknown, opts: { lane?: number } = {}) => { state.lanes.push(opts.lane ?? 0); return { ran: 0 }; },
    }));
    const { POST } = await import('@/app/api/cron/app-batches/route');
    return POST(new Request(`http://localhost/api/cron/app-batches?lane=${lane}`, { method: 'POST', headers: auth ? { authorization: auth } : {} }));
  };
  it('같은 비밀값만, 비밀값이 없으면 503, lane은 1~3(아니면 1)', async () => {
    expect((await post(null, '1')).status).toBe(401);
    expect((await post('Bearer nope', '1')).status).toBe(401);
    expect(state.lanes).toEqual([]);
    expect((await post(`Bearer ${'w'.repeat(64)}`, '2')).status).toBe(200);
    expect((await post(`Bearer ${'w'.repeat(64)}`, '9')).status).toBe(200);
    expect((await post(`Bearer ${'w'.repeat(64)}`, 'x')).status).toBe(200);
    expect(state.lanes).toEqual([2, 1, 1]);
    state.worker = undefined;
    expect((await post(`Bearer ${'w'.repeat(64)}`, '1')).status).toBe(503);
  });
  it('라우트 목록·maxDuration', () => {
    expect(read('src/lib/api-route-ids.ts')).toContain("'cron/app-batches'");
    expect(read('src/app/api/cron/app-batches/route.ts')).toContain('export const maxDuration = 300');
  });
});

describe('③ 묶음을 번갈아', () => {
  const it2 = (b: string, p: number) => ({ batch_id: b, position: p, id: `${b}${p}` });
  it('묶음마다 줄 순서를 지키며 첫 줄들 → 둘째 줄들 …, lane만큼 앞에서 돌린다', () => {
    const items = [it2('A', 3), it2('A', 1), it2('A', 2), it2('B', 1), it2('C', 1), it2('C', 2)];
    expect(interleaveBatchItems(items, ['A', 'B', 'C']).map((i) => i.id)).toEqual(['A1', 'B1', 'C1', 'A2', 'C2', 'A3']);
    expect(interleaveBatchItems(items, ['A', 'B', 'C'], 1).map((i) => i.id)).toEqual(['A2', 'C2', 'A3', 'A1', 'B1', 'C1']);
    expect(interleaveBatchItems([], ['A'], 2)).toEqual([]);
    // 순서에 없는 묶음은 뒤에
    expect(interleaveBatchItems([it2('Z', 1), it2('A', 1)], ['A']).map((i) => i.id)).toEqual(['A1', 'Z1']);
  });
  it('실행기의 줄 읽기가 번갈아 고르고, 한 차례에 40줄까지 살핀다', () => {
    expect(BATCH_QUEUE_LIMIT).toBe(40);
    const lib = read('src/lib/apps/batches.ts');
    expect(lib).toContain('return interleaveBatchItems(((items ?? []) as Array<Omit<BatchItemRun, \'batch\'>>)');
    expect(lib).toContain('deps.openItems(iso(start - BATCH_STALE_MS), BATCH_QUEUE_LIMIT)');
  });
});

describe('④ 사용량 예약에 막힌 줄은 다음 차례에', () => {
  const batch = (id: string) => ({ id, organization_id: 'o1', department_id: 'd1', user_id: 'u1', agent_id: 'a1', app_version: 2, status: 'running' as const });
  const item = (b: string, position: number, over: Partial<BatchItemRun> = {}): BatchItemRun => ({ id: `${b}${position}`, batch_id: b, position, inputs: {}, status: 'pending', attempts: 1, claimed_at: null, batch: batch(b), ...over });
  function deps(run: (item: BatchItemRun) => RunAsOutcome, items: BatchItemRun[]) {
    const finished: Array<{ id: string; patch: ItemPatch }> = [];
    const stopped: string[] = [];
    const ran: string[] = [];
    const d: BatchDeps = {
      now: () => 0, openItems: async () => items, claim: async () => true,
      run: async (it) => { ran.push(it.id); return run(it); },
      finishItem: async (id, patch) => { finished.push({ id, patch }); },
      stop: async (id) => { stopped.push(id); return true; },
      settle: async () => false, log: async () => {},
    };
    return { d, finished, stopped, ran };
  }
  const waiting: RunAsOutcome = { kind: 'rejected', status: 429, message: '남은 한도가 모자랍니다', waitable: true };
  it('기다리면 될 거절이면 대기로 돌리고(시도 횟수 그대로) 그 묶음은 이 차례에 더 시작하지 않는다 — 다른 묶음은 그대로', async () => {
    const t = deps((it) => (it.batch_id === 'A' ? waiting : { kind: 'completed', conversationId: 'c', messageId: 'm' }), [item('A', 1), item('A', 2), item('A', 3), item('B', 1), item('B', 2)]);
    const out = await runDueBatchItems({ ...t.d, now: () => 0 });
    expect(t.stopped).toEqual([]);
    expect(t.finished.find((f) => f.id === 'A1')!.patch).toEqual({ status: 'pending', attempts: 1, error: BATCH_WAITING_RESERVATION });
    // 나란히 셋이 같은 묶음 줄을 동시에 집었으면 그 줄들까지만 — 막힌 뒤로는 A를 시작하지 않는다
    const aRuns = t.ran.filter((id) => id.startsWith('A'));
    expect(aRuns.length).toBeLessThanOrEqual(3);
    expect(t.ran).toEqual(expect.arrayContaining(['B1', 'B2']));
    expect(out.waited).toBe(aRuns.length);
  });
  it('기다려도 안 될 거절(waitable 없음)은 예전처럼 묶음을 멈춘다', async () => {
    const t = deps(() => ({ kind: 'rejected', status: 429, message: '한도' }), [item('A', 1)]);
    const out = await runDueBatchItems(t.d);
    expect(out.stopped).toBe(1);
    expect(t.stopped).toEqual(['A']);
  });
  it('기다리면 될지 — 다른 예약을 빼서 모자랐고 그 예약이 풀리면 덮을 때만', () => {
    const r = (amountKrw: number, leftKrw: number, reservedKrw: number) => reservationWaitable({ ok: false, scope: 'department', amountKrw, leftKrw, reservedKrw });
    expect(r(500, 100, 600)).toBe(true);
    expect(r(500, 100, 0)).toBe(false);
    expect(r(5000, 100, 600)).toBe(false);
  });
  it('runAppAs는 대화 준비의 waitable을 넘기고, 대화 준비는 예약 거절에 waitable을 싣는다', async () => {
    const io = (details?: Record<string, unknown>): RunAsIo => ({
      loadUser: async () => ({ id: 'u1', email: null, role: 'USER', department_id: 'd1', is_active: true, deleted_at: null }),
      prepare: async () => ({ ok: false, status: 429, message: '모자람', ...(details ? { details } : {}) }),
      stream: async () => {}, retitle: async () => {},
    });
    const input = { userId: 'u1', departmentId: 'd1', agentId: 'a1', appVersion: 1, inputs: {} };
    expect(await runAppAs(input, '[일괄] ', io({ reason: 'usage_reservation', waitable: true }))).toEqual({ kind: 'rejected', status: 429, message: '모자람', waitable: true });
    expect(await runAppAs(input, '[일괄] ', io({ reason: 'usage_reservation', waitable: false }))).toEqual({ kind: 'rejected', status: 429, message: '모자람' });
    expect(await runAppAs(input, '[일괄] ', io())).toEqual({ kind: 'rejected', status: 429, message: '모자람' });
    expect(read('src/lib/assistant/prepare.ts')).toContain("waitable: reservationWaitable(reserved)");
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('⑤ 0123 — 실제 Postgres', () => {
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
    await db?.query('DELETE FROM agents WHERE id = $1', [agentId]);
    await db?.query('DELETE FROM users WHERE id = $1', [userId]);
    await db?.query('DELETE FROM departments WHERE id = $1', [deptId]);
    await db?.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    await db?.end();
  });
  // 기관 상한 칸(1~500)은 app-batch-limit 시험이 본다 — 그 시험이 0084를 다시 적용했다 되돌리므로 여기서 같이 보면 나란히 돌 때 엇갈린다
  it('500줄 묶음·500번 줄은 받고 501은 거절', async () => {
    const insertBatch = (total: number) => db.query(
      `INSERT INTO app_batches (organization_id, department_id, user_id, agent_id, app_version, name, total) VALUES ($1, $2, $3, $4, 1, '많이', $5) RETURNING id`,
      [orgId, deptId, userId, agentId, total]);
    const { rows: [{ id }] } = await insertBatch(500);
    await expect(insertBatch(501)).rejects.toThrow(/check/i);
    await db.query(`INSERT INTO app_batch_items (batch_id, position, inputs) VALUES ($1, 500, '{}')`, [id]);
    await expect(db.query(`INSERT INTO app_batch_items (batch_id, position, inputs) VALUES ($1, 501, '{}')`, [id])).rejects.toThrow(/check/i);
  });
});
