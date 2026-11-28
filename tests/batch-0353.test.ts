// tests/batch-0353.test.ts
// 답변 멈추기(2026-11-28, 0137) — 길게 흐르는 답을 직원이 도중에 멈춘다. 연결 끊기가 아니라 따로 보낸 멈춤 요청으로 멈추고
// (끊기면 답은 끝까지 저장 — 그대로), 받은 데까지 저장하며 쓴 토큰은 받은 글로 어림해 기록한다(조용한 과소 청구가 없게)
import { readFileSync } from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Write = { table: string; op: string; rows: Record<string, unknown>[] };
const writes: Write[] = [];
vi.mock('@/lib/usage-limit', async (original) => ({ ...await original<typeof import('@/lib/usage-limit')>(), checkTokenLimit: async () => ({ allowed: true }) }));
vi.mock('@/lib/supabaseAdmin', () => {
  const thenable = (value: unknown) => ({ eq: () => thenable(value), select: () => thenable(value), then: (r: (v: unknown) => unknown) => Promise.resolve(value).then(r) });
  return {
    supabaseAdmin: {
      from(table: string) {
        return {
          insert(rows: Record<string, unknown> | Record<string, unknown>[]) { writes.push({ table, op: 'insert', rows: Array.isArray(rows) ? rows : [rows] }); return thenable({ data: null, error: null }); },
          update(row: Record<string, unknown>) { writes.push({ table, op: 'update', rows: [row] }); return thenable({ data: null, error: null }); },
        };
      },
    },
  };
});

import { estimateOutputTokens, parseAnthropicStream } from '@/lib/llm/anthropic';
import { setLlmAdapterForTests } from '@/lib/llm';
import type { LlmAdapter, LlmRequest, LlmStreamEvent } from '@/lib/llm/types';
import { runToolLoop, streamTurn } from '@/lib/assistant/stream';
import { requestStop, watchStop } from '@/lib/assistant/stop';
import { STOPPED_EMPTY_TEXT } from '@/lib/assistant/stop-spec';
import type { PreparedTurn, TurnEvent } from '@/lib/assistant/types';
import { API_ROUTES } from '@/lib/api-route-ids';

const MODEL = 'claude-haiku-4-5';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => { writes.length = 0; });
afterEach(() => { setLlmAdapterForTests(null); });

