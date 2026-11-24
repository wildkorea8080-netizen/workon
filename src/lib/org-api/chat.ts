// src/lib/org-api/chat.ts
// 기관 API의 '비서에게 묻기'(0101, 2026-11-24) — 범위 chat. POST /api/v1/chat
//
// 기관 시스템(민원 창구·그룹웨어 봇·업무포털)이 이 기관의 공식·부서 비서에게 묻고 답을 받는다.
// 묻는 사람은 **키를 만든 기관 전체 관리자**다 — 그 사람의 세션 꼴로 대화 실행기(prepareTurn·streamTurn)를 화면과 같은 본문으로 태운다.
// 그래서 비서 사용 권한·기관/부서/개인 한도·모델 정책·금지어·개인정보 검사·문서 근거·숫자 확인·사용 기록·대화 저장이 화면 대화와 같다.
//
// - 대화는 그 관리자의 대화로 남는다 — 제목 앞 `[API] `, `conversations.metadata.org_api = { key_id, started_at }`. 화면 대화 목록에서 보이고 지울 수 있다.
// - 이어 묻기(`conversationId`)는 **같은 키로 같은 비서에게 시작한 대화만**(다른 키·화면에서 시작한 대화는 있는지도 알리지 않는 404).
// - 나만의 비서·지운 비서·다른 기관 비서는 404, 링크형·입력형 앱은 400(앱은 입력 항목이 있어 묻는 글 하나로 돌지 않는다).
// - 사진은 받지 않는다. 첨부 파일은 `/api/v1/chat/attachments`로 올려 확인한 뒤 `attachmentIds`로 붙인다(0105 — chat-attachments.ts). 문서를 만드는 도구가 만든 파일은 그 관리자의 결과물 화면에 남고 응답에는 이름만 싣는다.
// - 응답: 답 글·근거(번호·제목·위치·발췌)·도구 출처 주소·확인되지 않은 숫자. NODA를 못 부르면 503 `documents_unavailable`(skipDocuments로 문서 없이 다시).
// - 새 대화마다 보안 로그 `org_api_chat_started`(키·대화·비서 id만 — 질문 글 없음).
// - (2026-11-24) `stream: true`면 확인·준비를 마친 뒤 SSE로 글 조각을 흘려 보낸다(start → delta·tool … → done | error).
import type { Session } from 'next-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { prepareTurn } from '@/lib/assistant/prepare';
import { streamTurn } from '@/lib/assistant/stream';
import type { PrepareOutcome, PreparedTurn, SendEvent } from '@/lib/assistant/types';
import { AGENT_ACCESS_COLUMNS, type AgentAccessInfo } from '@/lib/agent-permissions';
import { logSecurityEvent } from '@/lib/security-log';
import { logSystem } from '@/lib/logger';
import { sourceLocationLabel, sourceTitleLabel, stripNodaPrefixes } from '@/components/chat/source-label';
import type { RetrievedChunk } from '@/lib/db';
import { parseChatAsk, writableAgent, type ChatAskInput } from './spec';
import type { OrgApiContext } from './keys';

type Out = { data: unknown } | { status: number; message: string; code?: string };

export const ORG_API_CHAT_AGENT_NOT_FOUND = '비서를 찾을 수 없습니다 — 이 기관의 공식·부서 비서 id인지 확인해 주세요(나만의 비서에는 물을 수 없습니다).';
export const ORG_API_CHAT_NOT_CONVERSATIONAL = '링크형 비서·입력형 앱에는 이 주소로 묻지 않습니다 — 대화형 비서 id를 적어 주세요.';
export const ORG_API_CHAT_CONVERSATION_NOT_FOUND = '이어 물을 대화를 찾을 수 없습니다 — 같은 키로 같은 비서에게 시작한 대화의 conversationId만 이을 수 있습니다.';
export const ORG_API_CHAT_READ_FAILED = '대화를 지금 읽지 못했습니다. 잠시 뒤 다시 호출해 주세요.';
export const ORG_API_CHAT_UNFINISHED = '정해진 시간 안에 답을 마치지 못했습니다. 질문을 나누거나 잠시 뒤 다시 호출해 주세요.';
export const ORG_API_CHAT_TITLE_PREFIX = '[API] ';
/** 새 모델 호출을 시작하지 않을 마감 — 라우트 maxDuration(300초) 안에서 저장까지 마치게 */
export const ORG_API_CHAT_BUDGET_MS = 240_000;

