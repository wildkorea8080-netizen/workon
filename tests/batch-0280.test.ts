import { readFileSync, existsSync } from 'fs';
import { createHmac } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * 2026-11-24 — 입력형 앱의 '기관 연동 시스템 조회' 단계(0102).
 * 기관 전체 관리자가 승인하고 '앱 조회에도 쓰기'를 켠 보낼 곳(0076)에 조회어만 서명해 보내고(POST, 8초, 리다이렉트 안 따름),
 * 받은 답을 다음 단계 자료로 쓴다. 쓸 수 있는 곳인지(기관·회수·허용·동작)는 실행 때마다 다시 본다.
 */

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn(async () => {}) }));
vi.mock('@/lib/crypto', () => ({ decryptApiKey: (s: string) => s, encryptApiKey: (s: string) => s }));

import { parseLookupResponse, OUTBOUND_LOOKUP_DISABLED, OUTBOUND_LOOKUP_GONE, OUTBOUND_LOOKUP_MAX_BYTES, parseCreateEndpoint } from '@/lib/apps/outbound/spec';
import { callExternalLookup, type ExternalLookupDeps } from '@/lib/apps/outbound/lookup';
import { APP_LOOKUP_TOOLS, validateAppDefinition, type AppField, type AppStep } from '@/lib/apps/definition';
import { appLookupRunner, runAppIntermediateSteps, type AppStepRecord } from '@/lib/apps/pipeline';

const ORG = 'org-1';
const EP = '11111111-1111-4111-8111-111111111111';
const ctx = { organizationId: ORG, agentId: 'agent-1', appName: '민원 회신 앱', appVersion: 4 };
const NOW = Date.parse('2026-11-24T03:00:00Z');
const row = (over: Record<string, unknown> = {}) => ({
  id: EP, organization_id: ORG, name: '민원 시스템', url: 'https://minwon.example.go.kr/workon', secret_encrypted: 'wo_out_secret',
  revoked_at: null, lookup_enabled: true, actions: [], ...over,
});
const bodyOf = (text: string, status = 200) => {
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return { status, headers: { get: () => 'application/json' }, body: { getReader: () => ({ read: async () => (sent ? { done: true } : (sent = true, { done: false, value: bytes })), cancel: async () => {} }), cancel: async () => {} } };
};
function deps(over: Partial<ExternalLookupDeps> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const logs: Array<{ message: string; details: Record<string, unknown> }> = [];
  const d: ExternalLookupDeps = {
    loadEndpoint: async () => row(), decrypt: (s) => s, checkHost: async () => ({ ok: true }),
    fetch: async (url, init) => { calls.push({ url, init }); return bodyOf(JSON.stringify({ result: '민원 2026-0012: 처리 중(담당 민원과)', sources: [{ title: '민원 상세', url: 'https://minwon.example.go.kr/c/12' }, { title: '안 받음', url: 'http://x.example/a' }] })); },
    now: () => NOW, newId: () => 'lookup-1', log: async (message, details) => { logs.push({ message, details }); },
    ...over,
  };
  return { d, calls, logs };
}

describe('조회 답 읽기', () => {
  it('JSON 글 칸·출처(https만, 겹침 없음)·그 밖 JSON·글 그대로·빈 답', () => {
    expect(parseLookupResponse(JSON.stringify({ result: ' 처리 중 ', sources: [{ title: 'A', url: 'https://a.kr/1' }, { url: 'https://a.kr/1' }, { title: 'B', url: 'http://b.kr' }, { title: 'C', url: 'javascript:alert(1)' }] })))
      .toEqual({ content: '처리 중', sources: [{ title: 'A', url: 'https://a.kr/1' }] });
    expect(parseLookupResponse(JSON.stringify({ text: '글' }))?.content).toBe('글');
    expect(parseLookupResponse(JSON.stringify({ answer: '답' }))?.content).toBe('답');
    // 글 칸이 없으면 펼친 JSON(출처 칸은 빼고)
    const other = parseLookupResponse(JSON.stringify({ status: '접수', count: 3, sources: [{ title: 'S', url: 'https://s.kr' }] }));
    expect(other?.content).toContain('"status": "접수"');
    expect(other?.content).not.toContain('sources');
    expect(other?.sources).toEqual([{ title: 'S', url: 'https://s.kr' }]);
    expect(parseLookupResponse('[1,2]')?.content).toContain('1');
    expect(parseLookupResponse('﻿평문 답\u0007​')).toEqual({ content: '평문 답', sources: [] });
    for (const empty of ['', '   ', '{}', '[]', JSON.stringify({ sources: [] })]) expect(parseLookupResponse(empty)).toBeNull();
  });
});

