import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-24 — 기관 API '비서에게 묻기'의 스트리밍 답(`stream: true`).
 * 확인·준비(키·범위·비서·이어 묻기·한도·금지어)를 마친 뒤에만 SSE 흐름을 열고, 글 조각을 그때그때 보낸다.
 * 끝은 묻기 응답과 같은 data의 `done` 또는 `error`. 그 전 실패는 지금처럼 JSON.
 */

vi.mock('@/lib/config', () => ({ SUPABASE_DOCUMENTS_BUCKET: 'documents' }));
vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/assistant/prepare', () => ({ prepareTurn: vi.fn() }));
vi.mock('@/lib/assistant/stream', () => ({ streamTurn: vi.fn() }));
const mocks = vi.hoisted(() => ({ logSecurityEvent: vi.fn(async () => true), logSystem: vi.fn(async () => {}) }));
vi.mock('@/lib/security-log', () => ({ logSecurityEvent: mocks.logSecurityEvent }));
vi.mock('@/lib/logger', () => ({ logSystem: mocks.logSystem }));

import { askOrgApiChat, sseFrame, type ChatAgentRow, type OrgApiChatIo } from '@/lib/org-api/chat';
import { parseChatAsk } from '@/lib/org-api/spec';
import { generateOrgApiToken, handleOrgApiCall, hashOrgApiToken, type OrgApiDeps } from '@/lib/org-api/keys';
import type { SendEvent } from '@/lib/assistant/types';

const ORG = 'org';
const AG = '11111111-1111-4111-8111-111111111111';
const CONV = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-11-24T03:00:00Z');
const ctx = { keyId: 'k1', organizationId: ORG, departmentIds: ['top'], creatorId: 'u-admin', creatorDepartmentId: 'top' };
const agent = (over: Partial<ChatAgentRow> = {}): ChatAgentRow => ({
  id: AG, tier: 'official', department_id: 'top', organization_id: ORG, visibility: 'organization', owner_id: null, created_by: 'u-admin',
  is_active: true, is_published: true, deleted_at: null, approval_status: null, version: 3, approval_version: null,
  agent_type: 'chat', app_definition: null, ...over,
} as ChatAgentRow);

type Script = SendEvent extends (e: infer E) => unknown ? E[] : never;
const script: Script = [
  { event: 'meta', data: { conversation_id: CONV, chunks: [{ documentId: 'd1', documentTitle: '복무규정.pdf', chunkIndex: 0, n: 1, text: '연가 21일', similarity: 0.9, page: 12 }] } },
  { event: 'tool_start', data: { name: 'law_search', input: { query: '연가' } } },
  { event: 'tool_end', data: { name: 'law_search', ok: true, sources: [{ title: '복무규정', url: 'https://law.go.kr/a' }], files: [] } },
  { event: 'delta', data: { text: '연가는\n21일' } },
  { event: 'delta', data: { text: '' } },
  { event: 'delta', data: { text: '입니다 [1].' } },
  { event: 'done', data: { usage: { input_tokens: 1, output_tokens: 1, model: 'claude-sonnet-4-6' } as never, title: 't', number_check: null, message_id: 'm1' } },
];

function fakeIo(over: Partial<OrgApiChatIo> & { script?: Script } = {}): OrgApiChatIo {
  return {
    loadAgent: async () => agent(),
    conversationKey: async () => 'k1',
    prepare: async (_s, body) => ({ ok: true, turn: { conversationId: CONV, isNewConversation: !body.conversation_id } as never }),
    stream: async (_turn, send) => { for (const e of over.script ?? script) send(e); },
    markConversation: async () => {},
    retitle: async () => {},
    now: () => NOW,
    ...over,
  };
}