type DoneData = { number_check: { unverified: string[]; rechecked?: { value: string; source: string }[] } | null; message_id?: string };

export type ChatAgentRow = AgentAccessInfo & { agent_type: string | null; app_definition: unknown };

export interface OrgApiChatIo {
  loadAgent(agentId: string): Promise<ChatAgentRow | null>;
  /** 이 사람·이 비서의 대화가 이 키로 시작한 것인가 — 없으면 null, 있으면 metadata.org_api.key_id(없으면 '') */
  conversationKey(conversationId: string, userId: string, agentId: string): Promise<string | null>;
  prepare(session: Session, body: Record<string, unknown>): Promise<PrepareOutcome>;
  stream(turn: PreparedTurn, send: SendEvent, options: { deadlineAt: number }): Promise<void>;
  /** 새 대화에 키 표시를 남긴다(이어 묻기의 근거) — 실패하면 던진다 */
  markConversation(conversationId: string, keyId: string, startedAt: string): Promise<void>;
  /** 제목 앞 `[API] ` — 표시일 뿐이라 실패해도 답은 그대로 */
  retitle(conversationId: string): Promise<void>;
  now(): number;
}

export type OrgApiChatSource = {
  n: number | null; title: string; location: string; common: boolean; effectiveFrom: string | null; excerpt: string;
};

function sourceOf(c: RetrievedChunk): OrgApiChatSource {
  return {
    n: typeof c.n === 'number' ? c.n : null,
    title: sourceTitleLabel(c),
    location: sourceLocationLabel(c),
    common: c.scope === 'common',
    effectiveFrom: c.scope === 'common' ? null : (c.effectiveFrom ?? null),
    excerpt: typeof c.text === 'string' ? stripNodaPrefixes(c.text) : '',
  };
}

type Prepared = { turn: PreparedTurn; ask: ChatAskInput; continuable: boolean };

/** 스트리밍(2026-11-24)으로 밖에 내보내는 사건 — 답 글 조각·부른 도구 이름 */
export type OrgApiChatProgress = { event: 'delta'; text: string } | { event: 'tool'; name: string };

