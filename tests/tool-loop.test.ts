import { describe, it, expect, afterEach } from 'vitest';
import { setLlmAdapterForTests } from '@/lib/llm';
import type { LlmAdapter, LlmRequest, LlmStreamEvent } from '@/lib/llm/types';
import { runToolLoop, TOOL_LIMIT_NOTICE, TRUNCATED_TOOL_NOTICE, type LoopProgress } from '@/lib/assistant/stream';
import type { Capability, TurnContext } from '@/lib/capabilities/types';
import type { TurnEvent } from '@/lib/assistant/types';

/** 차례대로 정해 둔 응답을 내는 가짜 어댑터. 받은 요청을 모두 남긴다. */
function scripted(rounds: LlmStreamEvent[][]): LlmAdapter & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  let i = 0;
  return {
    requests,
    async *stream(req) {
      requests.push(JSON.parse(JSON.stringify(req)));
      const events = rounds[Math.min(i, rounds.length - 1)];
      i += 1;
      for (const e of events) yield e;
    },
    async complete() {
      throw new Error('쓰지 않음');
    },
  };
}

const done = (stopReason: string, input = 10, output = 5): LlmStreamEvent => ({
  type: 'done', stopReason, usage: { model: 'IGNORED', input_tokens: input, output_tokens: output },
});
const toolCall = (id: string): LlmStreamEvent => ({ type: 'tool_use', id, name: 'law_search', input: { q: '여비' } });

const ctx: TurnContext = {
  organizationId: 'o', departmentId: 'd', userId: 'u', agentId: 'a', agentVersion: 1, capabilities: {}, message: 'q', conversationId: 'c',
};

function lawCapability(execute: Capability['execute']): Capability {
  return { id: 'public_data', label: '', description: '', isAvailable: () => true, execute };
}

const tools = [{ name: 'law_search', description: '', inputSchema: { type: 'object', properties: {} } }];

async function run(adapter: LlmAdapter, owners: Map<string, Capability>, maxRounds = 4) {
  setLlmAdapterForTests(adapter);
  const events: TurnEvent[] = [];
  const result = await runToolLoop(
    { modelId: 'claude-haiku-4-5', systemPrompt: 'S', messages: [{ role: 'user', content: 'q' }], tools, owners, ctx, maxRounds },
    (e) => events.push(e)
  );
  return { result, events };
}

afterEach(() => setLlmAdapterForTests(null));

