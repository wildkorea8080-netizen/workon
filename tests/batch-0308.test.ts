import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * 2026-11-26 — 입력형 앱 실행의 사용량 예약(0122). 시작하기 전에 그 실행이 많으면 쓸 금액을 금액 한도(부서·개인 월 한도, 연간 정액)에
 * 예약하고, 다른 실행의 예약을 빼고도 모자라면 시작하지 않는다(도중에 한도에 닿아 쓴 금액이 결과 없이 사라지지 않게).
 * 다른 대화·실행의 한도 판정은 살아 있는 예약을 쓴 것으로 센다(자기 예약은 빼고). 실행을 마치면 풀고, 끊기면 10분 뒤 세지 않는다.
 */

const db = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  lists: {} as Record<string, unknown[]>,
  errors: {} as Record<string, unknown>,
  rpcs: {} as Record<string, unknown>,
}));
vi.mock('@/lib/supabaseAdmin', () => {
  function from(table: string) {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'gt', 'order', 'limit', 'in', 'is']) q[m] = () => q;
    q.maybeSingle = async () => ({ data: db.rows[table] ?? null, error: db.errors[table] ?? null });
    q.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: db.lists[table] ?? [], error: db.errors[table] ?? null }).then(resolve);
    return q;
  }
  return { supabaseAdmin: { from, rpc: async (name: string) => ({ data: db.rpcs[name] ?? 0, error: null }) } };
});
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn(async () => {}) }));
vi.mock('@/lib/config', () => ({ USD_KRW_RATE: 1350 }));

import { amountHeadroom, checkTokenLimit, limitMessage, sumReservations, resetLimitGapReports } from '@/lib/usage-limit';
import {
  estimateRunCostKrw, releaseRunUsage, reservationRejectMessage, reserveRunUsage, RESERVATION_FINAL_OUTPUT_TOKENS, RESERVATION_MAX_KRW,
  RESERVATION_STEP_OUTPUT_TOKENS, RESERVATION_TTL_MS, type ReservationIo,
} from '@/lib/usage-reservation';
import { APP_INTERMEDIATE_TOKENS } from '@/lib/apps/pipeline';
import { MAX_OUTPUT_TOKENS } from '@/lib/assistant/types';
import { estimateCostKrw } from '@/lib/models';

describe('예약 금액 어림', () => {
  it('출력 상한은 실행기와 같은 값', () => {
    expect(RESERVATION_STEP_OUTPUT_TOKENS).toBe(APP_INTERMEDIATE_TOKENS);
    expect(RESERVATION_FINAL_OUTPUT_TOKENS).toBe(MAX_OUTPUT_TOKENS);
  });
  it('단계마다 앞 결과가 입력에 쌓이고, 마지막은 마지막 출력 상한으로', () => {
    const one = estimateRunCostKrw({ modelId: 'claude-sonnet-4-6', calls: 1, baseChars: 1000 });
    expect(one).toBe(Math.ceil(estimateCostKrw({ input_tokens: 1000, output_tokens: 4096 }, 'claude-sonnet-4-6')));
    const three = estimateRunCostKrw({ modelId: 'claude-sonnet-4-6', calls: 3, baseChars: 1000 });
    expect(three).toBe(Math.ceil(estimateCostKrw({ input_tokens: 3000 + 1400 + 2800, output_tokens: 1400 * 2 + 4096 }, 'claude-sonnet-4-6')));
    // 비싼 모델·긴 첨부 추리기는 더
    expect(estimateRunCostKrw({ modelId: 'claude-opus-5', calls: 3, baseChars: 1000 })).toBeGreaterThan(three);
    expect(estimateRunCostKrw({ modelId: 'claude-sonnet-4-6', calls: 3, baseChars: 1000, digest: { pieces: 4, chars: 80_000 } })).toBeGreaterThan(three);
  });
  it('적어도 1원, 많아야 상한(DB CHECK와 같은 값)', () => {
    expect(estimateRunCostKrw({ modelId: 'claude-haiku-4-5', calls: 0, baseChars: 0 })).toBeGreaterThanOrEqual(1);
    expect(estimateRunCostKrw({ modelId: 'claude-opus-5', calls: 100_000, baseChars: 1_000_000 })).toBe(RESERVATION_MAX_KRW);
    expect(readFileSync('supabase/migrations/0122_usage_reservations.sql', 'utf8')).toContain(`amount_krw <= ${RESERVATION_MAX_KRW}`);
  });
});

