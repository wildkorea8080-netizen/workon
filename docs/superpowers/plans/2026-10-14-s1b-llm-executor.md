# S1-b AI 연결부·대화 실행기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모델 호출을 `src/lib/llm/` 한 곳으로 모으고, 대화 한 턴을 `src/lib/assistant/`의 실행기가 처리하며, 비서에 켜진 능력만 도구로 꺼내 준다. `/api/chat`은 얇아진다.

**Architecture:** AI 연결부는 업체에 묶이지 않는 형식(`LlmMessage`·`LlmTool`=MCP 형식)과 두 입구(`streamChat`·`complete`)를 내놓고, 모델 레지스트리의 `provider`로 어댑터(`anthropic.ts`)를 고른다. 능력은 파일 하나씩(`capabilities/`) 두고 `prepare`·`tools`·`execute`를 갖는다. 실행기는 `prepareTurn`(거절이면 JSON) → `streamTurn`(SSE 이벤트) 두 단계이며, 도구 루프는 가짜 어댑터를 끼워 시험한다.

**Tech Stack:** Next.js 14 App Router · TypeScript · Supabase · Anthropic Messages API(SSE, `fetch` 직접) · vitest

**Spec:** `docs/superpowers/specs/2026-10-14-s1-agent-structure-and-executor-design.md` (4·5·6.2절)

**선행 조건:** S1-a가 배포되어 있다(0026 적용, `agent-permissions`·`actor-scope`·`capabilities/settings`·`connector-scope.getCapabilityScope` 존재).

## Global Constraints

- 응답 규약: 스트림 시작 **전** 실패는 JSON `{ ok: false, error: { message, details? } }`, 시작 **후** 실패는 SSE `error`
- SSE 이벤트 이름과 페이로드는 지금과 같다: `meta {conversation_id, chunks}` · `delta {text}` · `tool_start {name, input}` · `tool_end {name, ok, sources}` · `tool_limit {rounds}` · `error {message}` · `done {usage, title}`
- `MAX_TOOL_ROUNDS = 4`, 이력 `HISTORY_MESSAGE_LIMIT = 20`, 응답 `max_tokens = 4096`
- 상한 라운드에서는 도구 정의를 유지한 채 `tool_choice='none'`으로 마무리 호출한다 — `tools`를 빼면 Anthropic이 400을 준다
- 토큰을 쓰면 `usage_logs.details`에 `model · input_tokens · output_tokens · cost_usd · cost_krw`를 남긴다(`estimateCostUsd`·`estimateCostKrw`)
- 메시지 두 행은 **같은 키 집합**으로 넣는다 (PostgREST 배치 삽입 규칙)
- 사진 바이트는 저장하지 않는다. `imageAttachmentMarker(n)` + 질문만 저장
- 외부 API는 SDK 없이 `fetch`로 부른다. 환경변수는 `config.ts` 경유
- 커밋 메시지 끝: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## 설계와 달라지는 점

- **`ToolOutcome.files`는 S2에서 더한다.** S1의 능력 셋은 파일을 만들지 않는다. 지금 넣으면 아무도 채우지 않는 칸이 된다.
- **능력 설정 검사(`validateSettings`)는 S1-a의 `capabilities/settings.ts`에 둔다.** 능력 객체에 다시 두면 같은 규칙이 두 곳에 생긴다. 능력 목록의 id가 `CAPABILITY_IDS`와 같은지는 테스트가 확인한다.

## Review Focus

- **비서의 모델이 기본 모델이 아닌데 사용량이 기본 모델 단가로 기록된다** → 실제 쓴 모델로 기록해야 한다. 지금 `/api/chat`은 `usage.model`을 `CLAUDE_MODEL`로 두고 바꾸지 않아, 다른 모델을 써도 기본 모델로 정산된다. Task 5의 도구 루프 테스트가 고정한다.
- **대화 제목을 만드는 데 쓴 토큰이 어디에도 기록되지 않는다** → 기록해야 한다(과금 규약). 지금은 빠져 있다. Task 6이 `conversation_title` 행으로 남긴다.
- **기관이 기본 모델을 허용 목록에서 뺐는데 제목 생성은 기본 모델로 부른다** → 정책 밖 모델을 부르면 안 된다. Task 6이 그 턴의 모델로 제목을 만든다.
- **도구가 예외를 던진다** → 대화는 이어지고 실패 이유가 AI와 화면에 간다. Task 5가 고정한다.
- **나만의·부서 비서에 기관이 나중에 끈 연결이 남아 있다** → 대화할 때 그 도구가 빠진다. Task 3의 `effectiveCapabilities` 테스트가 고정한다.

---

## File Structure

| 파일 | 책임 |
|---|---|
| `src/lib/llm/types.ts` (새) | 업체 중립 형식 |
| `src/lib/llm/anthropic.ts` (새) | Anthropic 어댑터 · SSE 해석 · MCP→Anthropic 변환 |
| `src/lib/llm/index.ts` (새) | `streamChat`·`complete` 입구 · 시험용 어댑터 교체 |
| `src/lib/capabilities/types.ts` (새) | `Capability`·`TurnContext`·`ToolOutcome`·`PrepareResult` |
| `src/lib/capabilities/doc-search.ts` (새) | 참고 문서 찾기 — 지금의 자동 검색과 세 갈래 프롬프트 |
| `src/lib/capabilities/public-data.ts` (새) | 공공데이터 조회 — 커넥터 감싸기 |
| `src/lib/capabilities/image.ts` (새) | 사진 읽기 — 받을 수 있는 입력 |
| `src/lib/capabilities/index.ts` (새) | 능력 목록 · 켜진 능력 · 도구 모으기 · 대화 시 능력 결정 |
| `src/lib/assistant/types.ts` (새) | `TurnEvent`·`PreparedTurn`·`PrepareOutcome` |
| `src/lib/assistant/prompt.ts` (새) | 시스템 프롬프트 · 사용자 내용 조립 (순수) |
| `src/lib/assistant/history.ts` (새) | 이력 조회 · 다듬기 |
| `src/lib/assistant/persist.ts` (새) | 메시지 행 · 사용 로그 행 (순수 + 저장) |
| `src/lib/assistant/stream.ts` (새) | 도구 루프 · `streamTurn` |
| `src/lib/assistant/prepare.ts` (새) | `prepareTurn` |
| `src/app/api/chat/route.ts` (전체 교체) | 인증 → 실행기 → SSE |
| `src/app/api/enhance-prompt/route.ts` (고침) | 연결부 경유 · 한도 · 사용 기록 |
| `src/lib/pdf-ocr.ts` (고침) | 연결부 경유 |
| 지움 | `src/lib/claude.ts` · `src/app/api/qna` · `src/app/api/report` · `src/app/api/employee` · `src/app/employee` · `src/app/report` · `src/components/report` · `src/components/employee` |
| `src/components/chat/ChatInterface.tsx` (고침) | 모델 선택 → 비서 모델 표시 |
| 테스트 | `tests/llm-anthropic.test.ts` · `tests/capabilities.test.ts` · `tests/assistant-parts.test.ts` · `tests/tool-loop.test.ts` · `tests/llm-boundary.test.ts` (새) · `tests/message-persistence.test.ts` · `tests/chat-images.test.ts` · `tests/usage-limit.test.ts` · `tests/route-auth.test.ts` (고침) |

---

### Task 1: AI 연결부

**Files:**
- Create: `src/lib/llm/types.ts`, `src/lib/llm/anthropic.ts`, `src/lib/llm/index.ts`
- Test: `tests/llm-anthropic.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  // types.ts
  export type LlmContentBlock =
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
    | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
  export interface LlmMessage { role: 'user' | 'assistant'; content: string | LlmContentBlock[] }
  export interface LlmTool { name: string; description: string; inputSchema: Record<string, unknown> }
  export interface LlmUsage { model: string; input_tokens: number; output_tokens: number }
  export type LlmStreamEvent =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'done'; usage: LlmUsage; stopReason: string | null };
  export interface LlmRequest { model: string; system?: string; messages: LlmMessage[]; maxTokens: number; tools?: LlmTool[]; toolChoice?: 'auto' | 'none' }
  export interface LlmCompletion { text: string; usage: LlmUsage }
  export interface LlmAdapter { stream(req: LlmRequest): AsyncGenerator<LlmStreamEvent>; complete(req: LlmRequest): Promise<LlmCompletion> }
  // anthropic.ts
  export function toAnthropicBody(req: LlmRequest, stream: boolean): Record<string, unknown>;
  export function parseAnthropicStream(body: ReadableStream<Uint8Array>, modelId: string): AsyncGenerator<LlmStreamEvent>;
  export const anthropicAdapter: LlmAdapter;
  // index.ts
  export function streamChat(req: LlmRequest): AsyncGenerator<LlmStreamEvent>;
  export function complete(req: LlmRequest): Promise<LlmCompletion>;
  export function setLlmAdapterForTests(adapter: LlmAdapter | null): void;
  export * from './types';
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// tests/llm-anthropic.test.ts
import { describe, it, expect } from 'vitest';
import { toAnthropicBody, parseAnthropicStream } from '@/lib/llm/anthropic';
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
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/llm-anthropic.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/llm/anthropic"`

- [ ] **Step 3: `types.ts` 작성**

```typescript
// src/lib/llm/types.ts
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
```

- [ ] **Step 4: `anthropic.ts` 작성** — 지금 `src/lib/claude.ts`의 스트림 해석을 그대로 옮긴다.

```typescript
// src/lib/llm/anthropic.ts
import { ANTHROPIC_API_KEY } from '@/lib/config';
import type { LlmAdapter, LlmRequest, LlmStreamEvent, LlmUsage, LlmCompletion } from './types';

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
  const detail = await response.json().catch(() => ({}));
  return new Error(
    `Claude API 오류: ${response.status} - ${(detail as { error?: { message?: string } }).error?.message || '알 수 없는 오류'}`
  );
}

function requireKey() {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY가 설정되지 않았습니다.');
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
            throw new Error(`Claude API 오류: ${parsed.error?.message ?? '알 수 없는 오류'}`);
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
        // 실제로 쓴 모델을 남긴다
        model: data.model ?? req.model,
        input_tokens: data.usage?.input_tokens ?? 0,
        output_tokens: data.usage?.output_tokens ?? 0,
      },
    };
  },
};
```

- [ ] **Step 5: `index.ts` 작성**

```typescript
// src/lib/llm/index.ts
import { getModel } from '@/lib/models';
import { anthropicAdapter } from './anthropic';
import type { LlmAdapter, LlmRequest } from './types';

export * from './types';

/**
 * 모델 호출의 유일한 입구.
 *
 * 모델 레지스트리(models.ts)의 provider로 어댑터를 고른다. 지금은 Anthropic
 * 하나다. 기관 내부 모델을 붙일 때 레지스트리 항목과 어댑터만 더하면 된다.
 */
let testAdapter: LlmAdapter | null = null;

/** 시험에서 실제 API 대신 가짜 어댑터를 끼운다. 운영 코드에서 부르지 않는다. */
export function setLlmAdapterForTests(adapter: LlmAdapter | null): void {
  testAdapter = adapter;
}

function adapterFor(modelId: string): LlmAdapter {
  if (testAdapter) return testAdapter;
  const provider = getModel(modelId).provider;
  switch (provider) {
    case 'anthropic':
      return anthropicAdapter;
    default:
      throw new Error(`아직 연결하지 않은 AI 업체입니다: ${provider}`);
  }
}

export function streamChat(req: LlmRequest) {
  return adapterFor(req.model).stream(req);
}

export function complete(req: LlmRequest) {
  return adapterFor(req.model).complete(req);
}
```