describe('연동 시스템 부르기', () => {
  it('조회어만 서명해 보내고(리다이렉트 안 따름·8초) 답을 이름 머리와 함께 돌려준다', async () => {
    const { d, calls } = deps();
    const out = await callExternalLookup(ctx, { endpointId: EP, action: undefined, query: '2026-0012' }, d);
    expect(out).toEqual({ content: '[민원 시스템] 조회 결과\n민원 2026-0012: 처리 중(담당 민원과)', sources: [{ title: '민원 상세', url: 'https://minwon.example.go.kr/c/12' }] });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe('https://minwon.example.go.kr/workon');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ event: 'app.lookup', lookup_id: 'lookup-1', requested_at: '2026-11-24T03:00:00.000Z', query: '2026-0012', app: { id: 'agent-1', name: '민원 회신 앱', version: 4 } });
    const headers = init.headers as Record<string, string>;
    const ts = String(Math.floor(NOW / 1000));
    expect(headers['X-Workon-Timestamp']).toBe(ts);
    expect(headers['X-Workon-Event']).toBe('app.lookup');
    expect(headers['X-Workon-Signature']).toBe(`sha256=${createHmac('sha256', 'wo_out_secret').update(`${ts}.${init.body}`, 'utf8').digest('hex')}`);
    expect(headers['X-Workon-Action']).toBeUndefined();
  });

  it('동작을 정한 곳은 고른 동작을 몸·머리글에 싣고, 안 골랐거나 없어진 동작이면 부르지 않는다', async () => {
    const actions = [{ key: 'status', label: '처리 상태' }];
    const ok = deps({ loadEndpoint: async () => row({ actions }) });
    await callExternalLookup(ctx, { endpointId: EP, action: 'status', query: 'q' }, ok.d);
    expect(JSON.parse(ok.calls[0].init.body as string).action).toEqual({ key: 'status', label: '처리 상태' });
    expect((ok.calls[0].init.headers as Record<string, string>)['X-Workon-Action']).toBe('status');
    for (const action of [undefined, 'gone']) {
      const bad = deps({ loadEndpoint: async () => row({ actions }) });
      const out = await callExternalLookup(ctx, { endpointId: EP, action, query: 'q' }, bad.d);
      expect(out).toMatchObject({ isError: true });
      expect(out.content).toContain('동작');
      expect(bad.calls).toHaveLength(0);
    }
  });

  it('없는·다른 기관·회수된 곳은 GONE, 허용 안 한 곳은 DISABLED — 부르지 않는다', async () => {
    for (const r of [null, row({ organization_id: 'other' }), row({ revoked_at: '2026-11-01T00:00:00Z' })]) {
      const t = deps({ loadEndpoint: async () => r });
      expect(await callExternalLookup(ctx, { endpointId: EP, action: undefined, query: 'q' }, t.d)).toEqual({ content: OUTBOUND_LOOKUP_GONE, sources: [], isError: true });
      expect(t.calls).toHaveLength(0);
    }
    expect(await callExternalLookup(ctx, { endpointId: undefined, action: undefined, query: 'q' }, deps().d)).toMatchObject({ content: OUTBOUND_LOOKUP_GONE, isError: true });
    for (const off of [false, null, undefined]) {
      const t = deps({ loadEndpoint: async () => row({ lookup_enabled: off }) });
      expect(await callExternalLookup(ctx, { endpointId: EP, action: undefined, query: 'q' }, t.d)).toMatchObject({ content: OUTBOUND_LOOKUP_DISABLED, isError: true });
      expect(t.calls).toHaveLength(0);
    }
    const broken = deps({ loadEndpoint: async () => { throw new Error('db'); } });
    expect((await callExternalLookup(ctx, { endpointId: EP, action: undefined, query: 'q' }, broken.d)).content).toContain('읽지 못했습니다');
  });

  it('사설 주소·풀지 못한 비밀값이면 부르지 않는다', async () => {
    const priv = deps({ checkHost: async () => ({ ok: false, retry: false, message: '보낼 주소가 내부망·특수 IP를 가리킵니다. 보낼 수 없습니다.' }) });
    const out = await callExternalLookup(ctx, { endpointId: EP, action: undefined, query: 'q' }, priv.d);
    expect(out).toMatchObject({ isError: true });
    expect(out.content).toContain('내부망');
    expect(priv.calls).toHaveLength(0);
    const sec = deps({ decrypt: () => { throw new Error('key'); } });
    expect((await callExternalLookup(ctx, { endpointId: EP, action: undefined, query: 'q' }, sec.d)).content).toContain('비밀값');
    expect(sec.calls).toHaveLength(0);
  });

  it('2xx가 아니면·3xx·연결 실패·시간 초과·빈 답은 실패 글(응답 원문 없이 운영 기록엔 곳 id·상태만)', async () => {
    const e500 = deps({ fetch: async () => bodyOf('internal stack trace', 500) });
    const out = await callExternalLookup(ctx, { endpointId: EP, action: undefined, query: 'q' }, e500.d);
    expect(out).toEqual({ content: '민원 시스템: HTTP 500로 답했습니다.', sources: [], isError: true });
    expect(e500.logs).toEqual([{ message: expect.any(String), details: { endpoint_id: EP, status: 500 } }]);
    expect(JSON.stringify(e500.logs)).not.toContain('stack');
    expect((await callExternalLookup(ctx, { endpointId: EP, action: undefined, query: 'q' }, deps({ fetch: async () => bodyOf('', 302) }).d)).content).toContain('다른 주소로 넘기려 해');
    const down = deps({ fetch: async () => { throw new TypeError('fetch failed'); } });
    expect((await callExternalLookup(ctx, { endpointId: EP, action: undefined, query: 'q' }, down.d)).content).toContain('연결하지 못했습니다');
    const slow = deps({ fetch: async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; } });
    expect((await callExternalLookup(ctx, { endpointId: EP, action: undefined, query: 'q' }, slow.d)).content).toContain('8초 안에 답하지 않았습니다');
    expect((await callExternalLookup(ctx, { endpointId: EP, action: undefined, query: 'q' }, deps({ fetch: async () => bodyOf('  ') }).d)).content).toContain('빈 답');
  });

  it('긴 답은 앞 64KB만 읽는다', async () => {
    const big = 'a'.repeat(OUTBOUND_LOOKUP_MAX_BYTES + 5000);
    const out = await callExternalLookup(ctx, { endpointId: EP, action: undefined, query: 'q' }, deps({ fetch: async () => bodyOf(big) }).d);
    expect(out.content.length).toBeLessThanOrEqual(OUTBOUND_LOOKUP_MAX_BYTES + 30);
  });
});