function io(over: Partial<ReservationIo> = {}) {
  const calls = { reserve: [] as unknown[], report: [] as unknown[] };
  const value: ReservationIo = {
    headroom: async () => ({ organizationId: 'o1', checks: [{ scope: 'user', headroom: 1000, limitKrw: 5000 }] }),
    reserve: async (a) => { calls.reserve.push(a); return { ok: true, id: 'r1' }; },
    release: async () => {},
    report: async (...args) => { calls.report.push(args); },
    now: () => Date.parse('2026-11-26T03:00:00Z'),
    ...over,
  };
  return { value, calls };
}

describe('예약하기', () => {
  it('금액 한도가 있으면 기한 10분으로 예약', async () => {
    const { value, calls } = io();
    expect(await reserveRunUsage(value, { departmentId: 'd1', userId: 'u1', amountKrw: 12.3 })).toEqual({ ok: true, id: 'r1' });
    expect(calls.reserve).toEqual([{ organizationId: 'o1', departmentId: 'd1', userId: 'u1', amountKrw: 13, checks: [{ scope: 'user', headroom: 1000, limitKrw: 5000 }], expiresAt: new Date(Date.parse('2026-11-26T03:00:00Z') + RESERVATION_TTL_MS).toISOString() }]);
  });
  it('모자라면 남은 금액(다른 예약을 뺀)과 함께 거절', async () => {
    const { value } = io({ reserve: async () => ({ ok: false, scope: 'organization', headroom: 900, reserved: 1200 }) });
    const got = await reserveRunUsage(value, { departmentId: 'd1', userId: 'u1', amountKrw: 50 });
    expect(got).toEqual({ ok: false, scope: 'organization', amountKrw: 50, leftKrw: 0, reservedKrw: 1200 });
    if (got.ok) return;
    const msg = reservationRejectMessage(got);
    expect(msg).toContain('많으면 약 50원');
    expect(msg).toContain('연간 계약의 남은 금액가 0원(실행 중인 다른 앱이 예약한 1,200원을 빼고)');
    expect(msg).toContain('다른 앱이 끝난 뒤');
    expect(reservationRejectMessage({ ok: false, scope: 'user', amountKrw: 50, leftKrw: 30, reservedKrw: 0 })).not.toContain('다른 앱');
  });
  it('금액 한도가 없으면 예약하지 않고, 못 읽거나 못 쓰면 예약 없이(운영 기록)', async () => {
    const none = io({ headroom: async () => ({ organizationId: 'o1', checks: [] }) });
    expect(await reserveRunUsage(none.value, { departmentId: 'd1', userId: 'u1', amountKrw: 5 })).toEqual({ ok: true, id: null });
    expect(none.calls.reserve).toEqual([]);
    const noOrg = io({ headroom: async () => ({ organizationId: null, checks: [{ scope: 'user', headroom: 1, limitKrw: 1 }] }) });
    expect(await reserveRunUsage(noOrg.value, { departmentId: 'd1', userId: 'u1', amountKrw: 5 })).toEqual({ ok: true, id: null });
    const unread = io({ headroom: async () => { throw new Error('db'); } });
    expect(await reserveRunUsage(unread.value, { departmentId: 'd1', userId: 'u1', amountKrw: 5 })).toEqual({ ok: true, id: null });
    expect(unread.calls.report).toEqual([['headroom', expect.any(Error), 'd1']]);
    const unwritten = io({ reserve: async () => { throw new Error('db'); } });
    expect(await reserveRunUsage(unwritten.value, { departmentId: 'd1', userId: 'u1', amountKrw: 5 })).toEqual({ ok: true, id: null });
    expect(unwritten.calls.report).toEqual([['reserve', expect.any(Error), 'd1']]);
  });
  it('풀기 — 예약이 없으면 부르지 않고, 못 풀면 기록만', async () => {
    const release = vi.fn(async () => { throw new Error('db'); });
    const { value, calls } = io({ release });
    await releaseRunUsage(value, null, 'd1');
    expect(release).not.toHaveBeenCalled();
    await releaseRunUsage(value, 'r1', 'd1');
    expect(calls.report).toEqual([['release', expect.any(Error), 'd1']]);
  });
});

