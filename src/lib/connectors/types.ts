/**
 * 외부 도구(커넥터) 공통 규약.
 *
 * 툴 정의는 MCP 표준 형식(name / description / inputSchema)을 따릅니다.
 * 프로바이더별 형식 변환(Anthropic tool_use, OpenAI function calling 등)은
 * 이 계층의 책임이 아니라 LLM 어댑터의 책임입니다. 커넥터가 특정 프로바이더
 * 형식을 알게 되면 모델을 바꿀 때 커넥터를 전부 다시 써야 합니다.
 */

export interface ToolDefinition {
  /** 모델에게 노출되는 이름. 스네이크 케이스. */
  name: string;
  /** 모델이 언제 이 도구를 쓸지 판단하는 근거이므로 구체적으로 쓸 것 */
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** 인용에 쓸 출처. 공공 데이터는 근거 제시가 요구사항이라 필수다. */
export interface ToolSource {
  title: string;
  url: string;
}

export interface ToolResult {
  /** 모델에게 그대로 전달할 텍스트 */
  content: string;
  sources: ToolSource[];
  /** true면 모델에게 오류로 알린다 (예외를 던지지 말고 이 플래그를 쓸 것) */
  isError?: boolean;
}

export interface Connector {
  id: string;
  /** 관리 화면에 보일 이름 */
  label: string;
  tools: ToolDefinition[];
  /** 필요한 환경변수가 갖춰졌는지. false면 툴 목록에서 제외한다. */
  isConfigured(): boolean;
  /**
   * 툴 실행. 순수 함수처럼 동작해야 한다 —
   * 입력 → 외부 API 호출 → 구조화된 결과 + 출처.
   * 실패는 예외 대신 { isError: true }로 돌려준다.
   */
  execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
/**
 * 국내 공공 API는 간헐적으로 실패한다. 실측 결과 동일한 URL이 성공 →
 * HTTP 404 → 타임아웃을 오가는 것을 확인했다. 읽기 전용 GET이므로 재시도가
 * 안전하고, 재시도 없이는 실사용에서 체감 실패율이 너무 높다.
 */
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 600;

async function fetchOnce(url: string, timeoutMs: number): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    return { status: response.status, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

/** 인증 실패는 재시도해도 달라지지 않는다 */
function isAuthFailure(status: number) {
  return status === 401 || status === 403;
}

/**
 * 외부 API 호출 공통 헬퍼 — 타임아웃·재시도·JSON 파싱을 일관되게 처리한다.
 *
 * 상태 코드가 2xx가 아니어도 본문이 JSON이면 그대로 돌려준다. 국내 공공 API는
 * 오류를 HTTP 상태가 아니라 본문에 싣는 경우가 많고, 심지어 둘을 섞어 쓴다
 * (나라장터는 HTTP 403 + 본문에 SERVICE_KEY_IS_NOT_REGISTERED_ERROR).
 * 상태 코드만 보고 본문을 버리면 원인을 알 수 없는 "HTTP 403"만 남는다.
 * 본문 안의 오류 판별은 각 커넥터가 자기 API의 규약대로 한다.
 */
export async function fetchJson<T>(
  url: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let status = 0;
    try {
      const result = await fetchOnce(url, timeoutMs);
      status = result.status;

      try {
        return JSON.parse(result.text) as T;
      } catch {
        // JSON이 아니면 오류 안내 HTML일 가능성이 높다
        throw new Error(
          status >= 200 && status < 300
            ? '응답이 JSON 형식이 아닙니다. API 키나 파라미터를 확인하세요.'
            : `HTTP ${status}`
        );
      }
    } catch (err: any) {
      lastError = err;
      if (String(err?.message).startsWith('응답이 JSON')) break;
      if (isAuthFailure(status)) break;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('외부 API 호출에 실패했습니다.');
}

/** 결과가 1건일 때 배열 대신 객체로 오는 공공 API가 많다 */
export function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export function toolError(message: string): ToolResult {
  return { content: message, sources: [], isError: true };
}
