import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import {
  WEBHOOK_DAILY_LIMIT, WEBHOOK_MAX_BODY_BYTES, WEBHOOK_MIN_INTERVAL_SECONDS, WEBHOOK_TITLE_PREFIX,
  bearerWebhookToken, parseWebhookCreate, webhookCurlExample, webhookView,
} from '@/lib/apps/webhook-spec';
import {
  WEBHOOK_APP_CHANGED, WEBHOOK_DEPARTMENT_CHANGED, WEBHOOK_INVALID_TOKEN, WEBHOOK_USER_UNAVAILABLE,
  generateWebhookToken, handleWebhookCall, hashWebhookToken, type ClaimResult, type WebhookDeps,
} from '@/lib/apps/webhooks';
import type { RunAsOutcome } from '@/lib/apps/run-as';

/** 입력형 앱 외부 연동(0049) — 토큰·규칙·호출 처리(상태 가르기·결과 글을 돌려주지 않음·기록) */
const token = generateWebhookToken();
const claimed = { id: 'w1', agent_id: 'a1', user_id: 'u1', department_id: 'd1', organization_id: 'o1', app_version: 3 };

function deps(outcome: RunAsOutcome | Error = { kind: 'completed', conversationId: 'c1' }, claim: ClaimResult = { ok: true, webhook: claimed }) {
  return {
    claim: vi.fn<WebhookDeps['claim']>(async () => claim),
    execute: vi.fn<WebhookDeps['execute']>(async () => { if (outcome instanceof Error) throw outcome; return outcome; }),
    finish: vi.fn<WebhookDeps['finish']>(async () => {}), log: vi.fn<WebhookDeps['log']>(async () => {}), now: vi.fn<WebhookDeps['now']>(() => Date.parse('2026-11-03T00:00:00Z')),
  } satisfies WebhookDeps;
}
const call = (d: WebhookDeps, body: unknown = { inputs: { title: '주간 보고' } }, auth: string | null = `Bearer ${token.token}`) =>
  handleWebhookCall(d, { authorization: auth, bodyText: typeof body === 'string' ? body : JSON.stringify(body) });

describe('토큰', () => {
  it('wo_wh_ + 43자, 해시는 SHA-256 16진 64자, 앞부분 12자만 화면에 — 매번 다르다', () => {
    expect(token.token).toMatch(/^wo_wh_[A-Za-z0-9_-]{43}$/);
    expect(token.hash).toMatch(/^[0-9a-f]{64}$/); expect(token.hash).toBe(hashWebhookToken(token.token));
    expect(token.prefix).toBe(token.token.slice(0, 12)); expect(token.hash).not.toContain(token.token.slice(6));
    expect(generateWebhookToken().token).not.toBe(token.token);
  });
  it('Authorization 머리글은 정확히 Bearer + 토큰 꼴만', () => {
    expect(bearerWebhookToken(`Bearer ${token.token}`)).toBe(token.token);
    for (const bad of [null, '', token.token, `bearer ${token.token}`, `Bearer ${token.token}x`, 'Bearer wo_wh_short', `Bearer ${token.token.replace('wo_wh_', 'wo_xx_')}`]) expect(bearerWebhookToken(bad)).toBeNull();
  });
});