- [ ] **Step 6: 통과 확인**

Run: `npx vitest run tests/llm-anthropic.test.ts && npx tsc --noEmit`
Expected: PASS (5 tests), tsc 오류 0건

- [ ] **Step 7: Commit**

```bash
git add src/lib/llm tests/llm-anthropic.test.ts
git commit -m "feat: AI 연결부 — 업체 중립 형식과 Anthropic 어댑터

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 스캔 PDF 판독을 연결부로

**Files:**
- Modify: `src/lib/pdf-ocr.ts`
- Test: `tests/pdf-ocr.test.ts` (추가)

**Interfaces:**
- Consumes: `complete(req)` (Task 1)

- [ ] **Step 1: 실패하는 테스트 추가** — `tests/pdf-ocr.test.ts` 끝에:

```typescript
describe('스캔 판독은 AI 연결부를 거친다', () => {
  it('Anthropic을 직접 부르지 않는다', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/lib/pdf-ocr.ts', 'utf8');
    expect(src).not.toContain('api.anthropic.com');
    expect(src).toContain("from '@/lib/llm'");
  });
});
```
(파일 첫 줄의 vitest import에 `describe`·`it`·`expect`가 이미 있다.)

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/pdf-ocr.test.ts`
Expected: FAIL — `expected '...' not to contain 'api.anthropic.com'`

- [ ] **Step 3: 구현** — `extractTextFromScannedPdf`에서 `const response = await fetch(CLAUDE_API_URL, {`부터 `return { text, pageCount, usage: {...} };`까지를 다음으로 바꾼다. 파일 위쪽의 `CLAUDE_API_URL` 상수와 `ANTHROPIC_API_KEY` import를 지우고 `import { complete } from '@/lib/llm';`를 더한다. `CLAUDE_MODEL` import가 `@/lib/claude`에서 오면 `import { DEFAULT_MODEL_ID as CLAUDE_MODEL } from '@/lib/models';`로 바꾼다.

```typescript
  let result;
  try {
    result = await complete({
      model: CLAUDE_MODEL,
      // 페이지가 많으면 출력도 길어진다. 부족하면 뒷부분이 잘린다.
      maxTokens: 16000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: fileBuffer.toString('base64') },
            },
            { type: 'text', text: EXTRACTION_PROMPT },
          ],
        },
      ],
    });
  } catch (error) {
    throw new Error(`스캔 문서 판독에 실패했습니다: ${error instanceof Error ? error.message : ''}`.trim());
  }

  if (!result.text) {
    throw new Error('스캔 문서에서 글자를 찾지 못했습니다. 스캔 품질을 확인해주세요.');
  }

  return { text: result.text, pageCount, usage: result.usage };
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/pdf-ocr.test.ts && npx tsc --noEmit`
Expected: PASS, tsc 오류 0건 (`OcrResult.usage`의 형이 `{input_tokens, output_tokens, model}`이므로 `LlmUsage`와 맞는다)

- [ ] **Step 5: Commit**

```bash
git add src/lib/pdf-ocr.ts tests/pdf-ocr.test.ts
git commit -m "refactor: 스캔 PDF 판독을 AI 연결부로

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 능력 목록

**Files:**
- Create: `src/lib/capabilities/types.ts`, `doc-search.ts`, `public-data.ts`, `image.ts`, `index.ts`
- Test: `tests/capabilities.test.ts`

**Interfaces:**
- Consumes: `CAPABILITY_IDS`·`CapabilitySettings`·`CapabilityScope`·`normalizeCapabilities`·`clampToScope` (S1-a), `LlmTool`·`LlmUsage` (Task 1), `toolsForConnectors`·`executeTool`·`availableConnectors`·`ToolSource` (`@/lib/connectors`), `retrieveRelevantChunks` (`@/lib/rag`), `RetrievedChunk` (`@/lib/db`)
- Produces:
  ```typescript
  // types.ts
  export interface TurnContext { organizationId: string; departmentId: string; userId: string; agentId: string; agentVersion: number; capabilities: CapabilitySettings; message: string }
  export interface PrepareResult { systemAddendum?: string; chunks?: RetrievedChunk[] }
  export interface ToolOutcome { ok: boolean; text: string; sources?: { links?: ToolSource[] }; usage?: LlmUsage[] }
  export interface Capability { id: CapabilityId; label: string; description: string; acceptsImages?: boolean; isAvailable(): boolean; prepare?(ctx: TurnContext): Promise<PrepareResult>; tools?(ctx: TurnContext): LlmTool[]; execute?(tool: string, input: Record<string, unknown>, ctx: TurnContext): Promise<ToolOutcome> }
  // doc-search.ts
  export interface DocSearchDeps { retrieve(agentId: string, query: string): Promise<RetrievedChunk[]>; hasDocuments(agentId: string): Promise<boolean> }
  export function docSearchAddendum(chunks: RetrievedChunk[], hasDocuments: boolean): string | undefined;
  export function createDocSearch(deps?: DocSearchDeps): Capability;
  // index.ts
  export const CAPABILITIES: Capability[];
  export function activeCapabilities(settings: CapabilitySettings): Capability[];
  export function toolsFor(capabilities: Capability[], ctx: TurnContext): { tools: LlmTool[]; owners: Map<string, Capability> };
  export function effectiveCapabilities(stored: unknown, opts: { tier: 'personal' | 'department' | 'official'; scope: CapabilityScope; knownConnectorIds: string[] }): CapabilitySettings;
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// tests/capabilities.test.ts
import { describe, it, expect } from 'vitest';
import { CAPABILITY_IDS } from '@/lib/capabilities/settings';
import { CAPABILITIES, activeCapabilities, toolsFor, effectiveCapabilities } from '@/lib/capabilities';
import { createDocSearch, docSearchAddendum } from '@/lib/capabilities/doc-search';
import type { TurnContext } from '@/lib/capabilities/types';
import type { RetrievedChunk } from '@/lib/db';

const ctx = (over: Partial<TurnContext> = {}): TurnContext => ({
  organizationId: 'org', departmentId: 'dept', userId: 'u', agentId: 'a', agentVersion: 1,
  capabilities: {}, message: '여비 규정', ...over,
});

const chunk: RetrievedChunk = { documentId: 'd1', documentTitle: '여비규정', chunkIndex: 0, text: '국내 출장 일비 2만원', similarity: 0.45 };

describe('능력 목록', () => {
  it('id가 설정 목록과 같다', () => {
    // 설정 정규화(settings.ts)와 실행(index.ts)이 다른 능력을 알면 안 된다
    expect(CAPABILITIES.map((c) => c.id).sort()).toEqual([...CAPABILITY_IDS].sort());
  });

  it('켜진 능력만 고른다', () => {
    expect(activeCapabilities({ image: {} }).map((c) => c.id)).toEqual(['image']);
    expect(activeCapabilities({})).toEqual([]);
  });

  it('도구 이름이 겹치지 않는다', () => {
    const all = CAPABILITIES.flatMap((c) =>
      (c.tools?.(ctx({ capabilities: { public_data: { connectors: ['law', 'kosis', 'g2b', 'dart'] } } })) ?? []).map((t) => t.name)
    );
    expect(new Set(all).size).toBe(all.length);
  });

  it('격리에 걸리는 값을 AI 입력으로 받지 않는다', () => {
    // 기관·보관함·대상 문서는 서버가 ctx에서 정한다(설계 4.2)
    const FORBIDDEN = ['tenant', 'organization_id', 'organizationId', 'department_id', 'agent_id', 'user_id'];
    const { tools } = toolsFor(CAPABILITIES, ctx({ capabilities: { public_data: { connectors: ['law', 'kosis', 'g2b', 'dart'] } } }));
    for (const tool of tools) {
      const props = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      expect(props.filter((p) => FORBIDDEN.includes(p)), tool.name).toEqual([]);
    }
  });
});

describe('대화할 때의 능력', () => {
  const scope = { publicDataConnectors: new Set(['law']) };
  const known = ['law', 'kosis'];

  it('공식 비서는 기관 범위로 자르지 않는다', () => {
    expect(
      effectiveCapabilities({ public_data: { connectors: ['kosis'] } }, { tier: 'official', scope, knownConnectorIds: known })
    ).toEqual({ public_data: { connectors: ['kosis'] } });
  });

  it('부서 비서는 기관이 끈 연결을 뺀다', () => {
    expect(
      effectiveCapabilities({ image: {}, public_data: { connectors: ['law', 'kosis'] } }, { tier: 'department', scope, knownConnectorIds: known })
    ).toEqual({ image: {}, public_data: { connectors: ['law'] } });
  });

  it('저장된 값이 깨져 있으면 아무 능력도 켜지 않는다', () => {
    expect(effectiveCapabilities({ unknown_cap: {} }, { tier: 'official', scope, knownConnectorIds: known })).toEqual({});
    expect(effectiveCapabilities('x', { tier: 'official', scope, knownConnectorIds: known })).toEqual({});
  });

  it('키가 빠진 커넥터는 공식 비서에서도 뺀다', () => {
    expect(
      effectiveCapabilities({ public_data: { connectors: ['law', 'g2b'] } }, { tier: 'official', scope, knownConnectorIds: known })
    ).toEqual({ public_data: { connectors: ['law'] } });
  });
});