describe('도구 루프', () => {
  it('도구 없이 끝나면 한 번만 부른다', async () => {
    const adapter = scripted([[{ type: 'text', text: '답' }, done('end_turn')]]);
    const { result, events } = await run(adapter, new Map());
    expect(adapter.requests).toHaveLength(1);
    expect(result.text).toBe('답');
    expect(events).toEqual([{ event: 'delta', data: { text: '답' } }]);
  });

  it('사용량을 실제 쓴 모델로 라운드마다 더한다', async () => {
    // 예전 /api/chat은 usage.model을 기본 모델로 두어, 다른 모델을 써도
    // 기본 모델 단가로 정산됐다.
    const owners = new Map([['law_search', lawCapability(async () => ({ ok: true, text: '조문' }))]]);
    const adapter = scripted([[toolCall('t1'), done('tool_use', 10, 5)], [{ type: 'text', text: '답' }, done('end_turn', 20, 7)]]);
    const { result } = await run(adapter, owners);
    expect(result.usage).toEqual({ model: 'claude-haiku-4-5', input_tokens: 30, output_tokens: 12 });
  });

  it('도구 결과를 붙여 다시 부른다', async () => {
    const owners = new Map([['law_search', lawCapability(async () => ({ ok: true, text: '조문', sources: { links: [{ title: '여비규정', url: 'https://law' }] } }))]]);
    const adapter = scripted([[toolCall('t1'), done('tool_use')], [{ type: 'text', text: '답' }, done('end_turn')]]);
    const { result, events } = await run(adapter, owners);
    const second = adapter.requests[1].messages;
    expect(second.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: '조문', is_error: false }],
    });
    expect(result.links).toEqual([{ title: '여비규정', url: 'https://law' }]);
    expect(events.map((e) => e.event)).toEqual(['tool_start', 'tool_end', 'delta']);
  });

  it('도구가 만든 파일을 tool_end와 결과에 싣는다', async () => {
    const file = { id: 'f1', file_name: '회의록.hwpx', size_bytes: 1234 };
    const adapter = scripted([[toolCall('t1'), done('tool_use')], [{ type: 'text', text: '만들었습니다' }, done('end_turn')]]);
    const owners = new Map([['law_search', lawCapability(async () => ({ ok: true, text: 'ok', files: [file] }))]]);
    const { result, events } = await run(adapter, owners);
    expect(events).toContainEqual({ event: 'tool_end', data: { name: 'law_search', ok: true, sources: [], files: [file] } });
    expect(result.files).toEqual([file]);
  });

  it('도구가 던져도 대화는 이어지고 이유가 남는다', async () => {
    const owners = new Map([['law_search', lawCapability(async () => { throw new Error('법제처 응답 없음'); })]]);
    const adapter = scripted([[toolCall('t1'), done('tool_use')], [{ type: 'text', text: '조회에 실패했습니다' }, done('end_turn')]]);
    const { events } = await run(adapter, owners);
    const result = (adapter.requests[1].messages.at(-1)!.content as { content: string; is_error: boolean }[])[0];
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('법제처 응답 없음');
    expect(events.find((e) => e.event === 'tool_end')).toEqual({
      event: 'tool_end', data: { name: 'law_search', ok: false, sources: [], files: [] },
    });
  });

  it('꺼내 주지 않은 도구는 실행하지 않는다', async () => {
    const adapter = scripted([[toolCall('t1'), done('tool_use')], [done('end_turn')]]);
    await run(adapter, new Map());
    const result = (adapter.requests[1].messages.at(-1)!.content as { content: string; is_error: boolean }[])[0];
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('허용되지 않은 도구');
  });

  it('상한에 걸리면 도구를 유지한 채 tool_choice=none으로 마무리한다', async () => {
    // tools를 빼면 이력의 tool_use 블록 때문에 Anthropic이 400을 준다
    const owners = new Map([['law_search', lawCapability(async () => ({ ok: true, text: '조문' }))]]);
    const adapter = scripted([[toolCall('t'), done('tool_use')], [toolCall('t2'), done('tool_use')], [{ type: 'text', text: '마무리' }, done('end_turn')]]);
    const { result, events } = await run(adapter, owners, 2);
    const last = adapter.requests.at(-1)!;
    expect(adapter.requests).toHaveLength(3);
    expect(last.toolChoice).toBe('none');
    expect(last.tools).toEqual(tools);
    expect(last.system).toContain(TOOL_LIMIT_NOTICE);
    expect(events.some((e) => e.event === 'tool_limit')).toBe(true);
    expect(result.text).toBe('마무리');
  });

  it('출력 상한으로 도구 호출이 잘리면 실행하지 않고 안내 문구를 남긴다', async () => {
    // 잘린 tool_use는 입력이 {}로 오므로 실행하면 빈 입력으로 도구가 돈다
    let executed = 0;
    const owners = new Map([['law_search', lawCapability(async () => { executed += 1; return { ok: true, text: 'x' }; })]]);
    const adapter = scripted([[{ type: 'text', text: '네' }, { type: 'tool_use', id: 't1', name: 'law_search', input: {} }, done('max_tokens')]]);
    const { result, events } = await run(adapter, owners);
    expect(executed).toBe(0);
    expect(adapter.requests).toHaveLength(1);
    expect(result.text).toBe(`네\n\n${TRUNCATED_TOOL_NOTICE}`);
    expect(events).toContainEqual({ event: 'delta', data: { text: `\n\n${TRUNCATED_TOOL_NOTICE}` } });
    expect(events.some((e) => e.event === 'tool_start' || e.event === 'tool_end')).toBe(false);
  });

  it('앞에 쓴 글이 없으면 안내 문구로 시작한다', async () => {
    const owners = new Map([['law_search', lawCapability(async () => ({ ok: true, text: 'x' }))]]);
    const adapter = scripted([[{ type: 'tool_use', id: 't1', name: 'law_search', input: {} }, done('max_tokens')]]);
    const { result, events } = await run(adapter, owners);
    expect(result.text).toBe(TRUNCATED_TOOL_NOTICE);
    expect(events).toEqual([{ event: 'delta', data: { text: TRUNCATED_TOOL_NOTICE } }]);
  });

  it('능력이 쓴 AI 사용량을 따로 모은다', async () => {
    const owners = new Map([['law_search', lawCapability(async () => ({ ok: true, text: 'x', usage: [{ model: 'claude-sonnet-4-6', input_tokens: 3, output_tokens: 4 }] }))]]);
    const adapter = scripted([[toolCall('t1'), done('tool_use')], [done('end_turn')]]);
    const { result } = await run(adapter, owners);
    expect(result.capabilityUsage).toEqual([{ model: 'claude-sonnet-4-6', input_tokens: 3, output_tokens: 4 }]);
  });
});

describe('도구 루프 — 도중에 실패해도 쓴 토큰이 남는다', () => {
  it('둘째 라운드가 던져도 첫 라운드 사용량이 progress에 남는다', async () => {
    let call = 0;
    setLlmAdapterForTests({
      async *stream() {
        call += 1;
        if (call === 1) {
          yield toolCall('t1');
          yield done('tool_use', 10, 5);
          return;
        }
        throw new Error('연결 오류');
      },
      async complete() {
        throw new Error('쓰지 않음');
      },
    });
    const progress: LoopProgress = {
      usage: { model: 'claude-haiku-4-5', input_tokens: 0, output_tokens: 0 },
      capabilityUsage: [],
    };
    const owners = new Map([['law_search', lawCapability(async () => ({ ok: true, text: 'r' }))]]);
    await expect(
      runToolLoop(
        { modelId: 'claude-haiku-4-5', systemPrompt: 'S', messages: [{ role: 'user', content: 'q' }], tools, owners, ctx, maxRounds: 4, progress },
        () => {}
      )
    ).rejects.toThrow('연결 오류');
    expect(progress.usage).toEqual({ model: 'claude-haiku-4-5', input_tokens: 10, output_tokens: 5 });
  });
});
