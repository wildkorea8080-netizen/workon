// src/lib/llm/anthropic.ts
import { ANTHROPIC_API_KEY } from '@/lib/config';
import type { LlmAdapter, LlmRequest, LlmStreamEvent, LlmUsage, LlmCompletion, LlmMessage, LlmWebSource } from './types';
import { getModel } from '@/lib/models';
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
    messages: req.messages.map(toAnthropicMessage),
  };
  if (stream) body.stream = true;
  if (req.system) body.system = req.system;
  const tools: Record<string, unknown>[] = (req.tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
  const webSearch = webSearchToolFor(req);
  if (webSearch) tools.push(webSearch);
  if (tools.length) {
    body.tools = tools;
    if (req.toolChoice) body.tool_choice = { type: req.toolChoice };
  }
  return body;
}

/** 업체 블록 그대로(provider_raw)는 그 블록으로 — 서버 도구를 쓴 응답을 이어 부를 때 바꾸지 않고 돌려준다 */
function toAnthropicMessage(m: LlmMessage): Record<string, unknown> {
  if (typeof m.content === 'string') return m as unknown as Record<string, unknown>;
  return { role: m.role, content: m.content.map((b) => (b.type === 'provider_raw' ? b.block : b)) };
}

/** 웹 검색 도구 정의(2026-11-26) — 모델이 받는 꼴(`webSearchTool`)이 없으면 싣지 않는다 */
export function webSearchToolFor(req: Pick<LlmRequest, 'model' | 'serverTools'>): Record<string, unknown> | null {
  const ws = req.serverTools?.webSearch;
  const type = getModel(req.model).webSearchTool;
  if (!ws || !type) return null;
  const maxUses = Math.max(1, Math.min(10, Math.floor(ws.maxUses)));
  return {
    type,
    name: 'web_search',
    max_uses: maxUses,
    ...(ws.allowedDomains?.length ? { allowed_domains: ws.allowedDomains } : {}),
  };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const isHttp = (u: string) => /^https?:\/\//i.test(u);
/** 웹 검색 결과 블록 → 찾은 곳(제목·주소만 — 암호화된 내용은 화면·기록에 싣지 않는다) */
function webResultSources(content: unknown): LlmWebSource[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object' && (r as { type?: unknown }).type === 'web_search_result')
    .map((r) => ({ url: str(r.url), title: str(r.title) || str(r.url) }))
    .filter((s) => isHttp(s.url));
}
/** 인용 하나 → 출처(웹 검색 결과 인용만) */
function citationSource(c: unknown): LlmWebSource | null {
  if (!c || typeof c !== 'object') return null;
  const o = c as Record<string, unknown>;
  if (o.type !== 'web_search_result_location' || !isHttp(str(o.url))) return null;
  return { url: str(o.url), title: str(o.title) || str(o.url), ...(str(o.cited_text) ? { citedText: str(o.cited_text) } : {}) };
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
  // 응답 블록을 그대로 모은다(2026-11-26) — 서버 도구를 쓴 응답을 이어 부를 때 바꾸지 않고 돌려준다(검색 결과·인용·생각 블록)
  const blocks = new Map<number, Record<string, unknown>>();
  const blockJson = new Map<number, string>();
  let usedServerTool = false;
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
          case 'content_block_start': {
            const block = parsed.content_block && typeof parsed.content_block === 'object' ? { ...parsed.content_block } as Record<string, unknown> : null;
            if (block) blocks.set(parsed.index, block);
            if (block?.type === 'tool_use') {
              pendingTools.set(parsed.index, { id: parsed.content_block.id, name: parsed.content_block.name, json: '' });
            } else if (block && typeof block.type === 'string' && block.type !== 'text' && block.type !== 'thinking' && block.type !== 'redacted_thinking') {
              // server_tool_use·web_search_tool_result·(동적 거르기의) 코드 실행 블록 — 이 응답은 그대로 돌려줘야 한다
              usedServerTool = true;
              if (block.type === 'web_search_tool_result') {
                const content = block.content;
                const errorCode = content && typeof content === 'object' && !Array.isArray(content) ? str((content as Record<string, unknown>).error_code) : '';
                yield { type: 'server_tool_result', toolUseId: str(block.tool_use_id), name: 'web_search', ok: !errorCode, sources: webResultSources(content), ...(errorCode ? { errorCode } : {}) };
              }
            }
            break;
          }
          case 'content_block_delta': {
            const block = blocks.get(parsed.index);
            if (parsed.delta?.type === 'text_delta') {
              if (block) block.text = str(block.text) + (parsed.delta.text ?? '');
              yield { type: 'text', text: parsed.delta.text as string };
            } else if (parsed.delta?.type === 'input_json_delta') {
              const pending = pendingTools.get(parsed.index);
              if (pending) pending.json += parsed.delta.partial_json ?? '';
              else blockJson.set(parsed.index, (blockJson.get(parsed.index) ?? '') + (parsed.delta.partial_json ?? ''));
            } else if (parsed.delta?.type === 'citations_delta') {
              if (block) block.citations = [...(Array.isArray(block.citations) ? block.citations : []), parsed.delta.citation];
              const source = citationSource(parsed.delta.citation);
              if (source) yield { type: 'citation', source };
            } else if (parsed.delta?.type === 'thinking_delta') {
              if (block) block.thinking = str(block.thinking) + (parsed.delta.thinking ?? '');
            } else if (parsed.delta?.type === 'signature_delta') {
              if (block) block.signature = parsed.delta.signature;
            }
            break;
          }
          case 'content_block_stop': {
            const raw = blocks.get(parsed.index);
            const json = blockJson.get(parsed.index);
            if (raw && json !== undefined) {
              blockJson.delete(parsed.index);
              try { raw.input = json ? JSON.parse(json) : {}; } catch { /* 깨진 입력 — 받은 그대로(빈 입력)로 둔다 */ }
            }
            if (raw?.type === 'server_tool_use') {
              yield { type: 'server_tool_use', id: str(raw.id), name: str(raw.name), input: raw.input && typeof raw.input === 'object' ? raw.input as Record<string, unknown> : {} };
            }
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
              if (raw) raw.input = input;
              yield { type: 'tool_use', id: pending.id, name: pending.name, input };
            }
            break;
          }
          case 'message_delta': {
            usage.output_tokens = parsed.usage?.output_tokens ?? usage.output_tokens;
            const searches = Number(parsed.usage?.server_tool_use?.web_search_requests);
            if (Number.isFinite(searches) && searches > 0) usage.web_search_requests = searches;
            stopReason = parsed.delta?.stop_reason ?? stopReason;
            break;
          }
          case 'error':
            throw new LlmApiError(null, parsed.error?.message ?? '알 수 없는 오류', parsed.error?.type);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const content = usedServerTool ? [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b) : undefined;
  yield { type: 'done', usage, stopReason, ...(content ? { content } : {}) };
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
