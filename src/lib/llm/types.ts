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
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  /**
   * 업체가 돌려준 블록 그대로(2026-11-26 — 웹 검색 같은 서버 도구). 서버 도구를 쓴 턴을 이어 부를 때(우리 도구 결과를 돌려주거나
   * `pause_turn`을 이어 갈 때) 모델이 낸 블록을 **바꾸지 않고** 돌려줘야 한다 — 검색 결과(암호화된 내용)·인용·생각 블록을 우리가 다시 만들 수 없다
   */
  | { type: 'provider_raw'; block: Record<string, unknown> };

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
  /** 웹 검색 횟수(2026-11-26) — 토큰과 따로 청구된다(models.ts WEB_SEARCH_USD_PER_REQUEST). 없으면 0 */
  web_search_requests?: number;
}

/** 웹 검색으로 본 곳 — 화면 출처 목록·숫자 확인(인용한 글)으로 간다 */
export interface LlmWebSource {
  url: string;
  title: string;
  /** 답변이 인용한 원문 조각(인용일 때만) */
  citedText?: string;
}

/**
 * 업체가 서버에서 돌리는 도구(2026-11-26). 우리가 실행하지 않는다 — 요청에 정의만 싣고 결과는 같은 응답의 블록으로 온다.
 * 지금은 웹 검색 하나(Anthropic `web_search`)
 */
export interface LlmServerTools {
  webSearch?: {
    /** 한 번 응답에서 검색할 수 있는 횟수 */
    maxUses: number;
    /** 이 곳들(과 하위 도메인)만 찾는다 — 없으면 제한 없음 */
    allowedDomains?: string[];
  };
}

export type LlmStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  /** 서버 도구가 돌기 시작함(웹 검색 — 화면에 '찾는 중'을 보인다). 우리가 실행하지 않는다 */
  | { type: 'server_tool_use'; id: string; name: string; input: Record<string, unknown> }
  /** 서버 도구의 결과 — 웹 검색이면 찾은 곳(제목·주소)만. 실패면 ok false와 까닭 코드 */
  | { type: 'server_tool_result'; toolUseId: string; name: string; ok: boolean; sources: LlmWebSource[]; errorCode?: string }
  /** 답변 글이 웹 검색 결과를 인용함 */
  | { type: 'citation'; source: LlmWebSource }
  /**
   * 스트림 끝. stopReason이 'tool_use'면 도구를 실행하고 다시 불러야 하고, 'pause_turn'이면 서버 도구가 긴 일을 멈춘 것이라
   * `content`를 그대로 돌려주며 다시 부르면 이어 간다. `content`는 서버 도구를 쓴 응답일 때만(그 응답의 블록 그대로 — 이어 부를 때 쓴다)
   */
  | { type: 'done'; usage: LlmUsage; stopReason: string | null; content?: Record<string, unknown>[] };

export interface LlmRequest {
  /** 기관 정책을 거친 모델. 연결부는 정책을 다시 보지 않는다 — 기준이 두 곳이 되면 안 된다 */
  model: string;
  system?: string;
  messages: LlmMessage[];
  maxTokens: number;
  tools?: LlmTool[];
  /** 'none'이면 도구 정의는 유지한 채 호출만 막는다 */
  toolChoice?: 'auto' | 'none';
  /** 업체 서버에서 도는 도구(웹 검색, 2026-11-26) — 정의만 싣는다 */
  serverTools?: LlmServerTools;
}

export interface LlmCompletion {
  text: string;
  usage: LlmUsage;
}

export interface LlmAdapter {
  stream(req: LlmRequest): AsyncGenerator<LlmStreamEvent>;
  complete(req: LlmRequest): Promise<LlmCompletion>;
}