describe('예약 합 — 범위마다, 자기 예약은 빼고', () => {
  const rows = [
    { id: 'a', department_id: 'd1', user_id: 'u1', amount_krw: '100' },
    { id: 'b', department_id: 'd1', user_id: 'u2', amount_krw: 50 },
    { id: 'c', department_id: 'd2', user_id: 'u3', amount_krw: 30 },
    { id: 'd', department_id: 'd1', user_id: 'u1', amount_krw: 'x' },
  ];
  it('부서·개인·기관', () => {
    expect(sumReservations(rows, 'd1', 'u1')).toEqual({ department: 150, user: 100, organization: 180 });
    expect(sumReservations(rows, 'd1', 'u1', 'a')).toEqual({ department: 50, user: 0, organization: 80 });
    expect(sumReservations(rows, 'd1', undefined)).toEqual({ department: 150, user: 0, organization: 180 });
  });
});

describe('한도 판정이 예약을 센다', () => {
  beforeEach(() => {
    resetLimitGapReports();
    db.rows = {
      departments: { organization_id: 'o1', monthly_budget_krw: 1000, user_monthly_budget_krw: null },
      organizations: { name: '기관', status: 'active', monthly_token_limit: 0 },
      users: { monthly_budget_krw: null },
    };
    db.lists = { usage_reservations: [{ id: 'r-other', department_id: 'd1', user_id: 'u2', amount_krw: 300 }] };
    db.errors = {};
    db.rpcs = { department_spend_krw: 800 };
  });
  it('쓴 금액 + 다른 실행의 예약이 한도에 닿으면 막고 까닭에 예약을 적는다', async () => {
    const status = await checkTokenLimit('d1', 'u1');
    expect(status).toMatchObject({ allowed: false, reason: 'department_budget_exhausted', monthly: { usedKrw: 800, reservedKrw: 300, limitKrw: 1000 } });
    expect(limitMessage(status)).toContain('800원 + 실행 중인 앱이 예약한 300원 / 1,000원');
  });
  it('자기 예약은 빼고 본다(실행 중 단계마다의 다시 보기)', async () => {
    db.lists.usage_reservations = [{ id: 'mine', department_id: 'd1', user_id: 'u1', amount_krw: 300 }];
    expect((await checkTokenLimit('d1', 'u1', { excludeReservationId: 'mine' })).allowed).toBe(true);
    expect((await checkTokenLimit('d1', 'u1')).allowed).toBe(false);
  });
  it('예약을 못 읽으면 예약 없이 판정하고 확인하지 못한 것으로 적는다', async () => {
    db.errors = { usage_reservations: { code: 'XX000' } };
    const status = await checkTokenLimit('d1', 'u1');
    expect(status.allowed).toBe(true);
    expect(status.unverified).toContain('reservations');
  });
  it('금액 한도가 없으면 예약을 읽지 않는다(종량제 토큰 한도는 금액이 아니다)', async () => {
    db.rows.departments = { organization_id: 'o1', monthly_budget_krw: 0, user_monthly_budget_krw: 0 };
    db.errors = { usage_reservations: { code: 'XX000' } };
    const status = await checkTokenLimit('d1', 'u1');
    expect(status.allowed).toBe(true);
    expect(status.unverified).toBeUndefined();
  });
  it('연간 정액 계약도 예약을 센다', async () => {
    db.rows.departments = { organization_id: 'o1', monthly_budget_krw: 0, user_monthly_budget_krw: 0 };
    db.rows.contracts = { id: 'k1', billing_type: 'annual_fixed', annual_budget_krw: 10_000, budget_alert_percent: 80, started_at: '2026-01-01T00:00:00Z', expires_at: null };
    db.rpcs = { organization_spend_krw: 9_800 };
    db.lists.usage_reservations = [{ id: 'r', department_id: 'd2', user_id: 'u9', amount_krw: 250 }];
    expect(await checkTokenLimit('d1', 'u1')).toMatchObject({ allowed: false, reason: 'budget_exhausted', budget: { usedKrw: 9_800, reservedKrw: 250 } });
  });
  it('남은 금액 — 부서·개인·연간을 판정과 같은 규칙으로', async () => {
    db.rows.departments = { organization_id: 'o1', monthly_budget_krw: 1000, user_monthly_budget_krw: 200 };
    db.rows.contracts = { id: 'k1', billing_type: 'annual_fixed', annual_budget_krw: 10_000, budget_alert_percent: 80, started_at: '2026-01-01T00:00:00Z', expires_at: null };
    db.rpcs = { department_spend_krw: 800, user_spend_krw: 50, organization_spend_krw: 9_000 };
    expect(await amountHeadroom('d1', 'u1')).toEqual({ organizationId: 'o1', checks: [
      { scope: 'department', headroom: 200, limitKrw: 1000 },
      { scope: 'user', headroom: 150, limitKrw: 200 },
      { scope: 'organization', headroom: 1000, limitKrw: 10_000 },
    ] });
    db.errors = { users: { code: 'XX000' } };
    await expect(amountHeadroom('d1', 'u1')).rejects.toThrow(/user/);
  });
});