describe('만들기 규칙·보기', () => {
  it('이름 1~40자(제어·서식 글자 지움)·유효 기간 30·90·365일만', () => {
    expect(parseWebhookCreate({ name: '  민원​ 시스템 ', expiry_days: 90 })).toEqual({ ok: true, name: '민원 시스템', expiryDays: 90 });
    expect(parseWebhookCreate({ name: 'x', expiry_days: '365' })).toMatchObject({ ok: true, expiryDays: 365 });
    for (const bad of [null, { name: '', expiry_days: 30 }, { name: 'x'.repeat(41), expiry_days: 30 }, { name: 'x', expiry_days: 0 }, { name: 'x', expiry_days: 7 }, { name: 'x' }]) expect(parseWebhookCreate(bad).ok).toBe(false);
  });
  it('보기는 회수·만료·쓰는 중을 가르고 해시·사용자는 내보내지 않는다. 호출 예시에 토큰·주소·입력이 든다', () => {
    const row = { id: 'w1', agent_id: 'a1', app_version: 3, name: '민원', token_prefix: 'wo_wh_abcdef', status: 'active', expires_at: '2026-12-01T00:00:00Z', revoked_at: null, last_used_at: null, use_count: 0, last_status: null, last_error: null, last_conversation_id: null, created_at: '2026-11-01T00:00:00Z' };
    const now = Date.parse('2026-11-03T00:00:00Z');
    expect(webhookView(row, '앱', now)).toMatchObject({ state: 'active', tokenPrefix: 'wo_wh_abcdef', appName: '앱' });
    expect(webhookView(row, '앱', now)).not.toHaveProperty('token_hash');
    expect(webhookView({ ...row, expires_at: '2026-11-02T00:00:00Z' }, null, now)).toMatchObject({ state: 'expired', appName: '삭제된 앱' });
    expect(webhookView({ ...row, status: 'revoked', revoked_at: '2026-11-02T00:00:00Z' }, '앱', now).state).toBe('revoked');
    const curl = webhookCurlExample('https://x.kr', token.token, { title: "O'Neil" });
    expect(curl).toContain('https://x.kr/api/apps/webhook'); expect(curl).toContain(`Bearer ${token.token}`); expect(curl).toContain(`O'\\''Neil`);
  });
});

