// src/lib/llm/anthropic.ts
import { ANTHROPIC_API_KEY } from '@/lib/config';
import type { LlmAdapter, LlmRequest, LlmStreamEvent, LlmUsage, LlmCompletion } from './types';
import { LlmApiError } from './errors';

/** 이 저장소에서 Anthropic 주소가 나오는 곳은 여기뿐이다 (tests/llm-boundary.test.ts) */
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

function headers() {
  return {
    'Content-Type': 'application/json',
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  };
}

export function toAnthropicBody(req: LlmRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens,
    messages: req.messages,
  };
  if (stream) body.stream = true;
  if (req.system) body.system = req.system;
  if (req.tools?.length) {
    body.tools = req.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
    if (req.toolChoice) body.tool_choice = { type: req.toolChoice };
  }
  return body;
}

async function apiError(response: Response): Promise<Error> {
  const detail = (await response.json().catch(() => ({}))) as { error?: { message?: string; type?: string } };
  return new LlmApiError(response.status, detail.error?.message || '알 수 없는 오류', detail.error?.type);
}

function requireKey() {
  if (!ANTHROPIC_API_KEY) throw new LlmApiError(null, 'ANTHROPIC_API_KEY가 설정되지 않았습니다.', 'missing_key');
}

/**
 * SSE 본문을 이벤트로 바꾼다.
 *
 * input_tokens는 message_start에, output_tokens는 message_delta에 온다.
 * tool_use의 인자는 input_json_delta로 잘게 쪼개져 오므로 블록 인덱스별로
 * 모았다가 content_block_stop에서 파싱한다.
 */
export async function* parseAnthropicStream(
  body: ReadableStream<Uint8Array>,
  modelId: string
): AsyncGenerator<LlmStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const usage: LlmUsage = { model: modelId, input_tokens: 0, output_tokens: 0 };
  const pendingTools = new Map<number, { id: string; name: string; json: string }>();
  let stopReason: string | null = null;
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE는 빈 줄로 이벤트를 나눈다. 마지막 조각은 불완전할 수 있어 남긴다.
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const event of events) {
        const dataLine = event.split('\n').find((line) => line.startsWith('data:'));
        if (!dataLine) continue;
        const payload = dataLine.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let parsed: any;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }

        switch (parsed.type) {
          case 'message_start':
            usage.input_tokens = parsed.message?.usage?.input_tokens ?? 0;
            break;
          case 'content_block_start':
            if (parsed.content_block?.type === 'tool_use') {
              pendingTools.set(parsed.index, { id: parsed.content_block.id, name: parsed.content_block.name, json: '' });
            }
            break;
          case 'content_block_delta':
            if (parsed.delta?.type === 'text_delta') {
              yield { type: 'text', text: parsed.delta.text as string };
            } else if (parsed.delta?.type === 'input_json_delta') {
              const pending = pendingTools.get(parsed.index);
              if (pending) pending.json += parsed.delta.partial_json ?? '';
            }
            break;
          case 'content_block_stop': {
            const pending = pendingTools.get(parsed.index);
            if (pending) {
              pendingTools.delete(parsed.index);
              let input: Record<string, unknown> = {};
              try {
                // 인자 없는 도구는 빈 문자열로 온다
                input = pending.json ? JSON.parse(pending.json) : {};
              } catch {
                // 조각이 유실되면 빈 인자로 넘겨 도구가 오류를 돌려주게 한다
              }
              yield { type: 'tool_use', id: pending.id, name: pending.name, input };
            }
            break;
          }
          case 'message_delta':
            usage.output_tokens = parsed.usage?.output_tokens ?? usage.output_tokens;
            stopReason = parsed.delta?.stop_reason ?? stopReason;
            break;
          case 'error':
            throw new LlmApiError(null, parsed.error?.message ?? '알 수 없는 오류', parsed.error?.type);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield { type: 'done', usage, stopReason };
}

export const anthropicAdapter: LlmAdapter = {
  async *stream(req) {
    requireKey();
    const response = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(toAnthropicBody(req, true)),
    });
    if (!response.ok) throw await apiError(response);
    if (!response.body) throw new Error('Claude API가 스트림 본문을 반환하지 않았습니다.');
    yield* parseAnthropicStream(response.body, req.model);
  },

  async complete(req): Promise<LlmCompletion> {
    requireKey();
    const response = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(toAnthropicBody(req, false)),
    });
    if (!response.ok) throw await apiError(response);
    const data = await response.json();
    const text = ((data.content ?? []) as { type: string; text?: string }[])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n')
      .trim();
    return {
      text,
      usage: {
        // 요청한 모델을 남긴다(스트리밍 경로와 같다). 정책을 통과한 레지스트리 id라
        // 단가가 맞는다. 응답의 모델 id가 레지스트리에 없으면 단가 조회가 기본
        // 모델로 떨어져 조용히 과소 청구된다.
        model: req.model,
        input_tokens: data.usage?.input_tokens ?? 0,
        output_tokens: data.usage?.output_tokens ?? 0,
      },
    };
  },
};
