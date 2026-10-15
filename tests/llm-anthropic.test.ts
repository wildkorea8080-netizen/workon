import { describe, it, expect, vi, afterEach } from 'vitest';
import { toAnthropicBody, parseAnthropicStream, anthropicAdapter } from '@/lib/llm/anthropic';
import type { LlmStreamEvent } from '@/lib/llm/types';

function sseStream(events: unknown[]): ReadableStream<Uint8Array> {
  const text = events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  // 조각 경계가 이벤트 중간에 걸리도록 7바이트씩 흘린다
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    },
  });
}

async function collect(gen: AsyncGenerator<LlmStreamEvent>) {
  const out: LlmStreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe('Anthropic 요청 변환', () => {
  it('MCP 도구 형식을 Anthropic 형식으로 바꾼다', () => {
    const body = toAnthropicBody(
      {
        model: 'claude-sonnet-4-6',
        system: '지시',
        maxTokens: 100,
        messages: [{ role: 'user', content: '안녕' }],
        tools: [{ name: 'law_search', description: '법령', inputSchema: { type: 'object', properties: {} } }],
        toolChoice: 'none',
      },
      true
    );
    expect(body.tools).toEqual([{ name: 'law_search', description: '법령', input_schema: { type: 'object', properties: {} } }]);
    expect(body.tool_choice).toEqual({ type: 'none' });
    expect(body.stream).toBe(true);
    expect(body.system).toBe('지시');
    expect(body.max_tokens).toBe(100);
  });

  it('도구가 없으면 tool_choice도 보내지 않는다', () => {
    const body = toAnthropicBody({ model: 'm', maxTokens: 1, messages: [], toolChoice: 'none' }, false);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });
});

describe('Anthropic 스트림 해석', () => {
  it('글 조각과 사용량을 낸다', async () => {
    const events = await collect(
      parseAnthropicStream(
        sseStream([
          { type: 'message_start', message: { usage: { input_tokens: 12 } } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '안녕' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '하세요' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
        ]),
        'claude-haiku-4-5'
      )
    );
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('안녕하세요');
    expect(events.at(-1)).toEqual({
      type: 'done',
      stopReason: 'end_turn',
      usage: { model: 'claude-haiku-4-5', input_tokens: 12, output_tokens: 5 },
    });
  });

  it('쪼개진 도구 인자를 모아 한 번에 낸다', async () => {
    const events = await collect(
      parseAnthropicStream(
        sseStream([
          { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'law_search' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"여비"}' } },
          { type: 'content_block_stop', index: 1 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
        ]),
        'm'
      )
    );
    expect(events[0]).toEqual({ type: 'tool_use', id: 't1', name: 'law_search', input: { query: '여비' } });
    expect((events.at(-1) as { stopReason: string }).stopReason).toBe('tool_use');
  });

  it('스트림 중 오류는 던진다', async () => {
    await expect(
      collect(parseAnthropicStream(sseStream([{ type: 'error', error: { message: 'overloaded' } }]), 'm'))
    ).rejects.toThrow('overloaded');
  });
});

describe('Anthropic 비스트리밍 호출', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('사용량의 모델은 요청한 모델이다 (응답 id로 바꾸지 않는다)', async () => {
    // 응답 모델 id(날짜 접미사 등)가 레지스트리에 없으면 단가 조회가 기본 모델로
    // 떨어져 과소 청구된다. 요청한 모델은 정책을 통과한 레지스트리 id다.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            model: 'claude-opus-5-20990101',
            content: [{ type: 'text', text: '제목' }],
            usage: { input_tokens: 7, output_tokens: 3 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    );
    const result = await anthropicAdapter.complete({
      model: 'claude-opus-5',
      maxTokens: 40,
      messages: [{ role: 'user', content: '질문' }],
    });
    expect(result.text).toBe('제목');
    expect(result.usage).toEqual({ model: 'claude-opus-5', input_tokens: 7, output_tokens: 3 });
  });
});