/** 묻기 전 확인과 대화 준비 — 실패면 그 응답, 아니면 준비된 턴. 스트리밍이든 아니든 여기까지는 같다(실패는 JSON으로 답함) */
async function prepareAsk(ctx: OrgApiContext, ask: ChatAskInput, io: OrgApiChatIo): Promise<{ fail: Out } | Prepared> {
  const agent = await io.loadAgent(ask.agentId);
  if (!writableAgent(agent, ctx.organizationId) || !agent.is_active) return { fail: { status: 404, message: ORG_API_CHAT_AGENT_NOT_FOUND } };
  if (agent.agent_type === 'link' || agent.app_definition != null) return { fail: { status: 400, message: ORG_API_CHAT_NOT_CONVERSATIONAL } };

  if (ask.conversationId) {
    let key: string | null;
    try {
      key = await io.conversationKey(ask.conversationId, ctx.creatorId, ask.agentId);
    } catch {
      return { fail: { status: 503, message: ORG_API_CHAT_READ_FAILED } };
    }
    if (key !== ctx.keyId) return { fail: { status: 404, message: ORG_API_CHAT_CONVERSATION_NOT_FOUND } };
  }

  // handleOrgApiCall이 '최상위 부서의 활성 ADMIN'임을 확인한 뒤에만 여기 온다
  const session = {
    user: { id: ctx.creatorId, role: 'ADMIN', departmentId: ctx.creatorDepartmentId },
    expires: new Date(io.now() + 5 * 60_000).toISOString(),
  } as unknown as Session;
  const prepared = await io.prepare(session, {
    agent_id: ask.agentId,
    message: ask.question,
    ...(ask.conversationId ? { conversation_id: ask.conversationId } : {}),
    ...(ask.skipDocuments ? { skip_documents: true } : {}),
    ...(ask.tags !== undefined ? { doc_tags: ask.tags } : {}),
    // 첨부(0105) — 파일 받아 읽기가 꺼진 비서·남의/보낸/읽지 못한 첨부는 실행기가 400으로 거절한다
    ...(ask.attachmentIds.length ? { attachment_ids: ask.attachmentIds } : {}),
  });
  if (!prepared.ok) {
    const code = typeof prepared.details?.code === 'string' ? prepared.details.code : undefined;
    return { fail: { status: prepared.status, message: prepared.message, ...(code ? { code } : {}) } };
  }
  const turn = prepared.turn;
  const conversationId = turn.conversationId;

  // 새 대화면 답하기 전에 키 표시를 남긴다 — 못 남기면 답은 하되 이어 묻기는 막힌다(continuable: false)
  let continuable = true;
  if (turn.isNewConversation) {
    try {
      await io.markConversation(conversationId, ctx.keyId, new Date(io.now()).toISOString());
    } catch (error) {
      continuable = false;
      await logSystem({
        level: 'warning', category: 'api', message: '기관 API 대화에 키 표시를 남기지 못했습니다(이어 묻기 막힘)',
        details: { key_id: ctx.keyId, conversation_id: conversationId, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' },
        orgId: ctx.organizationId,
      });
    }
    await logSecurityEvent(ctx.creatorDepartmentId, ctx.creatorId, 'org_api_chat_started',
      { key_id: ctx.keyId, conversation_id: conversationId, agent_id: ask.agentId, ...(ask.stream ? { stream: true } : {}) }, 'low');
  }
  return { turn, ask, continuable };
}

/** 답을 만든다 — 끝까지 모아 응답 꼴로. `onProgress`가 있으면 글 조각·도구 이름을 그때그때 넘긴다(스트리밍) */
async function runAsk(p: Prepared, io: OrgApiChatIo, onProgress?: (e: OrgApiChatProgress) => void): Promise<Out> {
  const { turn, ask, continuable } = p;
  const conversationId = turn.conversationId;
  let answer = '';
  let chunks: RetrievedChunk[] = [];
  const links = new Map<string, { title: string; url: string }>();
  const files: string[] = [];
  let error: string | null = null;
  const end: { done: DoneData | null } = { done: null };
  try {
    await io.stream(turn, (event) => {
      if (event.event === 'meta') chunks = event.data.chunks ?? [];
      else if (event.event === 'delta') {
        answer += event.data.text;
        if (event.data.text) onProgress?.({ event: 'delta', text: event.data.text });
      } else if (event.event === 'tool_start') {
        if (typeof event.data.name === 'string') onProgress?.({ event: 'tool', name: event.data.name });
      } else if (event.event === 'tool_end') {
        for (const s of event.data.sources ?? []) if (s?.url && !links.has(s.url)) links.set(s.url, { title: s.title, url: s.url });
        for (const f of event.data.files ?? []) if (f?.file_name) files.push(f.file_name);
      } else if (event.event === 'error') error = error ?? event.data.message;
      else if (event.event === 'done') end.done = event.data;
    }, { deadlineAt: io.now() + ORG_API_CHAT_BUDGET_MS });
  } catch (failure) {
    error = error ?? (failure instanceof Error ? '답을 만들다 오류가 났습니다. 잠시 뒤 다시 호출해 주세요.' : '알 수 없는 오류');
  }
  // 실행기의 오류 글은 이미 한국어 안내다(원문은 운영 기록에) — 대화는 남았을 수 있다
  if (error) return { status: 502, message: error };
  const finished = end.done;
  if (!finished) return { status: 504, message: ORG_API_CHAT_UNFINISHED };

  try { await io.retitle(conversationId); } catch { /* 제목은 표시일 뿐 */ }

  const numberCheck = finished.number_check;
  return {
    data: {
      conversationId,
      messageId: finished.message_id ?? null,
      continuable,
      answer,
      sources: chunks.map(sourceOf),
      links: [...links.values()],
      files,
      numberCheck: { unverified: numberCheck?.unverified ?? [], rechecked: numberCheck?.rechecked ?? [] },
      documentsSkipped: ask.skipDocuments,
    },
  };
}

/** SSE 한 사건 — `event: 이름` + `data: JSON`(JSON은 줄바꿈 없이 한 줄) */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * 스트리밍 답(2026-11-24, `stream: true`) — 확인·준비가 끝난 뒤에만 흐름을 연다(그 전 실패는 JSON).
 * 사건: `start { conversationId, continuable }` → `delta { text }`·`tool { name }` … → `done { …묻기 응답과 같은 data }` 또는
 * `error { status, message, code? }`. 받는 쪽이 끊어도 답은 끝까지 만들어 대화에 저장한다(화면 대화와 같다)
 */
function streamAsk(p: Prepared, io: OrgApiChatIo): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let closed = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(sseFrame(event, data))); } catch { closed = true; }
      };
      send('start', { conversationId: p.turn.conversationId, continuable: p.continuable });
      let out: Out;
      try {
        out = await runAsk(p, io, (e) => (e.event === 'delta' ? send('delta', { text: e.text }) : send('tool', { name: e.name })));
      } catch {
        out = { status: 500, message: '답을 만들지 못했습니다. 잠시 뒤 다시 호출해 주세요.' };
      }
      if ('data' in out) send('done', out.data);
      else send('error', { status: out.status, message: out.message, ...(out.code ? { code: out.code } : {}) });
      if (!closed) {
        closed = true;
        try { controller.close(); } catch { /* 이미 닫힘 */ }
      }
    },
    cancel() { closed = true; },
  });
}