const fields: AppField[] = [{ key: 'no', label: '민원 번호', type: 'text', required: true }];
const finalStep: AppStep = { name: '작성', instruction: '조회 결과로 회신을 작성하세요.' };
const def = (lookup: unknown, extra: Record<string, unknown> = {}) => validateAppDefinition({ schemaVersion: 1, fields, output: 'bullets', steps: [{ name: '민원 조회', instruction: '', lookup, ...extra }, finalStep] });

describe('앱 정의', () => {
  it('연동 시스템 조회는 부를 곳이 있어야 하고, 동작은 키 꼴만, 다른 단계에는 곳·동작을 둘 수 없다', () => {
    expect(APP_LOOKUP_TOOLS.external).toMatchObject({ connector: null, external: true });
    expect(def({ tool: 'external', query: '{{no}}', endpoint: EP.toUpperCase(), action: 'status' })).toMatchObject({ ok: true, value: { steps: [{ lookup: { tool: 'external', query: '{{no}}', endpoint: EP, action: 'status' } }, finalStep] } });
    expect(def({ tool: 'external', query: '{{no}}', endpoint: EP })).toMatchObject({ ok: true });
    expect(def({ tool: 'external', query: '{{no}}' })).toMatchObject({ ok: false });
    expect(def({ tool: 'external', query: '{{no}}', endpoint: 'abc' })).toMatchObject({ ok: false });
    expect(def({ tool: 'external', query: '{{no}}', endpoint: EP, action: 'Bad-Key' })).toMatchObject({ ok: false });
    expect(def({ tool: 'law_search', query: '{{no}}', endpoint: EP })).toMatchObject({ ok: false });
    expect(def({ tool: 'doc_search', query: '{{no}}', action: 'status' })).toMatchObject({ ok: false });
    // 더 찾기는 없다(조회어를 AI가 만들어 바깥에 보내지 않는다)
    expect(def({ tool: 'external', query: '{{no}}', endpoint: EP, refine: 1 })).toMatchObject({ ok: false });
  });
});