describe('업체 응답 받기를 도중에 그만두기', () => {
  it('받은 글로 출력 토큰을 어림한다 — 한글은 한 글자 한 토큰, 그 밖은 세 글자 한 토큰', () => {
    expect(estimateOutputTokens('')).toBe(0);
    expect(estimateOutputTokens('가나다')).toBe(3);
    expect(estimateOutputTokens('abcdef')).toBe(2);
    expect(estimateOutputTokens('예산 1,000')).toBe(2 + Math.ceil(6 / 3));
  });

  it('멈추면 기다리던 읽기가 풀리고 stopReason "stopped"·입력 토큰·어림한 출력 토큰으로 끝난다', async () => {
    const enc = new TextEncoder();
    const sse = (o: unknown) => enc.encode(`data: ${JSON.stringify(o)}\n\n`);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(sse({ type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 1 } } }));
        c.enqueue(sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
        c.enqueue(sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '예산은 다음과' } }));
        // 끝을 보내지 않는다 — 업체가 아직 쓰는 중
      },
    });
    const controller = new AbortController();
    const events: LlmStreamEvent[] = [];
    for await (const e of parseAnthropicStream(body, MODEL, controller.signal)) {
      events.push(e);
      if (e.type === 'text') controller.abort();
    }
    const done = events[events.length - 1];
    expect(done).toEqual({ type: 'done', stopReason: 'stopped', usage: { model: MODEL, input_tokens: 50, output_tokens: estimateOutputTokens('예산은 다음과'), output_estimated: true } });
  });

  it('끝(stop_reason)을 받은 뒤의 멈춤은 멈춘 답이 아니다', async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } })}\n\n`));
      },
    });
    const controller = new AbortController();
    const events: LlmStreamEvent[] = [];
    const run = (async () => { for await (const e of parseAnthropicStream(body, MODEL, controller.signal)) events.push(e); })();
    await sleep(5);
    controller.abort();
    await run;
    expect(events[events.length - 1]).toMatchObject({ type: 'done', stopReason: 'end_turn', usage: { output_tokens: 9 } });
  });
});

describe('도구 루프', () => {
  it('멈춘 라운드 뒤에는 도구도 다음 라운드도 부르지 않는다', async () => {
    const execute = vi.fn(async () => ({ ok: true, text: 'x' }));
    let calls = 0;
    setLlmAdapterForTests({
      async *stream() {
        calls++;
        yield { type: 'text', text: '찾아' };
        yield { type: 'tool_use', id: 't1', name: 'law_search', input: {} };
        yield { type: 'done', stopReason: 'stopped', usage: { model: MODEL, input_tokens: 10, output_tokens: 3, output_estimated: true } };
      },
      async complete() { throw new Error('부르지 않는다'); },
    });
    const owner = { id: 'public_data', execute } as never;
    const result = await runToolLoop({
      modelId: MODEL, systemPrompt: 'S', messages: [{ role: 'user', content: 'q' }],
      tools: [{ name: 'law_search', description: '', inputSchema: {} }], owners: new Map([['law_search', owner]]),
      ctx: {} as never, maxRounds: 4, stopSignal: new AbortController().signal,
    }, () => undefined);
    expect(result.stopped).toBe(true);
    expect(result.text).toBe('찾아');
    expect(execute).not.toHaveBeenCalled();
    expect(calls).toBe(1);
    expect(result.usage.output_estimated).toBe(true);
  });
});

function turn(): PreparedTurn {
  return {
    ctx: { organizationId: 'o', departmentId: 'd', userId: 'u', agentId: 'a', agentVersion: 7, capabilities: {}, message: '질문', conversationId: 'c1', attachments: [], preflight: {}, skipDocuments: false },
    modelId: MODEL, modelSubstituted: false, systemPrompt: 'S', messages: [{ role: 'user', content: '질문' }], tools: [], capabilities: [],
    conversationId: 'c1', isNewConversation: false, chunks: [], storedUserContent: '질문', documentsSkipped: false, docDropped: null, verifySources: [], verifyTenant: null,
  };
}

/** 신호가 걸릴 때까지 글을 조금씩 내는 업체 */
function slowAdapter(): LlmAdapter {
  return {
    async *stream(req: LlmRequest) {
      for (let i = 0; i < 200; i++) {
        if (req.signal?.aborted) {
          yield { type: 'done', stopReason: 'stopped', usage: { model: req.model, input_tokens: 40, output_tokens: i, output_estimated: true } };
          return;
        }
        yield { type: 'text', text: '가' };
        await sleep(2);
      }
      yield { type: 'done', stopReason: 'end_turn', usage: { model: req.model, input_tokens: 40, output_tokens: 200 } };
    },
    async complete(req) { return { text: '제목', usage: { model: req.model, input_tokens: 1, output_tokens: 1 } }; },
  };
}

describe('한 턴 — 멈춤 요청', () => {
  it('meta의 답 id로 멈춤이 적히면 받은 데까지 저장하고, 사용 기록·done에 멈춤을 남긴다', async () => {
    setLlmAdapterForTests(slowAdapter());
    const events: TurnEvent[] = [];
    let stopFor: string | null = null;
    const read = vi.fn(async () => stopFor);
    await streamTurn(turn(), (e) => {
      events.push(e);
      if (e.event === 'meta') stopFor = (e.data as { message_id: string }).message_id;
    }, { stopRequested: read, stopPollMs: 5, verify: async () => { throw new Error('멈춘 답은 검증하지 않는다'); } });

    const meta = events.find((e) => e.event === 'meta')!.data as { message_id: string };
    const done = events.find((e) => e.event === 'done')!.data as Record<string, unknown>;
    expect(done.stopped).toBe(true);
    expect(done.message_id).toBe(meta.message_id);
    expect(read).toHaveBeenCalledWith('c1');

    const [user, answer] = writes.find((w) => w.table === 'messages')!.rows;
    expect(answer.id).toBe(meta.message_id);
    expect((answer.content as string).length).toBeGreaterThan(0);
    expect((answer.content as string).length).toBeLessThan(200);
    expect((answer.source_references as Record<string, unknown>).stopped).toBe(true);
    expect(Object.keys(user).sort()).toEqual(Object.keys(answer).sort());

    const usage = writes.find((w) => w.table === 'usage_logs')!.rows[0].details as Record<string, unknown>;
    expect(usage).toMatchObject({ stopped: true, output_estimated: true, input_tokens: 40 });
  });

  it('다른 답 id의 멈춤(앞 턴에 남은 것)은 이 턴을 멈추지 않는다', async () => {
    setLlmAdapterForTests(slowAdapter());
    const events: TurnEvent[] = [];
    await streamTurn(turn(), (e) => events.push(e), { stopRequested: async () => '00000000-0000-4000-8000-000000000000', stopPollMs: 5 });
    const done = events.find((e) => e.event === 'done')!.data as Record<string, unknown>;
    expect(done.stopped).toBeUndefined();
    const answer = writes.find((w) => w.table === 'messages')!.rows[1];
    expect(answer.content).toBe('가'.repeat(200));
    expect((answer.source_references as Record<string, unknown>).stopped).toBeUndefined();
  });

  it('글을 받기 전에 멈췄으면 그렇다고 적어 저장한다', async () => {
    setLlmAdapterForTests({
      async *stream(req) { await sleep(30); yield { type: 'done', stopReason: req.signal?.aborted ? 'stopped' : 'end_turn', usage: { model: req.model, input_tokens: 5, output_tokens: 0 } }; },
      async complete(req) { return { text: '제목', usage: { model: req.model, input_tokens: 1, output_tokens: 1 } }; },
    });
    let stopFor: string | null = null;
    await streamTurn(turn(), (e) => { if (e.event === 'meta') stopFor = (e.data as { message_id: string }).message_id; }, { stopRequested: async () => stopFor, stopPollMs: 5 });
    expect(writes.find((w) => w.table === 'messages')!.rows[1].content).toBe(STOPPED_EMPTY_TEXT);
  });
});

describe('멈춤 요청 읽기·쓰기', () => {
  it('못 읽으면 멈추지 않고(답은 그대로), 다른 id면 멈추지 않으며, 끝내면 더 읽지 않는다', async () => {
    const failing = watchStop({ conversationId: 'c', messageId: 'm', read: async () => { throw Object.assign(new Error('x'), { code: '42703' }); }, everyMs: 3 });
    await sleep(20);
    expect(failing.signal.aborted).toBe(false);
    failing.end();
    const read = vi.fn(async () => 'other');
    const other = watchStop({ conversationId: 'c', messageId: 'm', read, everyMs: 3 });
    await sleep(20);
    expect(other.signal.aborted).toBe(false);
    other.end();
    const n = read.mock.calls.length;
    await sleep(20);
    expect(read.mock.calls.length).toBe(n);
  });

  it('대화 주인만 — 맞는 행이 없으면 not_found', async () => {
    const calls: unknown[][] = [];
    const db = (rows: unknown[]) => ({
      from: (t: string) => {
        const q: Record<string, unknown> = {};
        q.update = (v: unknown) => { calls.push(['update', t, v]); return q; };
        q.eq = (...a: unknown[]) => { calls.push(['eq', ...a]); return q; };
        q.select = () => Promise.resolve({ data: rows, error: null });
        return q;
      },
    });
    expect(await requestStop({ conversationId: 'c1', userId: 'u1', messageId: 'm1' }, db([{ id: 'c1' }]) as never)).toBe('ok');
    expect(calls).toEqual(expect.arrayContaining([['update', 'conversations', { stop_message_id: 'm1' }], ['eq', 'id', 'c1'], ['eq', 'user_id', 'u1']]));
    expect(await requestStop({ conversationId: 'c1', userId: 'u2', messageId: 'm1' }, db([]) as never)).toBe('not_found');
  });
});

describe('라우트·화면', () => {
  it('대화 라우트만 멈춤을 읽고, 연결 끊기로는 멈추지 않는다', () => {
    const chat = readFileSync('src/app/api/chat/route.ts', 'utf8');
    expect(chat).toMatch(/stopRequested: \(conversationId\) => readStopRequest\(conversationId\)/);
    expect(chat).not.toMatch(/cancel\(/);
    const stop = readFileSync('src/app/api/conversations/[id]/stop/route.ts', 'utf8');
    expect(stop).toMatch(/requestStop\(\{ conversationId: params\.id, userId: session\.user\.id, messageId \}\)/);
    expect(stop).toMatch(/잠시 뒤 다시 눌러 주세요\.', 503\)/);
    expect(API_ROUTES).toContain('conversations/[id]/stop');
    expect(readFileSync('supabase/migrations/0137_conversation_stop.sql', 'utf8')).toMatch(/ADD COLUMN IF NOT EXISTS stop_message_id uuid/);
  });
  it('입력형 앱 실행은 멈추지 않는다', () => {
    const src = readFileSync('src/lib/assistant/stream.ts', 'utf8');
    expect(src).toMatch(/deps\.stopRequested && !turn\.appSteps\?\.length/);
    const ui = readFileSync('src/components/chat/ChatInterface.tsx', 'utf8');
    expect(ui).toMatch(/!selectedAgent\.app_definition\) \{\s*stopTargetRef\.current/);
    expect(ui).not.toMatch(/AbortController/);
    expect(ui).toMatch(/\/stop`/);
  });
});