/** 묻기 — `stream: true`면 확인을 마친 뒤 SSE 흐름(`{ stream }`), 아니면 끝까지 모은 응답 */
export async function askOrgApiChat(ctx: OrgApiContext, raw: unknown, io: OrgApiChatIo = defaultOrgApiChatIo()): Promise<Out | { stream: ReadableStream<Uint8Array> }> {
  const parsed = parseChatAsk(raw);
  if (!parsed.ok) return { status: 400, message: parsed.message };
  const p = await prepareAsk(ctx, parsed.value, io);
  if ('fail' in p) return p.fail;
  return p.ask.stream ? { stream: streamAsk(p, io) } : runAsk(p, io);
}

export function defaultOrgApiChatIo(): OrgApiChatIo {
  return {
    async loadAgent(agentId) {
      const { data, error } = await supabaseAdmin.from('agents').select(`${AGENT_ACCESS_COLUMNS}, agent_type, app_definition`).eq('id', agentId).maybeSingle();
      if (error) throw new Error(`agents: ${error.message}`);
      return (data as ChatAgentRow | null) ?? null;
    },
    async conversationKey(conversationId, userId, agentId) {
      const { data, error } = await supabaseAdmin.from('conversations').select('id, metadata')
        .eq('id', conversationId).eq('user_id', userId).eq('agent_id', agentId).maybeSingle();
      if (error) throw new Error(`conversations: ${error.message}`);
      if (!data) return null;
      const meta = (data as { metadata: unknown }).metadata as { org_api?: { key_id?: unknown } } | null;
      return typeof meta?.org_api?.key_id === 'string' ? meta.org_api.key_id : '';
    },
    prepare: prepareTurn,
    stream: (turn, send, options) => streamTurn(turn, send, { deadlineAt: options.deadlineAt }),
    async markConversation(conversationId, keyId, startedAt) {
      const { data, error } = await supabaseAdmin.from('conversations').select('metadata').eq('id', conversationId).maybeSingle();
      if (error || !data) throw new Error(`conversations(read): ${error?.message ?? 'missing'}`);
      const metadata = { ...((data as { metadata: Record<string, unknown> | null }).metadata ?? {}), org_api: { key_id: keyId, started_at: startedAt } };
      const { error: writeError } = await supabaseAdmin.from('conversations').update({ metadata }).eq('id', conversationId);
      if (writeError) throw new Error(`conversations(write): ${writeError.message}`);
    },
    async retitle(conversationId) {
      const { data, error } = await supabaseAdmin.from('conversations').select('title').eq('id', conversationId).maybeSingle();
      if (error || !data) return;
      const title: string = (data as { title: string | null }).title ?? '';
      if (title.startsWith(ORG_API_CHAT_TITLE_PREFIX)) return;
      const { error: writeError } = await supabaseAdmin.from('conversations').update({ title: `${ORG_API_CHAT_TITLE_PREFIX}${title || '대화'}`.slice(0, 200) }).eq('id', conversationId);
      if (writeError) throw new Error(`conversations(title): ${writeError.message}`);
    },
    now: () => Date.now(),
  };
}
