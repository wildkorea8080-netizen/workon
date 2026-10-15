import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * 대화 한 턴(streamTurn)의 저장·기록.
 *
 * 이 경로의 실패는 전부 조용하다. 답변은 이미 화면에 흘러간 뒤라, 메시지가
 * 저장되지 않거나 사용 기록이 빠져도 오류가 보이지 않는다 — 새로고침하면
 * 대화가 사라지고, 쓴 만큼 청구되지 않는다. 그래서 가짜 DB에 실제로 들어간
 * 행을 본다.
 */

type Write = { table: string; op: 'insert' | 'update'; rows: Record<string, unknown>[] };
const writes: Write[] = [];

vi.mock('@/lib/supabaseAdmin', () => {
  const result = { data: null, error: null };
  const thenable = (value: unknown) => ({
    eq: () => thenable(value),
    select: () => thenable(value),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve),
  });
  return {
    supabaseAdmin: {
      from(table: string) {
        return {
          insert(rows: Record<string, unknown> | Record<string, unknown>[]) {
            writes.push({ table, op: 'insert', rows: Array.isArray(rows) ? rows : [rows] });
            return thenable(result);
          },
          update(row: Record<string, unknown>) {
            writes.push({ table, op: 'update', rows: [row] });
            return thenable(result);
          },
        };
      },
    },
  };
});

import { setLlmAdapterForTests } from '@/lib/llm';
import type { LlmAdapter, LlmStreamEvent } from '@/lib/llm/types';
import { streamTurn } from '@/lib/assistant/stream';
import { storedUserContent, buildUserContent } from '@/lib/assistant/prompt';
import type { PreparedTurn, TurnEvent } from '@/lib/assistant/types';

const MODEL = 'claude-haiku-4-5';
const IMAGE_DATA = 'SU1BR0VCWVRFU19TSE9VTERfTk9UX0JFX1NUT1JFRA==';

function turn(overrides: Partial<PreparedTurn> = {}): PreparedTurn {
  return {
    ctx: {
      organizationId: 'o', departmentId: 'd', userId: 'u', agentId: 'a', agentVersion: 7, capabilities: {}, message: '질문', conversationId: 'c1',
    },
    modelId: MODEL,
    modelSubstituted: false,
    systemPrompt: 'S',
    messages: [{ role: 'user', content: '질문' }],
    tools: [],
    capabilities: [],
    conversationId: 'c1',
    isNewConversation: true,
    chunks: [],
    storedUserContent: '질문',
    ...overrides,
  };
}

/** 스트림은 정해 둔 사건을, 제목 호출은 정해 둔 글을 낸다 */
function adapter(opts: { stream?: () => AsyncGenerator<LlmStreamEvent>; title?: () => Promise<string> } = {}): LlmAdapter {
  return {
    stream:
      opts.stream ??
      async function* () {
        yield { type: 'text', text: '답' };
        yield { type: 'done', stopReason: 'end_turn', usage: { model: 'IGNORED', input_tokens: 10, output_tokens: 5 } };
      },
    async complete(req) {
      const text = opts.title ? await opts.title() : '여비 문의';
      return { text, usage: { model: req.model, input_tokens: 3, output_tokens: 2 } };
    },
  };
}

const inserted = (table: string) =>
  writes.filter((w) => w.table === table && w.op === 'insert').flatMap((w) => w.rows);
const details = (row: Record<string, unknown>) => row.details as Record<string, unknown>;
const keySet = (row: Record<string, unknown>) => Object.keys(row).sort().join(',');

async function run(t: PreparedTurn, send?: (e: TurnEvent) => void) {
  const events: TurnEvent[] = [];
  await streamTurn(t, send ?? ((e) => events.push(e)));
  return events;
}

beforeEach(() => {
  writes.length = 0;
});
afterEach(() => {
  setLlmAdapterForTests(null);
  vi.restoreAllMocks();
});