describe('handleWebhookCall — 상태 가르기', () => {
  it('완료면 200에 상태·대화 id만 — 결과 글은 없다. 입력은 글로 바꿔 실행기에 넘기고 기록을 남긴다', async () => {
    const d = deps();
    const res = await call(d, { inputs: { title: '주간 보고', count: 3, urgent: true, memo: null } });
    expect(res).toEqual({ status: 200, body: { ok: true, data: { status: 'completed', conversation_id: 'c1' } } });
    expect(d.claim).toHaveBeenCalledWith(token.hash, expect.any(Number));
    expect(d.execute).toHaveBeenCalledWith(claimed, { title: '주간 보고', count: '3', urgent: 'true', memo: '' });
    expect(d.finish).toHaveBeenCalledWith('w1', expect.objectContaining({ last_status: 'completed', last_error: null, last_conversation_id: 'c1' }));
    expect(d.log).not.toHaveBeenCalled();
    expect(WEBHOOK_TITLE_PREFIX).toBe('[연동] ');
  });
  it('토큰 꼴이 틀리면 401, 본문이 크거나 JSON이 아니거나 inputs 꼴이 틀리면 413·400 — 모두 차지(호출 횟수)를 쓰지 않는다', async () => {
    const d = deps();
    expect((await call(d, undefined, null)).status).toBe(401);
    expect((await call(d, undefined, 'Bearer nope')).body).toMatchObject({ error: { message: WEBHOOK_INVALID_TOKEN } });
    expect((await call(d, 'x'.repeat(WEBHOOK_MAX_BODY_BYTES + 1))).status).toBe(413);
    expect((await call(d, '{not json')).status).toBe(400);
    for (const inputs of [[1], 'x', { a: { nested: 1 } }, { a: [1] }]) expect((await call(d, { inputs })).status).toBe(400);
    expect(d.claim).not.toHaveBeenCalled();
    // 본문이 비면 빈 입력으로 — 필수 항목 검사는 실행기가 앱 판으로 한다
    await call(d, '');
    expect(d.execute).toHaveBeenCalledWith(claimed, {});
  });
  it('차지 거절: 무효는 401(사유를 가르지 않음), 60초 안은 429 + Retry-After, 하루 상한은 429 — 실행하지 않는다', async () => {
    const invalid = deps(undefined, { ok: false, reason: 'invalid' });
    expect(await call(invalid)).toEqual({ status: 401, body: { ok: false, error: { message: WEBHOOK_INVALID_TOKEN } }, headers: undefined });
    const soon = deps(undefined, { ok: false, reason: 'too_soon', retry_after: 42 });
    const r = await call(soon);
    expect(r.status).toBe(429); expect(r.headers).toEqual({ 'Retry-After': '42' }); expect(String((r.body.error as { message: string }).message)).toContain(`${WEBHOOK_MIN_INTERVAL_SECONDS}초`);
    const daily = deps(undefined, { ok: false, reason: 'daily_limit' });
    expect((await call(daily)).body).toMatchObject({ error: { message: expect.stringContaining(`${WEBHOOK_DAILY_LIMIT}번`) } });
    for (const d of [invalid, soon, daily]) { expect(d.execute).not.toHaveBeenCalled(); expect(d.finish).not.toHaveBeenCalled(); }
  });
  it('실행 결과: 계정·부서 403, 시작 전 거절은 그 상태(409는 다시 만들라는 안내), 도중 실패 502 — 실패로 기록하고 입력값은 기록에 없다', async () => {
    const cases: Array<[RunAsOutcome, number, string]> = [
      [{ kind: 'user_unavailable' }, 403, WEBHOOK_USER_UNAVAILABLE],
      [{ kind: 'department_changed' }, 403, WEBHOOK_DEPARTMENT_CHANGED],
      [{ kind: 'rejected', status: 409, message: '앱을 새로 열어…' }, 409, WEBHOOK_APP_CHANGED],
      [{ kind: 'rejected', status: 429, message: '이번 달 한도를 넘었습니다' }, 429, '이번 달 한도를 넘었습니다'],
      [{ kind: 'rejected', status: 400, message: '제목은 필수입니다' }, 400, '제목은 필수입니다'],
      [{ kind: 'failed', error: '모델 오류', conversationId: 'c9' }, 502, '모델 오류'],
    ];
    for (const [outcome, status, message] of cases) {
      const d = deps(outcome);
      const res = await call(d);
      expect(res).toMatchObject({ status, body: { ok: false, error: { message } } });
      expect(d.finish).toHaveBeenCalledWith('w1', expect.objectContaining({ last_status: 'failed', last_error: message, last_conversation_id: outcome.kind === 'failed' ? 'c9' : null }));
      expect(d.log).toHaveBeenCalledWith('warning', '앱 연동 실행 실패', expect.objectContaining({ webhook_id: 'w1', status }), 'o1');
      expect(JSON.stringify(d.log.mock.calls)).not.toContain('주간 보고');
    }
  });
  it('실행이 던지면 502로 닫고 오류를 기록하며, 결과 저장이 실패해도 응답은 그대로 간다', async () => {
    const thrown = deps(new Error('DB 끊김'));
    expect((await call(thrown)).status).toBe(502);
    expect(thrown.log.mock.calls.map(c => c[1])).toContain('앱 연동 실행 오류');
    const d = deps(); d.finish.mockRejectedValueOnce(new Error('저장 실패'));
    expect((await call(d)).status).toBe(200);
    expect(d.log.mock.calls.map(c => c[1])).toContain('앱 연동 실행 결과를 저장하지 못함');
  });
});

describe('0049·호출 라우트', () => {
  it('토큰 해시만 저장(유일·64자 16진)·회수 짝 CHECK·RLS·차지 함수는 service_role만, 행 잠금·한국 날짜', () => {
    const sql = readFileSync('supabase/migrations/0049_app_webhooks.sql', 'utf8');
    expect(sql).toContain('token_hash text NOT NULL UNIQUE'); expect(sql).not.toMatch(/\btoken text\b/);
    expect(sql).toContain("CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))");
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY'); expect(sql).toContain('REVOKE ALL ON public.app_webhooks FROM anon, authenticated');
    expect(sql).toContain('FOR UPDATE'); expect(sql).toContain("AT TIME ZONE 'Asia/Seoul'");
    expect(sql).toContain('FROM PUBLIC, anon, authenticated'); expect(sql).toContain('TO service_role');
    const route = readFileSync('src/app/api/apps/webhook/route.ts', 'utf8');
    expect(route).toContain('maxDuration = 300'); expect(route).not.toMatch(/getServerAuthSession/);
  });
});