/** SSE 흐름을 끝까지 읽어 사건 목록으로 */
async function readEvents(stream: ReadableStream<Uint8Array>): Promise<{ event: string; data: unknown }[]> {
  const text = await new Response(stream).text();
  return text.split('\n\n').filter(Boolean).map((block) => {
    const lines = block.split('\n');
    expect(lines).toHaveLength(2); // 사건 하나는 두 줄(event·data) — 글 속 줄바꿈이 흐름을 깨지 않는다
    return { event: lines[0].replace(/^event: /, ''), data: JSON.parse(lines[1].replace(/^data: /, '')) };
  });
}

beforeEach(() => { vi.clearAllMocks(); });

describe('요청', () => {
  it('stream은 참거짓만 — 글자 true는 400', () => {
    expect(parseChatAsk({ agentId: AG, question: '연가?', stream: 'true' })).toMatchObject({ ok: false });
    expect(parseChatAsk({ agentId: AG, question: '연가?', stream: true })).toMatchObject({ ok: true, value: { stream: true } });
    expect(parseChatAsk({ agentId: AG, question: '연가?' })).toMatchObject({ ok: true, value: { stream: false } });
  });
});

describe('스트리밍 답', () => {
  it('start → tool → delta … → done(묻기 응답과 같은 data)', async () => {
    const out = await askOrgApiChat(ctx, { agentId: AG, question: '연가?', stream: true }, fakeIo());
    expect('stream' in out).toBe(true);
    const events = await readEvents((out as { stream: ReadableStream<Uint8Array> }).stream);
    expect(events.map((e) => e.event)).toEqual(['start', 'tool', 'delta', 'delta', 'done']);
    expect(events[0].data).toEqual({ conversationId: CONV, continuable: true });
    expect(events[1].data).toEqual({ name: 'law_search' });
    expect(events[2].data).toEqual({ text: '연가는\n21일' });
    // 빈 조각은 보내지 않는다
    const plain = await askOrgApiChat(ctx, { agentId: AG, question: '연가?' }, fakeIo());
    expect(events[4].data).toEqual((plain as { data: unknown }).data);
    expect((events[4].data as { answer: string }).answer).toBe('연가는\n21일입니다 [1].');
  });

  it('확인·준비 실패는 흐름을 열지 않고 JSON 오류로', async () => {
    expect(await askOrgApiChat(ctx, { agentId: AG, question: '연가?', stream: true }, fakeIo({ loadAgent: async () => agent({ tier: 'personal' }) }))).toMatchObject({ status: 404 });
    expect(await askOrgApiChat(ctx, { agentId: AG, question: '연가?', stream: true },
      fakeIo({ prepare: async () => ({ ok: false, status: 429, message: '이번 달 한도' }) as never }))).toEqual({ status: 429, message: '이번 달 한도' });
    expect(await askOrgApiChat(ctx, { agentId: AG, question: '연가?', stream: true, conversationId: CONV }, fakeIo({ conversationKey: async () => 'other' }))).toMatchObject({ status: 404 });
  });

  it('답을 만들다 실패하면 error 사건(502), 마치지 못하면 504 — 그 앞의 글 조각은 이미 갔다', async () => {
    const failing = await askOrgApiChat(ctx, { agentId: AG, question: '연가?', stream: true },
      fakeIo({ script: [{ event: 'delta', data: { text: '연가는' } }, { event: 'error', data: { message: 'AI 서비스가 잠시 바쁩니다' } }] }));
    const ev = await readEvents((failing as { stream: ReadableStream<Uint8Array> }).stream);
    expect(ev.map((e) => e.event)).toEqual(['start', 'delta', 'error']);
    expect(ev[2].data).toEqual({ status: 502, message: 'AI 서비스가 잠시 바쁩니다' });
    const unfinished = await askOrgApiChat(ctx, { agentId: AG, question: '연가?', stream: true }, fakeIo({ script: [{ event: 'delta', data: { text: '연' } }] }));
    const ev2 = await readEvents((unfinished as { stream: ReadableStream<Uint8Array> }).stream);
    expect(ev2.at(-1)).toMatchObject({ event: 'error', data: { status: 504 } });
    const thrown = await askOrgApiChat(ctx, { agentId: AG, question: '연가?', stream: true }, fakeIo({ stream: async () => { throw new Error('boom'); } }));
    const ev3 = await readEvents((thrown as { stream: ReadableStream<Uint8Array> }).stream);
    expect(ev3.at(-1)).toMatchObject({ event: 'error', data: { status: 502 } });
    expect(JSON.stringify(ev3)).not.toContain('boom');
  });

  it('키 표시를 못 남기면 start에 continuable: false, 보안 로그에 stream 표시', async () => {
    const out = await askOrgApiChat(ctx, { agentId: AG, question: '연가?', stream: true }, fakeIo({ markConversation: async () => { throw new Error('db'); } }));
    const ev = await readEvents((out as { stream: ReadableStream<Uint8Array> }).stream);
    expect(ev[0].data).toEqual({ conversationId: CONV, continuable: false });
    expect(mocks.logSecurityEvent).toHaveBeenCalledWith('top', 'u-admin', 'org_api_chat_started', { key_id: 'k1', conversation_id: CONV, agent_id: AG, stream: true }, 'low');
  });

  it('받는 쪽이 끊어도 답은 끝까지 만든다', async () => {
    let finished = false;
    const out = await askOrgApiChat(ctx, { agentId: AG, question: '연가?', stream: true }, fakeIo({
      stream: async (_t, send) => { for (const e of script) { send(e); await new Promise((r) => setTimeout(r, 1)); } finished = true; },
    }));
    const reader = (out as { stream: ReadableStream<Uint8Array> }).stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(finished).toBe(false);
    for (let i = 0; i < 100 && !finished; i++) await new Promise((r) => setTimeout(r, 20));
    expect(finished).toBe(true);
  });

  it('SSE 한 사건은 두 줄 — 글 속 줄바꿈은 JSON이 막는다', () => {
    expect(sseFrame('delta', { text: 'a\nb' })).toBe('event: delta\ndata: {"text":"a\\nb"}\n\n');
  });
});