describe('실행 연결', () => {
  it('실행기는 고른 곳·동작을 넘기고, 출처는 https만 남기며, 연동 부르기가 없으면 멈춘다', async () => {
    const external = vi.fn(async () => ({ content: '처리 중', sources: [{ title: 'h', url: 'https://a.kr/1' }, { title: 'x', url: 'http://a.kr/2' }] }));
    const runner = appLookupRunner({ capabilities: {} }, vi.fn(), undefined, external);
    const steps: AppStep[] = [{ name: '민원 조회', instruction: '', lookup: { tool: 'external', query: '{{no}} 처리 상태', endpoint: EP, action: 'status' } }, finalStep];
    const records: AppStepRecord[] = steps.map((s) => ({ name: s.name, status: 'pending' }));
    const result = await runAppIntermediateSteps({
      steps, records, model: 'm', system: '역할', messages: [{ role: 'user', content: '원문' }], inputs: { no: '2026-0012' },
      usage: { model: 'm', input_tokens: 0, output_tokens: 0 }, guard: vi.fn(async () => {}), update: vi.fn(),
      complete: vi.fn(async () => ({ text: 'x', usage: { model: 'm', input_tokens: 1, output_tokens: 1 } })) as never, lookup: runner,
    });
    expect(external).toHaveBeenCalledWith('2026-0012 처리 상태', EP, 'status');
    expect(records[0]).toMatchObject({ status: 'completed', kind: 'lookup', output: '처리 중', sources: [{ title: 'h', url: 'https://a.kr/1' }] });
    expect(JSON.stringify(result.messages)).toContain('기관 연동 시스템 조회 포함');
    const none = await appLookupRunner({ capabilities: {} }, vi.fn())('external', 'q', undefined, undefined, undefined, { endpoint: EP });
    expect(none).toMatchObject({ isError: true });
  });

  it('대화 실행기·빌더·관리자 화면·보낼 곳 관리가 이어져 있다', () => {
    const stream = readFileSync('src/lib/assistant/stream.ts', 'utf8');
    expect(stream).toContain('(deps.externalLookup ?? callExternalLookup)({ organizationId: turn.ctx.organizationId, agentId: turn.ctx.agentId');
    expect(readFileSync('src/lib/assistant/prepare.ts', 'utf8')).toContain("...(body.app_inputs !== undefined ? { appName: agent.name } : {}),");
    const builder = readFileSync('src/app/apps/builder/page.tsx', 'utf8');
    expect(builder).toContain('result.data.filter(e => e.lookupEnabled === true)');
    expect(builder).toContain('lookupEndpoints={lookupEndpoints}');
    const editor = readFileSync('src/components/apps/AppStepEditor.tsx', 'utf8');
    expect(editor).toContain('부를 연동 시스템');
    expect(editor).toContain("(관리자가 허용한 곳 없음)");
    const panel = readFileSync('src/components/admin/OutboundEndpointsPanel.tsx', 'utf8');
    expect(panel).toContain('lookup_enabled: next');
    expect(panel).toContain('lookup_enabled: lookupEnabled');
    const admin = readFileSync('src/lib/apps/outbound/admin.ts', 'utf8');
    expect(admin).toContain('...(lookupEnabled !== undefined ? { lookup_enabled: lookupEnabled } : {})');
    expect(parseCreateEndpoint({ name: '민원', url: 'https://minwon.example.go.kr/a', lookup_enabled: true })).toMatchObject({ ok: true, value: { lookupEnabled: true } });
    expect(parseCreateEndpoint({ name: '민원', url: 'https://minwon.example.go.kr/a', lookup_enabled: 'true' })).toMatchObject({ ok: true, value: { lookupEnabled: false } });
    expect(existsSync('supabase/migrations/0102_outbound_lookup.sql')).toBe(true);
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0102 — 앱 조회 허용 칸(시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('기본 꺼짐·NULL 안 됨·여러 번 적용해도 안전', async () => {
    await db.query('BEGIN');
    try {
      const sql = readFileSync('supabase/migrations/0102_outbound_lookup.sql', 'utf8');
      await db.query(sql); await db.query(sql);
      const { rows } = await db.query("SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = 'app_outbound_endpoints' AND column_name = 'lookup_enabled'");
      expect(rows).toEqual([{ is_nullable: 'NO', column_default: 'false' }]);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
