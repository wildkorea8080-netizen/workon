import { ANTHROPIC_API_KEY } from '@/lib/config';
import { DEFAULT_MODEL_ID } from '@/lib/models';

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
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
  | { type: 'usage'; usage: ClaudeUsage };

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
  maxTokens = 4096
): Promise<ClaudeResponse> {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY가 설정되지 않았습니다.');
  }

  const requestBody: any = {
    model: CLAUDE_MODEL,
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
      model: CLAUDE_MODEL,
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
  maxTokens = 4096
): AsyncGenerator<ClaudeStreamEvent> {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY가 설정되지 않았습니다.');
  }

  const requestBody: any = {
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    messages: messages,
    stream: true,
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
  if (!response.body) {
    throw new Error('Claude API가 스트림 본문을 반환하지 않았습니다.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  // input_tokens는 message_start에, output_tokens는 message_delta에 실려 옴
  const usage: ClaudeUsage = { input_tokens: 0, output_tokens: 0, model: CLAUDE_MODEL };
  let buffer = '';

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

        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
          yield { type: 'text', text: parsed.delta.text as string };
        } else if (parsed.type === 'message_start') {
          usage.input_tokens = parsed.message?.usage?.input_tokens ?? 0;
        } else if (parsed.type === 'message_delta') {
          usage.output_tokens = parsed.usage?.output_tokens ?? usage.output_tokens;
        } else if (parsed.type === 'error') {
          throw new Error(`Claude API 오류: ${parsed.error?.message ?? '알 수 없는 오류'}`);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield { type: 'usage', usage };
}