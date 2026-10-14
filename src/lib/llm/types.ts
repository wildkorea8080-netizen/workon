/**
 * AI 연결부의 공통 형식 — 특정 업체에 묶이지 않는다.
 *
 * 도구는 MCP 형식(name · description · inputSchema)이다. 업체 형식으로
 * 바꾸는 일은 어댑터(anthropic.ts)의 책임이고, 커넥터·능력은 업체를 모른다.
 * 기관 내부 모델을 붙일 때는 이 형식을 받는 어댑터 하나를 더한다(설계 5.1).
 */

export type LlmContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string | LlmContentBlock[];
}

export interface LlmTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmUsage {
  /** 이 사용량을 낸 모델. 정산 단가가 모델마다 다르다 */
  model: string;
  input_tokens: number;
  output_tokens: number;
}

export type LlmStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  /** 스트림 끝. stopReason이 'tool_use'면 도구를 실행하고 다시 불러야 한다 */
  | { type: 'done'; usage: LlmUsage; stopReason: string | null };

export interface LlmRequest {
  /** 기관 정책을 거친 모델. 연결부는 정책을 다시 보지 않는다 — 기준이 두 곳이 되면 안 된다 */
  model: string;
  system?: string;
  messages: LlmMessage[];
  maxTokens: number;
  tools?: LlmTool[];
  /** 'none'이면 도구 정의는 유지한 채 호출만 막는다 */
  toolChoice?: 'auto' | 'none';
}

export interface LlmCompletion {
  text: string;
  usage: LlmUsage;
}

export interface LlmAdapter {
  stream(req: LlmRequest): AsyncGenerator<LlmStreamEvent>;
  complete(req: LlmRequest): Promise<LlmCompletion>;
}