describe('호출 확인·라우트', () => {
  const token = generateOrgApiToken().token;
  const recorded: number[] = [];
  const deps = (scopes: string[]): OrgApiDeps => ({
    claim: async (hash) => (hash === hashOrgApiToken(token) ? { ok: true as const, key: { id: 'k1', organization_id: ORG, created_by: 'u-admin', scopes } } : { ok: false as const, reason: 'invalid' as const }),
    loadCreator: async () => ({ id: 'u-admin', role: 'ADMIN', is_active: true, deleted_at: null, department_id: 'top' }),
    loadDepartment: async () => ({ organization_id: ORG, parent_id: null }),
    allowedIps: async () => null, orgStatus: async () => 'active',
    managedDepartmentIds: async () => ['top'], recordCall: async (_k, _o, _e, status) => { recorded.push(status); }, now: () => NOW,
  });
  it('흐름은 200으로 기록하고 몸 대신 흐름을 돌려준다, 범위가 없으면 흐름을 열지 않는다', async () => {
    const stream = new ReadableStream<Uint8Array>();
    const res = await handleOrgApiCall(deps(['chat']), { authorization: `Bearer ${token}`, ip: null }, 'chat', async () => ({ stream }));
    expect(res.status).toBe(200);
    expect(res.stream).toBe(stream);
    expect(recorded.at(-1)).toBe(200);
    const run = vi.fn(async () => ({ stream }));
    expect((await handleOrgApiCall(deps(['usage']), { authorization: `Bearer ${token}`, ip: null }, 'chat', run)).stream).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });
  it('라우트는 흐름이면 text/event-stream, 아니면 JSON', () => {
    const route = readFileSync('src/app/api/v1/chat/route.ts', 'utf8');
    expect(route).toContain("'Content-Type': 'text/event-stream; charset=utf-8'");
    expect(route).toContain('if (res.stream)');
    expect(route).toContain('NextResponse.json(res.body');
  });
});