describe('참고 문서 찾기', () => {
  it('찾으면 자료와 인용 규칙을 함께 붙인다', () => {
    const text = docSearchAddendum([chunk], true)!;
    expect(text).toContain('참고 자료:');
    expect(text).toContain('[참고 자료: 여비규정]');
    expect(text).toContain('[자료 인용 규칙]');
    // 단위를 임의로 붙이지 말라는 지침이 핵심이다
    expect(text).toContain('자료에 없는 단위');
  });

  it('문서는 있는데 못 찾으면 근거 없음을 밝히게 한다', () => {
    expect(docSearchAddendum([], true)).toContain('[문서 검색 결과 없음]');
  });

  it('문서가 없으면 아무것도 붙이지 않는다', () => {
    expect(docSearchAddendum([], false)).toBeUndefined();
  });

  it('검색이 실패해도 대화는 이어진다', async () => {
    const cap = createDocSearch({
      retrieve: async () => { throw new Error('임베딩 실패'); },
      hasDocuments: async () => true,
    });
    const result = await cap.prepare!(ctx());
    expect(result.chunks).toEqual([]);
    expect(result.systemAddendum).toContain('[문서 검색 결과 없음]');
  });

  it('찾은 조각을 출처로 돌려준다', async () => {
    const cap = createDocSearch({ retrieve: async () => [chunk], hasDocuments: async () => true });
    expect((await cap.prepare!(ctx())).chunks).toEqual([chunk]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/capabilities.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/capabilities"`

- [ ] **Step 3: `types.ts` 작성**

```typescript
// src/lib/capabilities/types.ts
import type { LlmTool, LlmUsage } from '@/lib/llm/types';
import type { ToolSource } from '@/lib/connectors';
import type { RetrievedChunk } from '@/lib/db';
import type { CapabilityId, CapabilitySettings } from './settings';

/**
 * 이번 턴의 정보. **서버가 채운다.** AI는 도구 입력값만 정한다.
 * 격리에 걸리는 값(기관·보관함·대상 문서)은 도구 입력 스키마에 넣지 않고
 * 여기서만 꺼낸다(설계 4.2) — tests/capabilities.test.ts가 확인한다.
 */
export interface TurnContext {
  organizationId: string;
  departmentId: string;
  userId: string;
  agentId: string;
  agentVersion: number;
  /** 기관 범위를 적용한 뒤의 설정 */
  capabilities: CapabilitySettings;
  /** 이번 질문. prepare가 검색어로 쓴다 */
  message: string;
}

export interface PrepareResult {
  /** 시스템 프롬프트 뒤에 붙일 글 */
  systemAddendum?: string;
  /** 화면 출처 표시(SourceCitation)와 messages.source_references.chunks로 간다 */
  chunks?: RetrievedChunk[];
}

export interface ToolOutcome {
  ok: boolean;
  /** AI에게 돌려줄 글. 실패면 사람이 읽을 수 있는 이유 */
  text: string;
  sources?: { links?: ToolSource[] };
  /** 능력 안에서 AI를 불렀을 때. 실행기가 과금 규약대로 기록한다 */
  usage?: LlmUsage[];
}

export interface Capability {
  id: CapabilityId;
  label: string;
  description: string;
  /** 사진을 받을 수 있게 하는 능력 */
  acceptsImages?: boolean;
  /** 쓸 준비가 됐는가(키 등). false면 켜져 있어도 빠진다 */
  isAvailable(): boolean;
  prepare?(ctx: TurnContext): Promise<PrepareResult>;
  tools?(ctx: TurnContext): LlmTool[];
  /** 던져도 된다 — 실행기가 받아 실패 결과로 바꾼다 */
  execute?(tool: string, input: Record<string, unknown>, ctx: TurnContext): Promise<ToolOutcome>;
}
```

- [ ] **Step 4: `doc-search.ts` 작성** — `/api/chat`의 세 갈래 프롬프트를 글자 그대로 옮긴다.

```typescript
// src/lib/capabilities/doc-search.ts
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { retrieveRelevantChunks } from '@/lib/rag';
import type { RetrievedChunk } from '@/lib/db';
import type { Capability } from './types';

/**
 * 참고 문서 찾기 — 질문마다 먼저 찾아 프롬프트에 붙인다.
 *
 * 동작은 S1 이전의 /api/chat과 같다. NODA로 바꾸는 일은 S4가 한다.
 */
export interface DocSearchDeps {
  retrieve(agentId: string, query: string): Promise<RetrievedChunk[]>;
  hasDocuments(agentId: string): Promise<boolean>;
}

const defaultDeps: DocSearchDeps = {
  async retrieve(agentId, query) {
    return (await retrieveRelevantChunks(agentId, query)).chunks;
  },
  async hasDocuments(agentId) {
    const { count } = await supabaseAdmin
      .from('documents')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agentId);
    return (count ?? 0) > 0;
  },
};

/**
 * 세 경우를 가른다.
 *
 * 자료를 붙일 때 인용 규칙을 함께 넣는 이유: 이 실패는 특정 비서의 문제가
 * 아니라 문서를 근거로 답하는 모든 경로에서 생긴다. 실제로 단위가 없는
 * 물량 표를 읽고 "2,000톤"이라고 답했다 — 숫자는 맞았지만 '톤'은 문서에
 * 없는 값이다.
 *
 * 문서는 있는데 못 찾았을 때 알리지 않으면 모델이 일반 지식으로 그럴듯하게
 * 답한다. 공공기관에서는 근거 없는 답이 근거 있는 답처럼 보이는 것이 가장 위험하다.
 */
export function docSearchAddendum(chunks: RetrievedChunk[], hasDocuments: boolean): string | undefined {
  if (chunks.length > 0) {
    const contextText = chunks
      .map((chunk) => `[참고 자료: ${chunk.documentTitle || '문서'}]\n${chunk.text}`)
      .join('\n\n');
    return [
      '참고 자료:',
      contextText,
      '',
      '[자료 인용 규칙]',
      '- 수치·날짜·금액·비율은 자료에 적힌 그대로 옮기세요. 반올림하거나 환산하지 마세요.',
      '- 자료에 없는 단위(톤·원·명 등)를 임의로 붙이지 마세요. 단위가 없으면 없는 대로 두고,',
      '  필요하면 "자료에 단위 표기가 없습니다"라고 밝히세요.',
      '- 표의 값을 답할 때는 어느 행·열에서 가져왔는지 알 수 있게 항목명을 함께 쓰세요.',
      '- 자료에서 확인되지 않는 것은 추론해 채우지 말고 확인되지 않는다고 말하세요.',
    ].join('\n');
  }

  if (hasDocuments) {
    return [
      '[문서 검색 결과 없음]',
      '이 비서에 연결된 문서에서 이번 질문과 관련된 내용을 찾지 못했습니다.',
      '내부 자료에 근거가 없다는 사실을 먼저 밝히고 답하세요.',
      '일반적인 설명을 덧붙일 수는 있으나, 그것이 이 기관의 자료에서 나온 것처럼',
      '말해서는 안 됩니다. 구체적인 수치·자격요건·기한은 지어내지 말고',
      '어디서 확인해야 하는지 안내하세요.',
    ].join('\n');
  }

  return undefined;
}

export function createDocSearch(deps: DocSearchDeps = defaultDeps): Capability {
  return {
    id: 'doc_search',
    label: '참고 문서 찾기',
    description: '이 비서에 연결한 문서에서 근거를 찾아 출처와 함께 답합니다.',
    isAvailable: () => true,
    async prepare(ctx) {
      let chunks: RetrievedChunk[] = [];
      try {
        chunks = await deps.retrieve(ctx.agentId, ctx.message);
      } catch (error) {
        // 검색이 실패해도 대화는 이어진다. 다만 '문서는 있다'는 사실은 알려
        // 모델이 근거 없이 단정하지 않게 한다.
        console.error('[doc-search] 검색 실패', error);
      }
      const hasDocuments = chunks.length > 0 ? true : await deps.hasDocuments(ctx.agentId).catch(() => false);
      return { chunks, systemAddendum: docSearchAddendum(chunks, hasDocuments) };
    },
  };
}

export const docSearch = createDocSearch();
```

- [ ] **Step 5: `public-data.ts`·`image.ts` 작성**

```typescript
// src/lib/capabilities/public-data.ts
import { availableConnectors, toolsForConnectors, executeTool } from '@/lib/connectors';
import type { Capability } from './types';

/** 공공데이터 조회 — 커넥터를 감싼다. 커넥터 코드는 그대로 둔다. */
export const publicData: Capability = {
  id: 'public_data',
  label: '공공데이터 조회',
  description: '법령·통계·입찰·공시를 실시간으로 조회합니다.',
  isAvailable: () => availableConnectors().length > 0,
  tools(ctx) {
    return toolsForConnectors(ctx.capabilities.public_data?.connectors).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  },
  async execute(tool, input) {
    // executeTool은 예외를 던지지 않고 isError로 돌려준다
    const result = await executeTool(tool, input);
    return { ok: !result.isError, text: result.content, sources: { links: result.sources } };
  },
};
```

```typescript
// src/lib/capabilities/image.ts
import type { Capability } from './types';

/** 사진 읽기 — 도구가 아니라 받을 수 있는 입력을 정한다. 꺼진 비서에 사진을 보내면 서버가 거절한다. */
export const image: Capability = {
  id: 'image',
  label: '사진 읽기',
  description: '화면 캡처·현장 사진·도표를 첨부받아 읽습니다.',
  acceptsImages: true,
  isAvailable: () => true,
};
```

- [ ] **Step 6: `index.ts` 작성**

```typescript
// src/lib/capabilities/index.ts
import type { LlmTool } from '@/lib/llm/types';
import { docSearch } from './doc-search';
import { publicData } from './public-data';
import { image } from './image';
import {
  normalizeCapabilities,
  clampToScope,
  type CapabilitySettings,
  type CapabilityScope,
} from './settings';
import type { Capability, TurnContext } from './types';

/**
 * 능력 목록. 능력을 더할 때는 파일 하나를 만들고 여기 올린다 —
 * 대화 실행기는 고치지 않는다(설계 4.1).
 */
export const CAPABILITIES: Capability[] = [docSearch, publicData, image];

/** 켜져 있고 쓸 준비가 된 능력 */
export function activeCapabilities(settings: CapabilitySettings): Capability[] {
  return CAPABILITIES.filter((cap) => cap.id in settings && cap.isAvailable());
}

/** 이번 턴에 꺼내 줄 도구와, 도구 이름 → 맡은 능력 */
export function toolsFor(
  capabilities: Capability[],
  ctx: TurnContext
): { tools: LlmTool[]; owners: Map<string, Capability> } {
  const tools: LlmTool[] = [];
  const owners = new Map<string, Capability>();
  for (const cap of capabilities) {
    for (const tool of cap.tools?.(ctx) ?? []) {
      tools.push(tool);
      owners.set(tool.name, cap);
    }
  }
  return { tools, owners };
}

/**
 * 대화할 때 실제로 켤 능력.
 *
 * 저장된 값을 다시 정규화한다 — 키가 빠진 커넥터, 깨진 값이 있을 수 있다.
 * 깨져 있으면 아무 능력도 켜지 않는다. 실패가 권한을 넓히면 안 된다.
 * 나만의·부서 비서는 기관 범위로 자른다. 관리자가 나중에 기관에서 끈
 * 연결을 거둬들이는 길이다(설계 3.4).
 */
export function effectiveCapabilities(
  stored: unknown,
  opts: { tier: 'personal' | 'department' | 'official'; scope: CapabilityScope; knownConnectorIds: string[] }
): CapabilitySettings {
  // 키가 빠진 커넥터는 '모르는 연결'로 거절되므로, 정규화 전에 걸러 둔다
  const known = new Set(opts.knownConnectorIds);
  let input = stored;
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    const copy = { ...(stored as Record<string, unknown>) };
    const pd = copy.public_data as { connectors?: unknown } | undefined;
    if (pd && Array.isArray(pd.connectors)) {
      copy.public_data = { connectors: pd.connectors.filter((c) => typeof c === 'string' && known.has(c)) };
    }
    input = copy;
  }

  const normalized = normalizeCapabilities(input, { knownConnectorIds: opts.knownConnectorIds });
  if (!normalized.ok) {
    console.warn('[capabilities] 저장된 능력 설정을 읽지 못해 끕니다:', normalized.message);
    return {};
  }
  return opts.tier === 'official' ? normalized.value : clampToScope(normalized.value, opts.scope);
}
```

- [ ] **Step 7: 통과 확인**

Run: `npx vitest run tests/capabilities.test.ts && npx tsc --noEmit`
Expected: PASS (13 tests), tsc 오류 0건

- [ ] **Step 8: Commit**

```bash
git add src/lib/capabilities tests/capabilities.test.ts
git commit -m "feat: 능력 장치 — 참고 문서 찾기·공공데이터 조회·사진 읽기

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 실행기의 순수 부품

**Files:**
- Create: `src/lib/assistant/types.ts`, `prompt.ts`, `history.ts`, `persist.ts`
- Test: `tests/assistant-parts.test.ts`

**Interfaces:**
- Consumes: `LlmMessage`·`LlmContentBlock`·`LlmUsage`·`LlmTool` (Task 1), `Capability`·`TurnContext` (Task 3), `ChatImage`·`imageAttachmentMarker` (`@/lib/chat-images`), `estimateCostUsd`·`estimateCostKrw` (`@/lib/models`), `ToolSource`, `RetrievedChunk`
- Produces:
  ```typescript
  // types.ts
  export type TurnEvent =
    | { event: 'meta'; data: { conversation_id: string; chunks: RetrievedChunk[] } }
    | { event: 'delta'; data: { text: string } }
    | { event: 'tool_start'; data: { name: string; input: Record<string, unknown> } }
    | { event: 'tool_end'; data: { name: string; ok: boolean; sources: ToolSource[] } }
    | { event: 'tool_limit'; data: { rounds: number } }
    | { event: 'error'; data: { message: string } }
    | { event: 'done'; data: { usage: LlmUsage; title: string | null } };
  export type SendEvent = (event: TurnEvent) => void;
  export interface PreparedTurn { ctx: TurnContext; modelId: string; modelSubstituted: boolean; systemPrompt: string; messages: LlmMessage[]; tools: LlmTool[]; capabilities: Capability[]; conversationId: string; isNewConversation: boolean; chunks: RetrievedChunk[]; storedUserContent: string }
  export type PrepareOutcome = { ok: true; turn: PreparedTurn } | { ok: false; status: number; message: string; details?: Record<string, unknown> };
  export const HISTORY_MESSAGE_LIMIT = 20; export const MAX_TOOL_ROUNDS = 4; export const MAX_OUTPUT_TOKENS = 4096;
  // prompt.ts
  export const DEFAULT_SYSTEM_PROMPT: string;
  export function buildSystemPrompt(base: string | null | undefined, addenda: (string | undefined)[]): string;
  export function buildUserContent(message: string, images: ChatImage[]): string | LlmContentBlock[];
  export function storedUserContent(message: string, imageCount: number): string;
  // history.ts
  export function trimHistory(rows: { role: string; content: string | null }[]): LlmMessage[]; // 최신순 입력 → 시간순 출력
  export async function loadHistory(conversationId: string): Promise<LlmMessage[]>;
  // persist.ts
  export interface MessageRowInput { conversationId: string; userId: string; userContent: string; assistantText: string; chunks: RetrievedChunk[]; links: ToolSource[]; agentVersion: number }
  export function buildMessageRows(input: MessageRowInput): Record<string, unknown>[];
  export function dedupeLinks(links: ToolSource[]): ToolSource[];
  export function mergeUsageByModel(usages: LlmUsage[]): LlmUsage[];
  export function buildUsageDetails(usage: LlmUsage, extra: Record<string, unknown>): Record<string, unknown>;
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// tests/assistant-parts.test.ts
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, buildUserContent, storedUserContent, DEFAULT_SYSTEM_PROMPT } from '@/lib/assistant/prompt';
import { trimHistory } from '@/lib/assistant/history';
import { buildMessageRows, dedupeLinks, mergeUsageByModel, buildUsageDetails } from '@/lib/assistant/persist';

describe('시스템 프롬프트', () => {
  it('비서 지시문 뒤에 능력의 글을 붙인다', () => {
    expect(buildSystemPrompt('공문을 씁니다.', ['참고 자료:\n...', undefined])).toBe('공문을 씁니다.\n\n참고 자료:\n...');
  });

  it('지시문이 없으면 기본 문장', () => {
    expect(buildSystemPrompt(null, [])).toBe(DEFAULT_SYSTEM_PROMPT);
  });
});

describe('사용자 내용', () => {
  const img = { media_type: 'image/png', data: 'AAAA' };

  it('사진을 글보다 앞에 둔다', () => {
    // Anthropic 권장. 모델이 무엇을 보고 답할지 먼저 잡는다.
    const content = buildUserContent('이 표 설명해줘', [img as never]);
    expect(Array.isArray(content)).toBe(true);
    expect((content as { type: string }[]).map((b) => b.type)).toEqual(['image', 'text']);
  });

  it('사진이 없으면 글만', () => {
    expect(buildUserContent('안녕', [])).toBe('안녕');
  });

  it('저장할 때는 사진 바이트 대신 표시만 남긴다', () => {
    const stored = storedUserContent('이 표 설명해줘', 2);
    expect(stored).toContain('2장');
    expect(stored).toContain('이 표 설명해줘');
    expect(stored).not.toContain('AAAA');
  });
});

describe('이력 다듬기', () => {
  it('시간순으로 되돌리고 user로 시작하게 한다', () => {
    // 조회는 최신순으로 한다
    const rows = [
      { role: 'assistant', content: '답2' },
      { role: 'user', content: '질문2' },
      { role: 'assistant', content: '답1' },
      { role: 'system', content: '무시' },
      { role: 'user', content: '  ' },
    ];
    // 시간순: 답1 → 질문2 → 답2. 맨 앞의 답1은 user가 아니라 잘린다.
    expect(trimHistory(rows)).toEqual([
      { role: 'user', content: '질문2' },
      { role: 'assistant', content: '답2' },
    ]);
  });
});

describe('메시지 저장 행', () => {
  const rows = buildMessageRows({
    conversationId: 'c', userId: 'u', userContent: '질문', assistantText: '답',
    chunks: [{ documentId: 'd', documentTitle: 't', chunkIndex: 0, text: '본문', similarity: 0.4 }],
    links: [{ title: '법', url: 'https://a' }],
    agentVersion: 7,
  });

  it('두 행의 키 집합이 같다', () => {
    // PostgREST 배치 삽입은 빠진 칸에 명시적 NULL을 넣는다. 실제로 이것 때문에
    // 대화가 한 건도 저장되지 않았다.
    const keys = rows.map((r) => Object.keys(r).sort().join(','));
    expect(keys[0]).toBe(keys[1]);
  });

  it('답한 판 번호를 남긴다', () => {
    expect(rows.every((r) => r.agent_version === 7)).toBe(true);
  });

  it('출처에는 조각 본문을 싣지 않는다', () => {
    const refs = rows[1].source_references as { chunks: Record<string, unknown>[] };
    expect(refs.chunks[0]).not.toHaveProperty('text');
  });
});

describe('출처와 사용량', () => {
  it('같은 주소의 출처는 하나만', () => {
    expect(dedupeLinks([{ title: 'a', url: 'u' }, { title: 'b', url: 'u' }])).toEqual([{ title: 'a', url: 'u' }]);
  });

  it('모델별로 합친다', () => {
    expect(
      mergeUsageByModel([
        { model: 'm1', input_tokens: 1, output_tokens: 2 },
        { model: 'm2', input_tokens: 5, output_tokens: 5 },
        { model: 'm1', input_tokens: 3, output_tokens: 4 },
      ])
    ).toEqual([
      { model: 'm1', input_tokens: 4, output_tokens: 6 },
      { model: 'm2', input_tokens: 5, output_tokens: 5 },
    ]);
  });

  it('과금 규약 칸을 모두 채운다', () => {
    const d = buildUsageDetails({ model: 'claude-haiku-4-5', input_tokens: 1000, output_tokens: 1000 }, { agent_id: 'a' });
    for (const key of ['model', 'input_tokens', 'output_tokens', 'cost_usd', 'cost_krw', 'agent_id']) {
      expect(d).toHaveProperty(key);
    }
    expect(d.model).toBe('claude-haiku-4-5');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/assistant-parts.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/assistant/prompt"`

- [ ] **Step 3: `types.ts` 작성**

```typescript
// src/lib/assistant/types.ts
import type { LlmMessage, LlmTool, LlmUsage } from '@/lib/llm/types';
import type { Capability, TurnContext } from '@/lib/capabilities/types';
import type { ToolSource } from '@/lib/connectors';
import type { RetrievedChunk } from '@/lib/db';

/** Claude에 함께 보낼 직전 대화 메시지 최대 개수 (사용자+어시스턴트 합산) */
export const HISTORY_MESSAGE_LIMIT = 20;
/** 도구 호출 왕복 상한. 모델이 도구만 반복해서 부르는 상황을 끊는다 */
export const MAX_TOOL_ROUNDS = 4;
export const MAX_OUTPUT_TOKENS = 4096;

/** SSE 이벤트. 이름과 페이로드는 S1 이전과 같다 — ChatInterface가 그대로 읽는다 */
export type TurnEvent =
  | { event: 'meta'; data: { conversation_id: string; chunks: RetrievedChunk[] } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'tool_start'; data: { name: string; input: Record<string, unknown> } }
  | { event: 'tool_end'; data: { name: string; ok: boolean; sources: ToolSource[] } }
  | { event: 'tool_limit'; data: { rounds: number } }
  | { event: 'error'; data: { message: string } }
  | { event: 'done'; data: { usage: LlmUsage; title: string | null } };

export type SendEvent = (event: TurnEvent) => void;

export interface PreparedTurn {
  ctx: TurnContext;
  modelId: string;
  /** 비서의 모델이 기관 허용 목록 밖이라 바꿨는가 */
  modelSubstituted: boolean;
  systemPrompt: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  capabilities: Capability[];
  conversationId: string;
  isNewConversation: boolean;
  chunks: RetrievedChunk[];
  /** 메시지 행에 저장할 사용자 내용(사진 표시 + 질문) */
  storedUserContent: string;
}

export type PrepareOutcome =
  | { ok: true; turn: PreparedTurn }
  | { ok: false; status: number; message: string; details?: Record<string, unknown> };
```

- [ ] **Step 4: `prompt.ts` 작성**

```typescript
// src/lib/assistant/prompt.ts
import { imageAttachmentMarker, type ChatImage } from '@/lib/chat-images';
import type { LlmContentBlock } from '@/lib/llm/types';

export const DEFAULT_SYSTEM_PROMPT = '당신은 도움이 되는 AI 어시스턴트입니다.';

/** 비서 지시문 + 능력이 prepare에서 낸 글 */
export function buildSystemPrompt(base: string | null | undefined, addenda: (string | undefined)[]): string {
  return [base?.trim() || DEFAULT_SYSTEM_PROMPT, ...addenda.filter((a): a is string => Boolean(a))].join('\n\n');
}

/** 사진을 글보다 앞에 둔다 — Anthropic 권장. 모델이 무엇을 보고 답할지 먼저 잡는다. */
export function buildUserContent(message: string, images: ChatImage[]): string | LlmContentBlock[] {
  if (images.length === 0) return message;
  return [
    ...images.map(
      (img): LlmContentBlock => ({
        type: 'image',
        source: { type: 'base64', media_type: img.media_type, data: img.data },
      })
    ),
    { type: 'text', text: message },
  ];
}

/**
 * 사진 자체는 저장하지 않는다. 이력에 실어 되돌려 보내면 매 턴 사진 토큰이
 * 다시 청구되고(이력 20개), 현장 사진·명단 같은 개인정보를 보관하게 된다.
 * 대신 첨부가 있었다는 사실은 남긴다 — 없으면 나중에 답변의 근거를 알 수 없다.
 */
export function storedUserContent(message: string, imageCount: number): string {
  return imageCount > 0 ? `${imageAttachmentMarker(imageCount)}\n${message}` : message;
}
```

- [ ] **Step 5: `history.ts` 작성**

```typescript
// src/lib/assistant/history.ts
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { LlmMessage } from '@/lib/llm/types';
import { HISTORY_MESSAGE_LIMIT } from './types';

/** 최신순으로 받은 행을 시간순으로 되돌리고, 모델이 받을 수 있는 꼴로 다듬는다. */
export function trimHistory(rowsNewestFirst: { role: string; content: string | null }[]): LlmMessage[] {
  const history = [...rowsNewestFirst]
    .reverse()
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && Boolean(m.content?.trim()))
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content as string }));

  // Claude는 user 메시지로 시작해야 한다
  while (history.length > 0 && history[0].role !== 'user') history.shift();
  return history;
}

export async function loadHistory(conversationId: string): Promise<LlmMessage[]> {
  const { data } = await supabaseAdmin
    .from('messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(HISTORY_MESSAGE_LIMIT);
  return trimHistory((data ?? []) as { role: string; content: string | null }[]);
}
```

- [ ] **Step 6: `persist.ts` 작성**

```typescript
// src/lib/assistant/persist.ts
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { estimateCostUsd, estimateCostKrw } from '@/lib/models';
import type { LlmUsage } from '@/lib/llm/types';
import type { ToolSource } from '@/lib/connectors';
import type { RetrievedChunk } from '@/lib/db';

export interface MessageRowInput {
  conversationId: string;
  userId: string;
  userContent: string;
  assistantText: string;
  chunks: RetrievedChunk[];
  links: ToolSource[];
  agentVersion: number;
}

export function dedupeLinks(links: ToolSource[]): ToolSource[] {
  return links.filter((link, index, all) => all.findIndex((other) => other.url === link.url) === index);
}

/**
 * 메시지 두 행. **키 집합이 같아야 한다.**
 *
 * PostgREST는 배치 삽입 시 모든 행의 칸을 합집합으로 맞추고 빠진 행에는
 * 명시적 NULL을 넣는다. 기본값이 우회되어 NOT NULL 칸이면 두 행이 함께
 * 실패한다. 실제로 사용자 행에 source_references가 빠져 대화가 한 건도
 * 저장되지 않았다.
 */
export function buildMessageRows(input: MessageRowInput): Record<string, unknown>[] {
  return [
    {
      conversation_id: input.conversationId,
      user_id: input.userId,
      role: 'user',
      content: input.userContent,
      source_references: {},
      agent_version: input.agentVersion,
    },
    {
      conversation_id: input.conversationId,
      user_id: null,
      role: 'assistant',
      content: input.assistantText,
      source_references: {
        chunks: input.chunks.map((c) => ({
          documentId: c.documentId,
          documentTitle: c.documentTitle,
          chunkIndex: c.chunkIndex,
          similarity: c.similarity,
        })),
        links: dedupeLinks(input.links),
      },
      agent_version: input.agentVersion,
    },
  ];
}

export async function saveMessages(rows: Record<string, unknown>[]): Promise<string | null> {
  const { error } = await supabaseAdmin.from('messages').insert(rows);
  if (error) {
    console.error('[assistant] 메시지 저장 오류:', error);
    return error.message;
  }
  return null;
}

/** 모델이 다르면 단가가 다르다. 모델별로 한 행씩 남긴다. */
export function mergeUsageByModel(usages: LlmUsage[]): LlmUsage[] {
  const byModel = new Map<string, LlmUsage>();
  for (const u of usages) {
    const prev = byModel.get(u.model);
    byModel.set(
      u.model,
      prev
        ? { model: u.model, input_tokens: prev.input_tokens + u.input_tokens, output_tokens: prev.output_tokens + u.output_tokens }
        : { ...u }
    );
  }
  return [...byModel.values()];
}

/** 과금 규약(CLAUDE.md): model·토큰·기록 시점 단가로 확정한 원가 */
export function buildUsageDetails(usage: LlmUsage, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ...extra,
    model: usage.model,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cost_usd: estimateCostUsd(usage, usage.model),
    cost_krw: estimateCostKrw(usage, usage.model),
  };
}

export async function writeUsageLog(row: {
  departmentId: string;
  userId: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  details: Record<string, unknown>;
}): Promise<void> {
  // organization_id는 트리거(0012/0022)가 department_id로부터 채운다
  const { error } = await supabaseAdmin.from('usage_logs').insert({
    department_id: row.departmentId,
    user_id: row.userId,
    action: row.action,
    resource_type: row.resourceType,
    resource_id: row.resourceId,
    details: row.details,
  });
  if (error) console.error('[assistant] 사용 로그 기록 실패', row.action, error.message);
}
```

참고: 지금 `/api/chat`은 비서 행에 `user_id`를 넣지 않는다. 키 집합을 맞추려고 `user_id: null`을 명시한다 — 결과는 같다(비서 행의 `user_id`는 원래 NULL).

- [ ] **Step 7: 통과 확인**

Run: `npx vitest run tests/assistant-parts.test.ts && npx tsc --noEmit`
Expected: PASS (12 tests), tsc 오류 0건

- [ ] **Step 8: Commit**

```bash
git add src/lib/assistant/types.ts src/lib/assistant/prompt.ts src/lib/assistant/history.ts src/lib/assistant/persist.ts tests/assistant-parts.test.ts
git commit -m "feat: 대화 실행기의 순수 부품 — 프롬프트·이력·저장 행

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 도구 루프

**Files:**
- Create: `src/lib/assistant/stream.ts` (도구 루프 부분)
- Test: `tests/tool-loop.test.ts`

**Interfaces:**
- Consumes: `streamChat`·`setLlmAdapterForTests` (Task 1), `Capability`·`TurnContext`·`ToolOutcome` (Task 3), `SendEvent`·`MAX_OUTPUT_TOKENS` (Task 4), `dedupeLinks` (Task 4)
- Produces:
  ```typescript
  export interface LoopArgs { modelId: string; systemPrompt: string; messages: LlmMessage[]; tools: LlmTool[]; owners: Map<string, Capability>; ctx: TurnContext; maxRounds: number }
  export interface LoopResult { text: string; usage: LlmUsage; capabilityUsage: LlmUsage[]; links: ToolSource[] }
  export const TOOL_LIMIT_NOTICE: string;
  export async function runToolLoop(args: LoopArgs, send: SendEvent): Promise<LoopResult>;
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// tests/tool-loop.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { setLlmAdapterForTests } from '@/lib/llm';
import type { LlmAdapter, LlmRequest, LlmStreamEvent } from '@/lib/llm/types';
import { runToolLoop, TOOL_LIMIT_NOTICE } from '@/lib/assistant/stream';
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
  organizationId: 'o', departmentId: 'd', userId: 'u', agentId: 'a', agentVersion: 1, capabilities: {}, message: 'q',
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

  it('도구가 던져도 대화는 이어지고 이유가 남는다', async () => {
    const owners = new Map([['law_search', lawCapability(async () => { throw new Error('법제처 응답 없음'); })]]);
    const adapter = scripted([[toolCall('t1'), done('tool_use')], [{ type: 'text', text: '조회에 실패했습니다' }, done('end_turn')]]);
    const { events } = await run(adapter, owners);
    const result = (adapter.requests[1].messages.at(-1)!.content as { content: string; is_error: boolean }[])[0];
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('법제처 응답 없음');
    expect(events.find((e) => e.event === 'tool_end')).toEqual({
      event: 'tool_end', data: { name: 'law_search', ok: false, sources: [] },
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

  it('능력이 쓴 AI 사용량을 따로 모은다', async () => {
    const owners = new Map([['law_search', lawCapability(async () => ({ ok: true, text: 'x', usage: [{ model: 'claude-sonnet-4-6', input_tokens: 3, output_tokens: 4 }] }))]]);
    const adapter = scripted([[toolCall('t1'), done('tool_use')], [done('end_turn')]]);
    const { result } = await run(adapter, owners);
    expect(result.capabilityUsage).toEqual([{ model: 'claude-sonnet-4-6', input_tokens: 3, output_tokens: 4 }]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/tool-loop.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/assistant/stream"`

- [ ] **Step 3: 구현**

```typescript
// src/lib/assistant/stream.ts
import { streamChat } from '@/lib/llm';
import type { LlmContentBlock, LlmMessage, LlmTool, LlmUsage } from '@/lib/llm/types';
import type { Capability, TurnContext, ToolOutcome } from '@/lib/capabilities/types';
import type { ToolSource } from '@/lib/connectors';
import { MAX_OUTPUT_TOKENS, type SendEvent } from './types';
import { dedupeLinks } from './persist';

export interface LoopArgs {
  modelId: string;
  systemPrompt: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  /** 도구 이름 → 맡은 능력 (capabilities/index.ts의 toolsFor) */
  owners: Map<string, Capability>;
  ctx: TurnContext;
  maxRounds: number;
}

export interface LoopResult {
  text: string;
  /** 대화 모델의 사용량. 모델은 실제로 부른 모델이다 */
  usage: LlmUsage;
  /** 능력 안에서 쓴 AI 사용량 */
  capabilityUsage: LlmUsage[];
  links: ToolSource[];
}

export const TOOL_LIMIT_NOTICE =
  '[중요] 도구 호출 한도에 도달해 더 이상 도구를 사용할 수 없습니다. 앞으로 무엇을 하겠다는 예고는 하지 마세요. ' +
  '지금까지 확보한 자료만으로 답변을 완성하되, 자료가 부족하면 무엇이 부족한지와 사용자가 무엇을 다시 물으면 되는지를 알려주세요.';

async function executeCall(
  owners: Map<string, Capability>,
  call: { name: string; input: Record<string, unknown> },
  ctx: TurnContext
): Promise<ToolOutcome> {
  // 모델은 꺼내 준 도구만 부를 수 있지만 실행 직전에 한 번 더 확인한다
  const owner = owners.get(call.name);
  if (!owner?.execute) return { ok: false, text: `허용되지 않은 도구입니다: ${call.name}` };
  try {
    return await owner.execute(call.name, call.input, ctx);
  } catch (error) {
    // 한 능력이 실패해도 대화는 계속된다(설계 7.5). 이유는 모델과 화면에 함께 간다.
    console.error(`[assistant] ${call.name} 실행 오류:`, error);
    return {
      ok: false,
      text: `도구 실행 중 오류가 발생했습니다: ${error instanceof Error ? error.message : '알 수 없는 오류'}`,
    };
  }
}

export async function runToolLoop(args: LoopArgs, send: SendEvent): Promise<LoopResult> {
  const messages: LlmMessage[] = [...args.messages];
  const usage: LlmUsage = { model: args.modelId, input_tokens: 0, output_tokens: 0 };
  const capabilityUsage: LlmUsage[] = [];
  const links: ToolSource[] = [];
  const tools = args.tools.length > 0 ? args.tools : undefined;
  let text = '';

  for (let round = 0; round < args.maxRounds; round++) {
    const calls: { id: string; name: string; input: Record<string, unknown> }[] = [];
    let roundText = '';
    let stopReason: string | null = null;

    for await (const event of streamChat({
      model: args.modelId,
      system: args.systemPrompt,
      messages,
      maxTokens: MAX_OUTPUT_TOKENS,
      tools,
    })) {
      if (event.type === 'text') {
        roundText += event.text;
        text += event.text;
        send({ event: 'delta', data: { text: event.text } });
      } else if (event.type === 'tool_use') {
        calls.push({ id: event.id, name: event.name, input: event.input });
      } else {
        usage.input_tokens += event.usage.input_tokens;
        usage.output_tokens += event.usage.output_tokens;
        stopReason = event.stopReason;
      }
    }

    if (stopReason !== 'tool_use' || calls.length === 0) break;

    // 모델이 만든 턴을 그대로 이력에 더한다 (글 + tool_use 블록)
    const assistantBlocks: LlmContentBlock[] = [];
    if (roundText) assistantBlocks.push({ type: 'text', text: roundText });
    for (const call of calls) assistantBlocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
    messages.push({ role: 'assistant', content: assistantBlocks });

    const resultBlocks: LlmContentBlock[] = [];
    for (const call of calls) {
      send({ event: 'tool_start', data: { name: call.name, input: call.input } });
      const outcome = await executeCall(args.owners, call, args.ctx);
      const callLinks = outcome.sources?.links ?? [];
      links.push(...callLinks);
      if (outcome.usage) capabilityUsage.push(...outcome.usage);
      send({ event: 'tool_end', data: { name: call.name, ok: outcome.ok, sources: callLinks } });
      resultBlocks.push({ type: 'tool_result', tool_use_id: call.id, content: outcome.text, is_error: !outcome.ok });
    }
    messages.push({ role: 'user', content: resultBlocks });

    if (round === args.maxRounds - 1) {
      // 상한에 걸렸다. 그냥 끝내면 방금 받은 도구 결과를 모델에 돌려주지 못해
      // 사용자는 "찾아볼게요" 같은 도입부만 받는다. 도구 정의는 유지한 채
      // tool_choice='none'으로 한 번 더 불러 답을 마무리시킨다.
      console.warn('[assistant] 도구 라운드 상한 도달 — tool_choice=none으로 마무리');
      send({ event: 'tool_limit', data: { rounds: args.maxRounds } });
      for await (const event of streamChat({
        model: args.modelId,
        system: `${args.systemPrompt}\n\n${TOOL_LIMIT_NOTICE}`,
        messages,
        maxTokens: MAX_OUTPUT_TOKENS,
        tools,
        toolChoice: 'none',
      })) {
        if (event.type === 'text') {
          text += event.text;
          send({ event: 'delta', data: { text: event.text } });
        } else if (event.type === 'done') {
          usage.input_tokens += event.usage.input_tokens;
          usage.output_tokens += event.usage.output_tokens;
        }
      }
    }
  }

  return { text, usage, capabilityUsage, links: dedupeLinks(links) };
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/tool-loop.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/assistant/stream.ts tests/tool-loop.test.ts
git commit -m "feat: 대화 실행기 도구 루프 — 실제 모델로 사용량 기록

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 한 턴 준비 · 흘려보내기 · `/api/chat`

**Files:**
- Create: `src/lib/assistant/prepare.ts`
- Modify: `src/lib/assistant/stream.ts` (`streamTurn` 추가)
- Modify: `src/app/api/chat/route.ts` (전체 교체)
- Modify: `tests/chat-images.test.ts`, `tests/message-persistence.test.ts`

**Interfaces:**
- Consumes: S1-a의 `getActorScope`·`canUseAgent`·`AGENT_ACCESS_COLUMNS`·`AgentAccessInfo`·`getCapabilityScope`, Task 1~5 전부, `checkTokenLimit`·`limitMessage`, `filterUserInput`, `validateChatImages`, `getAllowedModelIds`·`resolveModel`, `connectorCatalog`, `complete`
- Produces:
  ```typescript
  export async function prepareTurn(session: Session, body: Record<string, unknown>): Promise<PrepareOutcome>;
  export async function streamTurn(turn: PreparedTurn, send: SendEvent): Promise<void>;
  ```

- [ ] **Step 1: `prepare.ts` 작성**

```typescript
// src/lib/assistant/prepare.ts
import type { Session } from 'next-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getActorScope } from '@/lib/actor-scope';
import { canUseAgent, AGENT_ACCESS_COLUMNS, type AgentAccessInfo } from '@/lib/agent-permissions';
import { getCapabilityScope } from '@/lib/connector-scope';
import { checkTokenLimit, limitMessage } from '@/lib/usage-limit';
import { filterUserInput } from '@/lib/filter';
import { validateChatImages, type ChatImage } from '@/lib/chat-images';
import { getAllowedModelIds, resolveModel } from '@/lib/model-policy';
import { connectorCatalog } from '@/lib/connectors';
import { activeCapabilities, effectiveCapabilities, toolsFor } from '@/lib/capabilities';
import type { TurnContext, PrepareResult } from '@/lib/capabilities/types';
import type { RetrievedChunk } from '@/lib/db';
import { buildSystemPrompt, buildUserContent, storedUserContent } from './prompt';
import { loadHistory } from './history';
import type { PrepareOutcome } from './types';

type AgentRow = AgentAccessInfo & {
  name: string;
  system_prompt: string | null;
  model_id: string | null;
  capabilities: unknown;
  agent_type: string | null;
};

function reject(message: string, status: number, details?: Record<string, unknown>): PrepareOutcome {
  return { ok: false, status, message, details };
}

/**
 * 한 턴을 준비한다. 여기서 거절되면 라우트가 JSON으로 답한다
 * (스트림 시작 전 실패 규약).
 */
export async function prepareTurn(session: Session, body: Record<string, unknown>): Promise<PrepareOutcome> {
  const { agent_id, message, conversation_id, images } = body;

  if (typeof agent_id !== 'string' || !agent_id) return reject('에이전트 ID는 필수입니다.', 400);
  if (typeof message !== 'string' || !message.trim()) return reject('메시지는 필수입니다.', 400);

  // 화면에서도 거르지만 그건 표시일 뿐이고 실제 제한은 여기서 건다.
  const imageError = validateChatImages(images);
  if (imageError) return reject(imageError, 400);
  const attachedImages: ChatImage[] = Array.isArray(images) ? (images as ChatImage[]) : [];

  // 소속을 알 수 없으면 거부한다. 추측해서 배정하면 타 기관 자료에 닿는다.
  const actor = await getActorScope(session);
  if (!actor || !actor.organizationId) {
    return reject('소속 부서가 지정되지 않았습니다. 기관 관리자에게 문의하세요.', 403);
  }

  // 사용자를 함께 넘긴다. 빠뜨리면 개인 한도가 조용히 적용되지 않는다.
  const limitStatus = await checkTokenLimit(actor.departmentId, actor.userId);
  if (!limitStatus.allowed) {
    return reject(limitMessage(limitStatus), 429, {
      reason: limitStatus.reason,
      usedTokens: limitStatus.usedTokens,
      limitTokens: limitStatus.limitTokens,
      budget: limitStatus.budget,
    });
  }

  const { data } = await supabaseAdmin
    .from('agents')
    .select(`${AGENT_ACCESS_COLUMNS}, name, system_prompt, model_id, capabilities, agent_type`)
    .eq('id', agent_id)
    .maybeSingle();
  const agent = data as AgentRow | null;

  if (!agent || agent.deleted_at || !agent.is_active) return reject('에이전트를 찾을 수 없습니다.', 404);
  if (!canUseAgent(agent, actor)) return reject('해당 에이전트에 접근할 권한이 없습니다.', 403);
  if (agent.agent_type === 'link') return reject('링크형 비서는 대화할 수 없습니다.', 400);

  const capabilitySettings = effectiveCapabilities(agent.capabilities, {
    tier: agent.tier,
    scope: agent.tier === 'official' ? { publicDataConnectors: new Set() } : await getCapabilityScope(actor.departmentId),
    knownConnectorIds: connectorCatalog().map((c) => c.id),
  });
  const capabilities = activeCapabilities(capabilitySettings);

  if (attachedImages.length > 0 && !capabilities.some((c) => c.acceptsImages)) {
    return reject('이 비서는 사진을 받지 않습니다. 사진 읽기를 켠 비서에서 물어 주세요.', 400);
  }

  const filterResult = await filterUserInput(actor.departmentId, message);
  if (!filterResult.isValid) {
    return reject('메시지에 금지된 내용이 포함되어 있습니다.', 400, {
      blockedWords: filterResult.blockedWords,
      blockedPatterns: filterResult.blockedPatterns,
    });
  }

  // ── 대화 ──
  let conversationId: string;
  let history: Awaited<ReturnType<typeof loadHistory>> = [];
  if (typeof conversation_id === 'string' && conversation_id) {
    const { data: existing } = await supabaseAdmin
      .from('conversations')
      .select('id')
      .eq('id', conversation_id)
      .eq('user_id', actor.userId)
      .eq('agent_id', agent_id)
      .maybeSingle();
    if (!existing) return reject('대화를 찾을 수 없습니다.', 404);
    conversationId = existing.id;
    history = await loadHistory(conversationId);
  } else {
    const { data: created, error } = await supabaseAdmin
      .from('conversations')
      .insert({
        department_id: actor.departmentId,
        agent_id,
        user_id: actor.userId,
        title: `대화 with ${agent.name}`,
      })
      .select('id')
      .single();
    if (error || !created) {
      console.error('[assistant] conversation insert error:', error);
      return reject(`대화 생성 실패: ${error?.message ?? '알 수 없는 오류'}`, 500);
    }
    conversationId = created.id;
  }

  // ── 모델 ── 기관 허용 범위 안이면 비서의 모델, 아니면 허용 목록의 첫 번째
  const allowedModels = await getAllowedModelIds(actor.organizationId);
  const { modelId, substituted } = resolveModel(agent.model_id, allowedModels);
  if (substituted) {
    console.warn('[assistant] 비서 모델이 기관 허용 목록 밖이라 바꿈:', agent.model_id, '→', modelId);
  }

  const ctx: TurnContext = {
    organizationId: actor.organizationId,
    departmentId: actor.departmentId,
    userId: actor.userId,
    agentId: agent_id,
    agentVersion: agent.version,
    capabilities: capabilitySettings,
    message,
  };

  const prepared: PrepareResult[] = await Promise.all(
    capabilities.map((cap) => (cap.prepare ? cap.prepare(ctx) : Promise.resolve({} as PrepareResult)))
  );
  const chunks: RetrievedChunk[] = prepared.flatMap((p) => p.chunks ?? []);
  const { tools } = toolsFor(capabilities, ctx);

  return {
    ok: true,
    turn: {
      ctx,
      modelId,
      modelSubstituted: substituted,
      systemPrompt: buildSystemPrompt(agent.system_prompt, prepared.map((p) => p.systemAddendum)),
      messages: [...history, { role: 'user', content: buildUserContent(message, attachedImages) }],
      tools,
      capabilities,
      conversationId,
      isNewConversation: !(typeof conversation_id === 'string' && conversation_id),
      chunks,
      storedUserContent: storedUserContent(message, attachedImages.length),
    },
  };
}
```

- [ ] **Step 2: `streamTurn`을 `stream.ts` 끝에 추가** — import에 `complete`(`@/lib/llm`), `toolsFor`(`@/lib/capabilities`), `MAX_TOOL_ROUNDS`·`PreparedTurn`(`./types`), `buildMessageRows`·`saveMessages`·`mergeUsageByModel`·`buildUsageDetails`·`writeUsageLog`(`./persist`), `supabaseAdmin`을 더한다.

```typescript
/**
 * 한 턴을 흘려보낸다. 시작 뒤의 실패는 SSE error로 알린다.
 *
 * 순서: meta → 도구 루프(delta·tool_*) → 메시지 저장 → 사용 기록 → 제목 → done
 */
export async function streamTurn(turn: PreparedTurn, send: SendEvent): Promise<void> {
  // 대화 id와 출처를 먼저 보내 화면이 바로 반영하게 한다
  send({ event: 'meta', data: { conversation_id: turn.conversationId, chunks: turn.chunks } });

  let result: LoopResult;
  try {
    result = await runToolLoop(
      {
        modelId: turn.modelId,
        systemPrompt: turn.systemPrompt,
        messages: turn.messages,
        tools: turn.tools,
        owners: toolsFor(turn.capabilities, turn.ctx).owners,
        ctx: turn.ctx,
        maxRounds: MAX_TOOL_ROUNDS,
      },
      send
    );
  } catch (error) {
    console.error('[assistant] streaming error:', error);
    send({ event: 'error', data: { message: error instanceof Error ? error.message : '응답 생성 중 오류가 발생했습니다.' } });
    return;
  }

  const saveError = await saveMessages(
    buildMessageRows({
      conversationId: turn.conversationId,
      userId: turn.ctx.userId,
      userContent: turn.storedUserContent,
      assistantText: result.text,
      chunks: turn.chunks,
      links: result.links,
      agentVersion: turn.ctx.agentVersion,
    })
  );
  if (saveError) {
    // 답변은 이미 흘러갔으므로 요청을 실패시킬 수 없다. 저장 실패는 알린다 —
    // 모르면 새로고침 뒤 내용이 사라진 이유를 알 수 없다.
    send({ event: 'error', data: { message: '답변은 생성됐지만 대화 저장에 실패했습니다. 필요하면 내용을 복사해 두세요.' } });
  }

  // 모델이 다르면 단가가 다르므로 모델별로 한 행씩
  for (const usage of mergeUsageByModel([result.usage, ...result.capabilityUsage])) {
    await writeUsageLog({
      departmentId: turn.ctx.departmentId,
      userId: turn.ctx.userId,
      action: 'chat_message',
      resourceType: 'conversation',
      resourceId: turn.conversationId,
      details: buildUsageDetails(usage, {
        agent_id: turn.ctx.agentId,
        agent_version: turn.ctx.agentVersion,
        chunks_retrieved: turn.chunks.length,
        model_substituted: turn.modelSubstituted,
      }),
    });
  }

  // 새 대화면 제목. 이 턴의 모델로 부른다 — 기본 모델이 기관 허용 목록에
  // 없을 수 있다. 쓴 토큰도 기록한다(예전에는 빠져 있었다).
  let title: string | null = null;
  if (turn.isNewConversation) {
    try {
      const completion = await complete({
        model: turn.modelId,
        maxTokens: 40,
        messages: [
          {
            role: 'user',
            content: `다음 질문을 20자 이내 한국어 제목으로 요약해줘. 제목만 출력하고 다른 설명은 하지 마: "${turn.ctx.message}"`,
          },
        ],
      });
      await writeUsageLog({
        departmentId: turn.ctx.departmentId,
        userId: turn.ctx.userId,
        action: 'conversation_title',
        resourceType: 'conversation',
        resourceId: turn.conversationId,
        details: buildUsageDetails(completion.usage, { agent_id: turn.ctx.agentId }),
      });
      const autoTitle = completion.text.trim().replace(/^["']|["']$/g, '').slice(0, 30);
      if (autoTitle) {
        await supabaseAdmin.from('conversations').update({ title: autoTitle }).eq('id', turn.conversationId);
        title = autoTitle;
      }
    } catch {
      // 제목 생성 실패는 대화에 영향이 없다
    }
  }

  send({ event: 'done', data: { usage: result.usage, title } });
}
```

- [ ] **Step 3: `src/app/api/chat/route.ts` 전체 교체**

```typescript
import { NextRequest } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { jsonError } from '@/lib/agent-route-helpers';
import { prepareTurn } from '@/lib/assistant/prepare';
import { streamTurn } from '@/lib/assistant/stream';
import type { TurnEvent } from '@/lib/assistant/types';

/**
 * 대화 한 턴. 일은 실행기(src/lib/assistant/)가 한다.
 * 여기서는 인증 → 준비(거절이면 JSON) → SSE로 흘려보내기만 한다.
 */
function sse(event: TurnEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const body = (await request.json()) as Record<string, unknown>;
    const prepared = await prepareTurn(session, body);
    if (!prepared.ok) return jsonError(prepared.message, prepared.status, prepared.details);

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          await streamTurn(prepared.turn, (event) => controller.enqueue(encoder.encode(sse(event))));
        } catch (error) {
          console.error('[chat] stream error:', error);
          controller.enqueue(encoder.encode(sse({ event: 'error', data: { message: '응답 생성 중 오류가 발생했습니다.' } })));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Vercel/nginx 프록시가 스트림을 버퍼링하지 않도록
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    console.error('채팅 오류:', error);
    return jsonError(error instanceof Error ? error.message : '서버 오류가 발생했습니다.', 500);
  }
}
```

- [ ] **Step 4: 원본을 읽던 테스트를 동작 테스트로 바꾼다**

`tests/chat-images.test.ts`의 `describe('/api/chat 연결', ...)` 블록 전체를 다음으로 바꾼다 (파일 위쪽 import에 `buildUserContent`·`storedUserContent`를 `@/lib/assistant/prompt`에서 더한다):

```typescript
describe('대화 실행기 연결', () => {
  const prepare = readFileSync('src/lib/assistant/prepare.ts', 'utf8');

  it('서버가 검사를 다시 한다', () => {
    // 화면 검사는 표시일 뿐이다. API를 직접 부르는 경로가 언제나 있다.
    expect(prepare).toContain('validateChatImages(images)');
  });

  it('사진 읽기가 꺼진 비서는 사진을 거절한다', () => {
    expect(prepare).toContain('acceptsImages');
  });

  it('이미지를 텍스트보다 앞에 둔다', () => {
    const content = buildUserContent('질문', [{ media_type: 'image/png', data: 'AAAA' } as never]);
    expect((content as { type: string }[]).map((b) => b.type)).toEqual(['image', 'text']);
  });

  it('이미지 바이트를 DB에 저장하지 않는다', () => {
    expect(storedUserContent('질문', 1)).not.toContain('AAAA');
    expect(storedUserContent('질문', 1)).toContain('1장');
  });
});
```

`tests/message-persistence.test.ts`의 `describe('/api/chat의 메시지 삽입', ...)` 블록 전체를 다음으로 바꾼다:

```typescript
describe('대화 실행기의 메시지 삽입', () => {
  it('두 행이 같은 키를 갖는다', async () => {
    const { buildMessageRows } = await import('@/lib/assistant/persist');
    const rows = buildMessageRows({
      conversationId: 'c', userId: 'u', userContent: 'q', assistantText: 'a', chunks: [], links: [], agentVersion: 1,
    });
    expect(hasUniformKeys(rows)).toBe(true);
    expect(rows[0]).toHaveProperty('source_references');
  });

  it('저장 실패를 화면에 알린다', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/lib/assistant/stream.ts', 'utf8');
    const start = src.indexOf('if (saveError)');
    expect(start).toBeGreaterThan(-1);
    expect(src.slice(start, start + 300)).toContain("event: 'error'");
  });

  it('참고 자료를 붙일 때 인용 규칙도 함께 넣는다', async () => {
    // 프리셋마다 적지 않고 여기 한 곳에 두는 이유: 이 실패는 특정 비서의
    // 문제가 아니라 문서를 근거로 답하는 모든 경로에서 생긴다.
    const { docSearchAddendum } = await import('@/lib/capabilities/doc-search');
    const text = docSearchAddendum([{ documentId: 'd', chunkIndex: 0, text: 't', similarity: 0.5 }], true)!;
    expect(text).toContain('참고 자료:');
    expect(text).toContain('자료 인용 규칙');
    expect(text).toContain('단위');
  });
});
```

- [ ] **Step 5: 확인**

Run: `npx vitest run && npx tsc --noEmit`
Expected: `usage-limit.test.ts`의 '대상 라우트를 실제로 찾는다'가 FAIL할 수 있다(Task 8에서 고친다). 나머지 PASS, tsc 오류 0건.

- [ ] **Step 6: Commit**

```bash
git add src/lib/assistant src/app/api/chat/route.ts tests/chat-images.test.ts tests/message-persistence.test.ts
git commit -m "feat: /api/chat을 대화 실행기 위로 — 비서 모델·능력 적용

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 요술봉

**Files:**
- Modify: `src/app/api/enhance-prompt/route.ts`

**Interfaces:**
- Consumes: `complete`, `getActorScope`, `checkTokenLimit`·`limitMessage`, `resolveModelForDepartment`, `buildUsageDetails`·`writeUsageLog`

- [ ] **Step 1: 구현** — 인증 검사 뒤에 한도·모델을 넣고, `callClaudeAPI` 호출을 바꾼다. import에서 `callClaudeAPI`를 지우고 다음을 더한다:

```typescript
import { complete } from '@/lib/llm';
import { getActorScope } from '@/lib/actor-scope';
import { checkTokenLimit, limitMessage } from '@/lib/usage-limit';
import { resolveModelForDepartment } from '@/lib/model-policy';
import { buildUsageDetails, writeUsageLog } from '@/lib/assistant/persist';
```

`const body = await request.json();` 앞에 추가:
```typescript
    // 요술봉도 토큰을 쓴다. 예전에는 한도도 기록도 없어 예산 판정에서 빠졌다.
    const actor = await getActorScope(session);
    if (!actor) {
      return NextResponse.json({ ok: false, error: { message: '소속 부서가 지정되지 않았습니다.' } }, { status: 403 });
    }
    const limitStatus = await checkTokenLimit(actor.departmentId, actor.userId);
    if (!limitStatus.allowed) {
      return NextResponse.json({ ok: false, error: { message: limitMessage(limitStatus) } }, { status: 429 });
    }
```

`const result = await callClaudeAPI(...)`부터 `return NextResponse.json({ ok: true, data: { enhancedPrompt: result.content.trim() } });`까지를 다음으로 바꾼다:
```typescript
    const result = await complete({
      model: await resolveModelForDepartment(actor.departmentId),
      maxTokens: 512,
      messages: [{ role: 'user', content: userMessage }],
    });

    await writeUsageLog({
      departmentId: actor.departmentId,
      userId: actor.userId,
      action: 'prompt_enhance',
      resourceType: 'prompt',
      resourceId: null,
      details: buildUsageDetails(result.usage, { type }),
    });

    return NextResponse.json({ ok: true, data: { enhancedPrompt: result.text.trim() } });
```

- [ ] **Step 2: 확인**

Run: `npx tsc --noEmit`
Expected: 오류 0건

- [ ] **Step 3: Commit**

```bash
git add src/app/api/enhance-prompt/route.ts
git commit -m "fix: 요술봉도 한도 확인과 사용 기록을 거친다

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 걷어내기와 경계 검사

**Files:**
- Delete: `src/lib/claude.ts`, `src/app/api/qna/`, `src/app/api/report/`, `src/app/api/employee/`, `src/app/employee/`, `src/app/report/`, `src/components/report/`, `src/components/employee/`
- Modify: `src/components/chat/ChatInterface.tsx`
- Modify: `tests/usage-limit.test.ts`, `tests/route-auth.test.ts`, `scripts/db-check.mjs`
- Create: `tests/llm-boundary.test.ts`

- [ ] **Step 1: 실패하는 경계 검사 작성**

```typescript
// tests/llm-boundary.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

/**
 * 모델 호출은 AI 연결부(src/lib/llm/) 한 곳으로 모은다(설계 5.1).
 * 다른 곳에서 업체 주소를 직접 부르면 기관 내부 모델로 바꿀 때 그 자리가 남는다.
 */
const files = execSync('find src -name "*.ts" -o -name "*.tsx"', { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean);

/** 모델 호출이 아니라 키가 유효한지만 보는 곳. 이유와 함께 둔다. */
const ALLOWED = new Map<string, string>([
  ['src/app/api/super/api-keys/verify/route.ts', '슈퍼관리자가 등록한 API 키의 유효성 확인. 대화가 아니다'],
  ['src/app/api/super/organizations/[id]/verify-key/route.ts', '기관 API 키의 유효성 확인. 대화가 아니다'],
]);

describe('AI 연결부 경계', () => {
  it('Anthropic 주소는 llm/ 밖에서 쓰지 않는다', () => {
    const offenders = files.filter(
      (f) => !f.startsWith('src/lib/llm/') && !ALLOWED.has(f) && readFileSync(f, 'utf8').includes('api.anthropic.com')
    );
    expect(offenders).toEqual([]);
  });

  it('예외 목록은 이유가 있고 실제로 있는 파일이다', () => {
    for (const [file, reason] of ALLOWED) {
      expect(existsSync(file), file).toBe(true);
      expect(reason.length).toBeGreaterThan(5);
    }
  });

  it('옛 claude.ts는 없다', () => {
    expect(existsSync('src/lib/claude.ts')).toBe(false);
    expect(files.filter((f) => readFileSync(f, 'utf8').includes("from '@/lib/claude'"))).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/llm-boundary.test.ts`
Expected: FAIL — `src/lib/claude.ts` 가 남아 있고 `qna`·`report` 라우트가 `@/lib/claude`를 import한다

- [ ] **Step 3: 걷어내기**

```bash
git rm -r -q src/lib/claude.ts src/app/api/qna src/app/api/report src/app/api/employee src/app/employee src/app/report src/components/report src/components/employee
```

그 뒤 `grep -rn "@/lib/claude\|components/report\|components/employee\|/api/qna\|/api/report\|/employee/" src`로 남은 참조를 찾아 지운다. `src/app/api/stats/route.ts`의 주석에 `/api/employee/stats`가 나오면 그 주석 줄을 지운다. `/api/templates`와 `/admin/templates`는 지우지 않는다(S1-c에서 읽기 전용으로 바꾼다).

- [ ] **Step 4: 대화 화면 — 모델 선택을 비서 모델 표시로**

`src/components/chat/ChatInterface.tsx`:
- `const [selectedModel, setSelectedModel] = useState<string | null>(null);` 줄을 지운다.
- `/api/models` 응답 처리에서 `setSelectedModel((prev) => prev ?? list[0]?.id ?? null);` 줄을 지운다.
- 전송 본문의 `model: selectedModel ?? undefined,` 줄을 지운다. 서버는 이제 비서의 모델만 쓴다(결정 2).
- `{models.length > 1 && ( <label ...> ... </label> )}` 블록을 다음으로 바꾼다:

```tsx
          {/* 비서의 모델(결정 2). 고를 수 없고 보여주기만 한다. 서버와 같은 규칙으로
              정한다 — 기관 허용 목록에 없으면 목록의 첫 번째(기본 모델)로 돈다. */}
          {models.length > 0 && selectedAgent && (
            <span className="text-xs text-slate-400" title={(models.find((m) => m.id === selectedAgent.model_id) ?? models[0]).note}>
              모델 {(models.find((m) => m.id === selectedAgent.model_id) ?? models[0]).label}
            </span>
          )}
```

- [ ] **Step 5: 한도 규약 검사를 실행기 구조에 맞춘다** — `tests/usage-limit.test.ts`의 `describe('토큰을 쓰는 라우트는 모두 한도를 확인한다', ...)` 블록 전체를 다음으로 바꾼다:

```typescript
describe('토큰을 쓰는 경로는 모두 한도를 확인한다', () => {
  /**
   * 예전에 `/api/qna`와 `/api/report`가 usage_logs에 토큰을 기록하면서
   * 한도는 확인하지 않았다. 예산을 소진한 기관도 그 경로로는 계속 쓸 수 있었다.
   *
   * 이제 모델은 AI 연결부(@/lib/llm)로만 부른다. 연결부를 쓰는 라우트와
   * 대화 실행기를 본다.
   */
  const routeFiles = execSync('find src/app/api -name "route.ts"', { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);

  const spenders = routeFiles.filter((f) => {
    const src = readFileSync(f, 'utf8');
    return src.includes("from '@/lib/llm'") && src.includes('usage');
  });

  it('대상 라우트를 실제로 찾는다', () => {
    // 요술봉(enhance-prompt)
    expect(spenders.length).toBeGreaterThan(0);
  });

  it('전부 checkTokenLimit을 거친다', () => {
    const missing = spenders.filter((f) => !readFileSync(f, 'utf8').includes('checkTokenLimit'));
    expect(missing, '토큰을 쓰는데 한도 검사가 없음').toEqual([]);
  });

  it('사용자를 함께 넘긴다', () => {
    const sources = [...spenders, 'src/lib/assistant/prepare.ts'];
    const bad = sources.filter((f) => {
      const src = readFileSync(f, 'utf8');
      const at = src.indexOf('checkTokenLimit(');
      if (at === -1) return true;
      return !src.slice(at, src.indexOf(')', at)).includes(',');
    });
    expect(bad, 'checkTokenLimit에 사용자를 안 넘김').toEqual([]);
  });

  it('대화는 실행기를 거친다', () => {
    // 실행기 밖에서 대화를 처리하면 한도·정책·과금 규약을 다시 지켜야 한다
    expect(readFileSync('src/app/api/chat/route.ts', 'utf8')).toContain('prepareTurn(');
  });
});
```
(파일 위쪽 import에 `execSync`가 없으면 `import { execSync } from 'child_process';`를 더한다.)

- [ ] **Step 6: 경로 목록 정리** — `tests/route-auth.test.ts`의 `EMPLOYEE_ROUTES`에서 `'/employee/stats',` `'/qna',` `'/report',` 세 줄을 지운다. `'/templates'`는 남긴다.

`scripts/db-check.mjs`의 `TOKEN_ACTIONS`를 다음으로 바꾼다:
```javascript
  // qna_search·generate_report는 S1-b에서 걷어낸 경로다. 과거 로그를 함께 보려고 남긴다.
  const TOKEN_ACTIONS = ['chat_message', 'conversation_title', 'prompt_enhance', 'qna_search', 'generate_report', 'document_ocr'];
```

- [ ] **Step 7: 전체 확인**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: 전부 PASS, tsc 오류 0건, 빌드 성공 (개발 서버를 멈추고 `.next`를 지운 뒤 빌드)

- [ ] **Step 8: Commit**

```bash
git add -A src tests scripts/db-check.mjs
git commit -m "refactor: Q&A·보고서 생성·claude.ts 걷어내기, 대화 화면은 비서 모델 표시

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 실측 · 배포

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 화면 실측 (preview)** — 개발 서버를 띄우고 직원 계정으로 확인한다(로그인은 사용자가 한다).
  1. 문서가 연결된 비서에 문서 내용을 묻는다 → 출처(SourceCitation)가 붙어 답한다
  2. 문서가 연결된 비서에 무관한 것을 묻는다 → "내부 자료에 근거가 없다"를 먼저 밝힌다
  3. 법령 커넥터가 켜진 비서에 법령을 묻는다 → `tool_start`·`tool_end` 표시 뒤 링크 출처와 함께 답한다
  4. 사진을 첨부해 묻는다 → 사진을 읽고 답한다
  5. 대화 화면 하단에 모델 선택이 아니라 '모델 Claude Sonnet 4.6'처럼 비서의 모델이 보인다
  6. 새로고침해도 대화가 남아 있다(메시지 저장)
  7. `read_network_requests`로 `/api/chat` 응답이 `text/event-stream`이고 이벤트 이름이 이전과 같은지 본다

- [ ] **Step 2: DB 실측**

```bash
npm run db:check
```
Expected: 과금 기록 규약 `cost_krw 누락 0건`, `model 누락 0건` (방금 대화가 `chat_message`·`conversation_title`로 잡힌다)

- [ ] **Step 3: `CLAUDE.md` 갱신**

`### 채팅 시 (/api/chat) — SSE 스트리밍` 절의 흐름도를 다음으로 바꾼다:
```markdown
/api/chat은 얇다. 일은 대화 실행기(src/lib/assistant/)가 한다.

질문 → prepareTurn: 권한(canUseAgent) → 한도 → 비서 조회 → 능력 결정(기관 범위)
     → 사진·금지어 → 대화·이력 20개 → 모델(비서 모델 ∩ 기관 허용) → 능력 prepare(문서 찾기)
→ streamTurn: 도구 루프(켜진 능력의 도구만) → 메시지 저장(판 번호) → 사용 기록(모델별) → 제목
```

`## 실제 스택`의 AI/LLM 줄을 `Claude API — AI 연결부 src/lib/llm/ (어댑터: anthropic.ts)`로, 디렉토리 구조의 `claude.ts` 줄을 `llm/ · assistant/ · capabilities/`로 바꾼다. `### Q&A 시 (/api/qna)` 절과 'RAG가 두 갈래인 이유' 문단은 지우고 "S1-b에서 걷어냈다. 부서 전체 검색은 S4(NODA)에서 다시 정한다"로 대신한다. API 구조 표의 직원 그룹에서 `/api/qna`, `/api/reports/*`, `/api/employee/stats`를 지운다.

모델·단가 절에 추가:
```markdown
**모델은 비서마다 정한다(`agents.model_id`, S1).** 대화 화면에서 고르지 않는다.
비서의 모델이 기관 허용 목록 밖이면 목록의 첫 번째로 돈다(`resolveModel`).
모델 호출은 `src/lib/llm/`의 `streamChat`·`complete`로만 한다 — `tests/llm-boundary.test.ts`가 본다.
```

- [ ] **Step 4: Commit · 배포 요청**

```bash
git add CLAUDE.md
git commit -m "docs: S1-b AI 연결부·대화 실행기 반영

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

사용자에게 푸시·배포를 요청한다. 마이그레이션은 없다.
