import { ANTHROPIC_API_KEY } from '@/lib/config';
import { DEFAULT_MODEL_ID } from '@/lib/models';

/** 툴 사용 시 메시지 content는 문자열이 아니라 블록 배열이 된다 */
export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string | ClaudeContentBlock[];
}

/** MCP 형식 그대로 — 커넥터가 주는 정의를 변환 없이 넘긴다 */
export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  /** 이 사용량을 발생시킨 모델 id */
  model: string;
}

export interface ClaudeResponse {
  content: string;
  usage: ClaudeUsage;
}

/** 스트리밍 중 순차적으로 방출되는 이벤트 */
export type ClaudeStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  /** 스트림 종료. stopReason이 'tool_use'면 툴을 실행하고 다시 호출해야 한다. */
  | { type: 'done'; usage: ClaudeUsage; stopReason: string | null };

/** 현재 사용 중인 모델. 사용량 로그에 함께 기록해 나중에 모델별 정산이 가능하게 한다. */
export const CLAUDE_MODEL = DEFAULT_MODEL_ID;
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';

function buildHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  };
}

async function toApiError(response: Response) {
  const errorData = await response.json().catch(() => ({}));
  return new Error(
    `Claude API 오류: ${response.status} - ${errorData.error?.message || '알 수 없는 오류'}`
  );
}

export async function callClaudeAPI(
  messages: ClaudeMessage[],
  systemPrompt?: string,
  maxTokens = 4096,
  /**
   * 쓸 모델. 기관별 허용 모델 정책(model-policy.ts)이 확정한 값을 받는다.
   * 여기서 검증하지 않는 이유는, 검증을 두 곳에 두면 어느 쪽이 진짜
   * 기준인지 모르게 되기 때문이다. 호출 전에 반드시 정책을 거칠 것.
   */
  modelId: string = CLAUDE_MODEL
): Promise<ClaudeResponse> {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY가 설정되지 않았습니다.');
  }

  const requestBody: any = {
    model: modelId,
    max_tokens: maxTokens,
    messages: messages,
  };

  if (systemPrompt) {
    requestBody.system = systemPrompt;
  }

  const response = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    throw await toApiError(response);
  }

  const data = await response.json();

  return {
    content: data.content[0]?.text || '',
    usage: {
      input_tokens: data.usage?.input_tokens || 0,
      output_tokens: data.usage?.output_tokens || 0,
      // 실제로 쓴 모델을 남긴다. 정책이 다른 모델로 바꿨을 수도 있다.
      model: data.model ?? modelId,
    },
  };
}

/**
 * Claude API를 SSE 스트리밍으로 호출합니다.
 * 텍스트 조각을 도착하는 즉시 방출하고, 마지막에 토큰 사용량을 방출합니다.
 */
export async function* streamClaudeAPI(
  messages: ClaudeMessage[],
  systemPrompt?: string,
  maxTokens = 4096,
  tools?: ClaudeTool[],
  /**
   * 'none'이면 도구 정의는 유지한 채 호출만 막는다.
   * 이력에 tool_use 블록이 있는데 tools를 통째로 빼면 모델이 빈 응답을 낸다.
   */
  toolChoice?: 'auto' | 'none',
  /** 쓸 모델. 기관별 허용 모델 정책이 확정한 값을 받는다. */
  modelId: string = CLAUDE_MODEL
): AsyncGenerator<ClaudeStreamEvent> {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY가 설정되지 않았습니다.');
  }

  const requestBody: any = {
    model: modelId,
    max_tokens: maxTokens,
    messages: messages,
    stream: true,
  };

  if (systemPrompt) {
    requestBody.system = systemPrompt;
  }

  if (tools?.length) {
    requestBody.tools = tools;
    if (toolChoice) requestBody.tool_choice = { type: toolChoice };
  }

  const response = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    throw await toApiError(response);
  }
  if (!response.body) {
    throw new Error('Claude API가 스트림 본문을 반환하지 않았습니다.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  // input_tokens는 message_start에, output_tokens는 message_delta에 실려 옴
  const usage: ClaudeUsage = { input_tokens: 0, output_tokens: 0, model: modelId };
  let stopReason: string | null = null;
  let buffer = '';

  // tool_use 블록의 input은 JSON 문자열이 여러 조각(input_json_delta)으로
  // 나뉘어 오므로 블록 인덱스별로 모았다가 content_block_stop에서 파싱한다.
  const pendingTools = new Map<number, { id: string; name: string; json: string }>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE는 빈 줄로 이벤트를 구분한다. 마지막 조각은 불완전할 수 있으므로 버퍼에 남겨둔다.
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
          continue; // 파싱 불가한 조각은 건너뛴다
        }

        switch (parsed.type) {
          case 'message_start':
            usage.input_tokens = parsed.message?.usage?.input_tokens ?? 0;
            break;

          case 'content_block_start':
            if (parsed.content_block?.type === 'tool_use') {
              pendingTools.set(parsed.index, {
                id: parsed.content_block.id,
                name: parsed.content_block.name,
                json: '',
              });
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
                // 인자가 없는 툴은 빈 문자열로 온다
                input = pending.json ? JSON.parse(pending.json) : {};
              } catch {
                // 조각이 유실되면 빈 인자로 넘겨 툴이 오류를 돌려주게 한다
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
            throw new Error(`Claude API 오류: ${parsed.error?.message ?? '알 수 없는 오류'}`);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield { type: 'done', usage, stopReason };
}