describe('streamTurn — 성공', () => {
  it('만든 파일을 답변 행의 source_references.files에 남긴다', async () => {
    const file = { id: 'f1', file_name: '회의록.hwpx', size_bytes: 10 };
    const tool = { name: 'fill_template', description: '', inputSchema: { type: 'object' as const, properties: {} } };
    const cap = {
      id: 'document', label: '', description: '', isAvailable: () => true,
      tools: () => [tool],
      execute: async () => ({ ok: true, text: 'ok', files: [file] }),
    } as never;
    let round = 0;
    setLlmAdapterForTests(
      adapter({
        stream: async function* () {
          round += 1;
          if (round === 1) {
            yield { type: 'tool_use', id: 't1', name: 'fill_template', input: {} };
            yield { type: 'done', stopReason: 'tool_use', usage: { model: 'IGNORED', input_tokens: 1, output_tokens: 1 } };
          } else {
            yield { type: 'text', text: '만들었습니다' };
            yield { type: 'done', stopReason: 'end_turn', usage: { model: 'IGNORED', input_tokens: 1, output_tokens: 1 } };
          }
        },
      })
    );
    const events = await run(turn({ capabilities: [cap], tools: [tool] }));
    const rows = inserted('messages');
    expect((rows[1].source_references as { files: unknown[] }).files).toEqual([file]);
    expect(keySet(rows[0])).toBe(keySet(rows[1]));
    expect(events.find((e) => e.event === 'tool_end')).toEqual({
      event: 'tool_end', data: { name: 'fill_template', ok: true, sources: [], files: [file] },
    });
  });

  it('메시지 두 행을 같은 키 집합으로, 판 번호와 함께 저장한다', async () => {
    setLlmAdapterForTests(adapter());
    await run(turn());
    const rows = inserted('messages');
    expect(rows).toHaveLength(2);
    expect(keySet(rows[0])).toBe(keySet(rows[1]));
    expect(rows.map((r) => r.agent_version)).toEqual([7, 7]);
    expect(rows.map((r) => r.content)).toEqual(['질문', '답']);
  });

  it('대화 사용량을 이번 턴 모델·원가와 함께 기록한다', async () => {
    setLlmAdapterForTests(adapter());
    await run(turn());
    const chat = inserted('usage_logs').filter((r) => r.action === 'chat_message');
    expect(chat).toHaveLength(1);
    expect(chat[0].department_id).toBe('d');
    expect(details(chat[0])).toMatchObject({ model: MODEL, input_tokens: 10, output_tokens: 5, agent_version: 7 });
    expect(details(chat[0]).cost_krw).toEqual(expect.any(Number));
    expect(details(chat[0])).not.toHaveProperty('aborted');
  });

  it('새 대화면 제목 생성도 이번 턴 모델로 기록하고 제목을 바꾼다', async () => {
    // 기본 모델은 기관 허용 목록에 없을 수 있다
    setLlmAdapterForTests(adapter());
    const events = await run(turn());
    const title = inserted('usage_logs').filter((r) => r.action === 'conversation_title');
    expect(title).toHaveLength(1);
    expect(details(title[0])).toMatchObject({ model: MODEL, input_tokens: 3, output_tokens: 2 });
    expect(details(title[0]).cost_krw).toEqual(expect.any(Number));
    expect(writes.find((w) => w.table === 'conversations' && w.op === 'update')?.rows[0]).toEqual({ title: '여비 문의' });
    expect(events.at(-1)).toEqual({
      event: 'done',
      data: { usage: { model: MODEL, input_tokens: 10, output_tokens: 5 }, title: '여비 문의' },
    });
  });

  it('이어지는 대화면 제목을 만들지 않는다', async () => {
    setLlmAdapterForTests(adapter());
    const events = await run(turn({ isNewConversation: false }));
    expect(inserted('usage_logs').some((r) => r.action === 'conversation_title')).toBe(false);
    expect(events[0].event).toBe('meta');
    expect(events.at(-1)?.event).toBe('done');
  });

  it('제목 생성이 실패해도 끝까지 가고 이유를 남긴다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setLlmAdapterForTests(adapter({ title: async () => { throw new Error('과부하'); } }));
    const events = await run(turn());
    expect(events.at(-1)).toMatchObject({ event: 'done', data: { title: null } });
    expect(warn).toHaveBeenCalledWith('[assistant] 제목 생성 실패', expect.anything());
  });
});

describe('streamTurn — 사진', () => {
  it('사진 바이트는 메시지 행에 들어가지 않고 첨부 표시만 남는다', async () => {
    // 이력 20개에 실어 되돌려 보내면 매 턴 사진 토큰이 다시 청구되고, 현장 사진·
    // 명단 같은 개인정보를 보관하게 된다.
    setLlmAdapterForTests(adapter());
    const images = [{ media_type: 'image/jpeg', data: IMAGE_DATA }] as never;
    await run(
      turn({
        messages: [{ role: 'user', content: buildUserContent('질문', images) }],
        storedUserContent: storedUserContent('질문', 1),
      })
    );
    const rows = inserted('messages');
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain(IMAGE_DATA);
    expect(rows[0].content).toContain('1장');
  });
});

describe('streamTurn — 실패', () => {
  it('루프가 던지면 쓴 토큰을 aborted로 남기고 error를 보낸다', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setLlmAdapterForTests(
      adapter({
        stream: async function* () {
          yield { type: 'tool_use', id: 't1', name: 'nope', input: {} };
          yield { type: 'done', stopReason: 'tool_use', usage: { model: 'IGNORED', input_tokens: 8, output_tokens: 4 } };
          throw new Error('연결 오류');
        },
      })
    );
    const events = await run(turn());
    const chat = inserted('usage_logs').filter((r) => r.action === 'chat_message');
    expect(chat).toHaveLength(1);
    expect(details(chat[0])).toMatchObject({ aborted: true, model: MODEL, input_tokens: 8, output_tokens: 4 });
    expect(inserted('messages')).toHaveLength(0);
    expect(events.at(-1)).toEqual({ event: 'error', data: { message: '연결 오류' } });
  });

  it('보내기가 던져도(연결 끊김) 저장과 기록은 계속된다', async () => {
    // 라우트가 enqueue 실패를 삼키지만, 실행기 자신도 보내기 실패로 저장을 건너뛰면 안 된다
    setLlmAdapterForTests(adapter());
    await run(turn(), () => {
      throw new Error('클라이언트가 떠났다');
    });
    expect(inserted('messages')).toHaveLength(2);
    expect(inserted('usage_logs').map((r) => r.action).sort()).toEqual(['chat_message', 'conversation_title']);
    expect(details(inserted('usage_logs').find((r) => r.action === 'chat_message')!)).not.toHaveProperty('aborted');
  });
});