describe('잇기', () => {
  it('대화 준비는 앱 실행만 예약하고 거절은 맨 끝(앞의 거절이 예약을 남기지 않게)', () => {
    const src = readFileSync('src/lib/assistant/prepare.ts', 'utf8');
    const at = src.indexOf('const reserved = await reserveRunUsage(');
    expect(at).toBeGreaterThan(src.indexOf('const { tools } = toolsFor('));
    // 예약 뒤에 다른 거절은 없다 — 이 블록의 거절이 마지막
    const end = src.indexOf('return {\n    ok: true,', at);
    expect(end).toBeGreaterThan(at);
    expect(src.slice(src.indexOf('return reject(reservationRejectMessage(', at) + 10, end)).not.toContain('return reject(');
    expect(src.slice(at - 600, at)).toContain('if (appStepInputs && definition.value)');
    expect(src.slice(at, src.indexOf('return {\n    ok: true,', at))).toContain('discardNewConversation(conversationId, actor.userId)');
  });
  it('실행기는 마치면(실패해도) 예약을 푼다', () => {
    const src = readFileSync('src/lib/assistant/stream.ts', 'utf8');
    expect(src).toMatch(/try \{\s*await runTurn\(turn, rawSend, deps\);\s*\} finally \{[\s\S]{0,200}releaseRunUsage\(/);
    expect(src).toContain('checkTokenLimit(turn.ctx.departmentId, turn.ctx.userId, { excludeReservationId: turn.usageReservationId })');
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0122 — 예약 표와 함수(시험 DB)', () => {
  let pgc: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    pgc = new pg.Client({ connectionString: dbUrl });
    await pgc.connect();
  });
  afterAll(async () => { await pgc?.end(); });
  it('여러 번 적용해도 안전·남은 금액 안에서만·범위마다 다른 예약을 셈·기한 지난 예약은 치움·RLS·권한', async () => {
    await pgc.query('BEGIN');
    try {
      const sql = readFileSync('supabase/migrations/0122_usage_reservations.sql', 'utf8');
      await pgc.query(sql); await pgc.query(sql);
      const org = randomUUID(); const d1 = randomUUID(); const d2 = randomUUID(); const u1 = randomUUID(); const u2 = randomUUID();
      await pgc.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [org, '0122 기관']);
      for (const d of [d1, d2]) await pgc.query("INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)", [d, `과-${d.slice(0, 4)}`, `d-${d.slice(0, 8)}`, org]);
      await pgc.query("INSERT INTO users (id, email, role, department_id) VALUES ($1, $2, 'USER', $3), ($4, $5, 'USER', $6)", [u1, `${u1}@x.test`, d1, u2, `${u2}@x.test`, d2]);
      const later = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const reserve = async (dept: string, user: string, amount: number, checks: unknown[], expires = later) =>
        (await pgc.query('SELECT usage_reserve($1, $2, $3, $4, $5::jsonb, $6) AS r', [org, dept, user, amount, JSON.stringify(checks), expires])).rows[0].r;
      const first = await reserve(d1, u1, 600, [{ scope: 'department', headroom: 1000 }]);
      expect(first).toMatchObject({ ok: true });
      // 같은 부서 — 600 + 500 > 1000
      expect(await reserve(d1, u2, 500, [{ scope: 'department', headroom: 1000 }])).toEqual({ ok: false, scope: 'department', headroom: 1000, reserved: 600 });
      // 다른 부서는 부서 범위에서 세지 않고, 기관 범위는 모두 센다
      expect(await reserve(d2, u2, 500, [{ scope: 'department', headroom: 1000 }])).toMatchObject({ ok: true });
      expect(await reserve(d2, u2, 1, [{ scope: 'organization', headroom: 1100 }])).toEqual({ ok: false, scope: 'organization', headroom: 1100, reserved: 1100 });
      expect(await reserve(d2, u2, 1, [{ scope: 'user', headroom: 501 }])).toMatchObject({ ok: true });
      // 기한이 지난 예약은 세지 않고 다음 예약 때 지운다
      await pgc.query("UPDATE usage_reservations SET created_at = now() - interval '20 minutes', expires_at = now() - interval '5 minutes' WHERE id = $1", [first.id]);
      expect(await reserve(d1, u1, 900, [{ scope: 'department', headroom: 1000 }])).toMatchObject({ ok: true });
      expect((await pgc.query('SELECT count(*)::int n FROM usage_reservations WHERE id = $1', [first.id])).rows[0].n).toBe(0);
      for (const [checks, amount, re] of [
        [[{ scope: 'team', headroom: 1 }], 1, /bad check/],
        [[{ scope: 'department' }], 1, /bad check/],
        [[], 0, /bad input/],
      ] as [unknown[], number, RegExp][]) {
        await pgc.query('SAVEPOINT s');
        await expect(reserve(d1, u1, amount, checks)).rejects.toThrow(re);
        await pgc.query('ROLLBACK TO SAVEPOINT s');
      }
      await pgc.query('SAVEPOINT s');
      await expect(reserve(d1, u1, 1, [], new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString())).rejects.toThrow(/check/i);
      await pgc.query('ROLLBACK TO SAVEPOINT s');
      const rls = await pgc.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'usage_reservations'");
      expect(rls.rows).toEqual([{ relrowsecurity: true }]);
      const anon = await pgc.query("SELECT has_function_privilege('anon', 'public.usage_reserve(uuid, uuid, uuid, numeric, jsonb, timestamptz)', 'EXECUTE') AS ok WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')");
      for (const row of anon.rows) expect(row.ok).toBe(false);
    } finally {
      await pgc.query('ROLLBACK');
    }
  });
});
