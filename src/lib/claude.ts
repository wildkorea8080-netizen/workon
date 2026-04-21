import { ANTHROPIC_API_KEY } from '@/lib/config';

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ClaudeResponse {
  content: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
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
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    messages: messages,
  };

  if (systemPrompt) {
    requestBody.system = systemPrompt;
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(`Claude API 오류: ${response.status} - ${errorData.error?.message || '알 수 없는 오류'}`);
  }

  const data = await response.json();

  return {
    content: data.content[0]?.text || '',
    usage: {
      input_tokens: data.usage?.input_tokens || 0,
      output_tokens: data.usage?.output_tokens || 0,
    },
  };
}