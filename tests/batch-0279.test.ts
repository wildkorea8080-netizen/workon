import { readFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * 2026-11-24 — 기관 API의 '비서에게 묻기'(0101, 범위 chat, POST /api/v1/chat).
 * 기관 시스템이 공식·부서 비서에게 묻고 답·근거·확인되지 않은 숫자를 받는다. 묻는 사람은 키를 만든 기관 전체 관리자 —
 * 대화 실행기를 화면과 같은 본문으로 태우고, 대화는 그 사람의 대화([API] 제목·metadata.org_api)로 남는다.
 * 이어 묻기는 같은 키로 시작한 대화만, 나만의 비서·링크형·입력형 앱은 거절.
 */

vi.mock('@/lib/config', () => ({ SUPABASE_DOCUMENTS_BUCKET: 'documents' }));
vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/assistant/prepare', () => ({ prepareTurn: vi.fn() }));
vi.mock('@/lib/assistant/stream', () => ({ streamTurn: vi.fn() }));
const mocks = vi.hoisted(() => ({ logSecurityEvent: vi.fn(async () => true), logSystem: vi.fn(async () => {}) }));
vi.mock('@/lib/security-log', () => ({ logSecurityEvent: mocks.logSecurityEvent }));
vi.mock('@/lib/logger', () => ({ logSystem: mocks.logSystem }));

import {
  askOrgApiChat, ORG_API_CHAT_AGENT_NOT_FOUND, ORG_API_CHAT_CONVERSATION_NOT_FOUND, ORG_API_CHAT_NOT_CONVERSATIONAL, ORG_API_CHAT_UNFINISHED,
  ORG_API_CHAT_BUDGET_MS, type ChatAgentRow, type OrgApiChatIo,
} from '@/lib/org-api/chat';
import { ORG_API_CHAT_MAX_CHARS, ORG_API_CONTENT_SCOPES, ORG_API_ENDPOINTS, ORG_API_SCOPES, parseChatAsk, parseCreateKey } from '@/lib/org-api/spec';
import { generateOrgApiToken, handleOrgApiCall, hashOrgApiToken, type OrgApiDeps } from '@/lib/org-api/keys';
import type { SendEvent } from '@/lib/assistant/types';

const ORG = 'org';
const AG = '11111111-1111-4111-8111-111111111111';
const CONV = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-11-24T03:00:00Z');
const ctx = { keyId: 'k1', organizationId: ORG, departmentIds: ['top', 'child'], creatorId: 'u-admin', creatorDepartmentId: 'top' };
const agent = (over: Partial<ChatAgentRow> = {}): ChatAgentRow => ({
  id: AG, tier: 'official', department_id: 'top', organization_id: ORG, visibility: 'organization', owner_id: null, created_by: 'u-admin',
  is_active: true, is_published: true, deleted_at: null, approval_status: null, version: 3, approval_version: null,
  agent_type: 'chat', app_definition: null, ...over,
} as ChatAgentRow);

type StreamScript = SendEvent extends (e: infer E) => unknown ? E[] : never;
const goodStream: StreamScript = [
  { event: 'meta', data: { conversation_id: CONV, chunks: [
    { documentId: 'd1', documentTitle: '0b8f1c2e-0000-4000-8000-000000000000__복무규정.pdf', chunkIndex: 0, n: 1, text: '연가는 0b8f1c2e-0000-4000-8000-000000000000__ 21일', similarity: 0.9, page: 12, section: '제3장', effectiveFrom: '2026-01-01' },
    { documentId: 'c1', documentTitle: '예산편성기준', chunkIndex: 1, n: 2, text: '기준', similarity: 0.85, scope: 'common', editionYear: 2026 },
  ] } },
  { event: 'delta', data: { text: '연가는 21일입니다' } },
  { event: 'tool_end', data: { name: 'law_search', ok: true, sources: [{ title: '국가공무원 복무규정', url: 'https://law.go.kr/a' }, { title: '중복', url: 'https://law.go.kr/a' }], files: [{ id: 'f', file_name: '답변.hwpx', size_bytes: 3 }] } },
  { event: 'delta', data: { text: ' [1].' } },
  { event: 'done', data: { usage: { input_tokens: 1, output_tokens: 1, model: 'claude-sonnet-4-6' } as never, title: 't', number_check: { unverified: ['37'] }, message_id: 'm1' } },
];

function io(over: Partial<OrgApiChatIo> & { script?: StreamScript; prepareOk?: boolean } = {}) {
  const calls = { prepare: [] as Record<string, unknown>[], session: [] as unknown[], marked: [] as unknown[], retitled: [] as string[], deadline: [] as number[] };
  const value: OrgApiChatIo = {
    loadAgent: async () => agent(),
    conversationKey: async () => 'k1',
    prepare: async (session, body) => {
      calls.session.push(session); calls.prepare.push(body);
      return { ok: true, turn: { conversationId: CONV, isNewConversation: !body.conversation_id } as never };
    },
    stream: async (_turn, send, options) => { calls.deadline.push(options.deadlineAt); for (const e of over.script ?? goodStream) send(e); },
    markConversation: async (...args) => { calls.marked.push(args); },
    retitle: async (id) => { calls.retitled.push(id); },
    now: () => NOW,
    ...over,
  };
  return { value, calls };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('요청 검사', () => {
  it('agentId·question은 필수, 글 상한, conversationId는 uuid, skipDocuments는 참거짓만', () => {
    expect(parseChatAsk(null)).toMatchObject({ ok: false });
    expect(parseChatAsk({ agentId: 'x', question: '연가?' })).toMatchObject({ ok: false });
    expect(parseChatAsk({ agentId: AG, question: '   ' })).toMatchObject({ ok: false });
    expect(parseChatAsk({ agentId: AG, question: '가'.repeat(ORG_API_CHAT_MAX_CHARS + 1) })).toMatchObject({ ok: false });
    expect(parseChatAsk({ agentId: AG, question: '연가?', conversationId: 'abc' })).toMatchObject({ ok: false });
    expect(parseChatAsk({ agentId: AG, question: '연가?', skipDocuments: 'true' })).toMatchObject({ ok: false });
    expect(parseChatAsk({ agentId: AG.toUpperCase(), question: ' 연가? ', conversationId: CONV, skipDocuments: true, tags: ['복무'] }))
      .toEqual({ ok: true, value: { agentId: AG, question: '연가?', conversationId: CONV, skipDocuments: true, tags: ['복무'], stream: false, attachmentIds: [] } });
    expect(parseChatAsk({ agentId: AG, question: '연가?' })).toEqual({ ok: true, value: { agentId: AG, question: '연가?', conversationId: null, skipDocuments: false, tags: undefined, stream: false, attachmentIds: [] } });
  });
});

describe('비서에게 묻기', () => {
  it('키를 만든 관리자의 세션 꼴로 대화 실행기를 태우고 답·근거·출처·파일 이름·확인되지 않은 숫자를 돌려준다', async () => {
    const { value, calls } = io();
    const out = await askOrgApiChat(ctx, { agentId: AG, question: '연가 며칠?' }, value);
    expect(calls.prepare[0]).toEqual({ agent_id: AG, message: '연가 며칠?' });
    expect(calls.session[0]).toMatchObject({ user: { id: 'u-admin', role: 'ADMIN', departmentId: 'top' } });
    expect(calls.deadline[0]).toBe(NOW + ORG_API_CHAT_BUDGET_MS);
    expect(out).toEqual({ data: {
      conversationId: CONV, messageId: 'm1', continuable: true, answer: '연가는 21일입니다 [1].',
      sources: [
        { n: 1, title: '복무규정.pdf', location: 'p.12 · 제3장', common: false, effectiveFrom: '2026-01-01', excerpt: '연가는  21일' },
        { n: 2, title: '[공통] 예산편성기준(2026)', location: '청크 2 • 유사도: 85.0%', common: true, effectiveFrom: null, excerpt: '기준' },
      ],
      links: [{ title: '국가공무원 복무규정', url: 'https://law.go.kr/a' }],
      files: ['답변.hwpx'],
      numberCheck: { unverified: ['37'], rechecked: [] },
      documentsSkipped: false,
    } });
    // 새 대화 — 키 표시·[API] 제목·보안 로그(질문 글 없음)
    expect(calls.marked).toEqual([[CONV, 'k1', new Date(NOW).toISOString()]]);
    expect(calls.retitled).toEqual([CONV]);
    expect(mocks.logSecurityEvent).toHaveBeenCalledWith('top', 'u-admin', 'org_api_chat_started', { key_id: 'k1', conversation_id: CONV, agent_id: AG }, 'low');
    expect(JSON.stringify(mocks.logSecurityEvent.mock.calls)).not.toContain('연가 며칠');
  });

  it('문서 없이·태그로 좁혀 묻기는 실행기에 그대로 넘긴다(태그 꼴 검사는 실행기가)', async () => {
    const { value, calls } = io();
    await askOrgApiChat(ctx, { agentId: AG, question: 'q', skipDocuments: true, tags: ['복무'] }, value);
    expect(calls.prepare[0]).toEqual({ agent_id: AG, message: 'q', skip_documents: true, doc_tags: ['복무'] });
  });

  it('나만의 비서·지운·꺼진·다른 기관 비서는 404, 링크형·입력형 앱은 400 — 실행기를 부르지 않는다', async () => {
    for (const a of [null, agent({ tier: 'personal' }), agent({ deleted_at: 'x' }), agent({ is_active: false }), agent({ organization_id: 'other' })]) {
      const { value, calls } = io({ loadAgent: async () => a });
      expect(await askOrgApiChat(ctx, { agentId: AG, question: 'q' }, value)).toEqual({ status: 404, message: ORG_API_CHAT_AGENT_NOT_FOUND });
      expect(calls.prepare).toEqual([]);
    }
    for (const a of [agent({ agent_type: 'link' }), agent({ app_definition: { fields: [] } })]) {
      const { value, calls } = io({ loadAgent: async () => a });
      expect(await askOrgApiChat(ctx, { agentId: AG, question: 'q' }, value)).toEqual({ status: 400, message: ORG_API_CHAT_NOT_CONVERSATIONAL });
      expect(calls.prepare).toEqual([]);
    }
  });

  it('이어 묻기는 같은 키로 시작한 대화만 — 다른 키·화면 대화·없는 대화는 404, 못 읽으면 503', async () => {
    for (const key of ['k2', '', null]) {
      const { value, calls } = io({ conversationKey: async () => key });
      expect(await askOrgApiChat(ctx, { agentId: AG, question: 'q', conversationId: CONV }, value)).toEqual({ status: 404, message: ORG_API_CHAT_CONVERSATION_NOT_FOUND });
      expect(calls.prepare).toEqual([]);
    }
    const broken = io({ conversationKey: async () => { throw new Error('db'); } });
    expect(await askOrgApiChat(ctx, { agentId: AG, question: 'q', conversationId: CONV }, broken.value)).toMatchObject({ status: 503 });
    // 같은 키면 이어 간다 — 새 대화가 아니라 표시·보안 로그 없음
    const ok = io();
    const out = await askOrgApiChat(ctx, { agentId: AG, question: 'q', conversationId: CONV }, ok.value);
    expect(ok.calls.prepare[0]).toEqual({ agent_id: AG, message: 'q', conversation_id: CONV });
    expect(out).toMatchObject({ data: { conversationId: CONV, continuable: true } });
    expect(ok.calls.marked).toEqual([]);
    expect(mocks.logSecurityEvent).not.toHaveBeenCalled();
  });

  it('실행기의 시작 전 거절(한도 429·금지어 400·NODA 503)은 상태·글·코드 그대로', async () => {
    const { value } = io({ prepare: async () => ({ ok: false, status: 503, message: '참고 문서를 지금 불러오지 못했습니다', details: { code: 'documents_unavailable' } }) });
    expect(await askOrgApiChat(ctx, { agentId: AG, question: 'q' }, value)).toEqual({ status: 503, message: '참고 문서를 지금 불러오지 못했습니다', code: 'documents_unavailable' });
    const limited = io({ prepare: async () => ({ ok: false, status: 429, message: '이번 달 한도', details: { reason: 'budget' } }) });
    expect(await askOrgApiChat(ctx, { agentId: AG, question: 'q' }, limited.value)).toEqual({ status: 429, message: '이번 달 한도' });
  });

  it('생성 중 오류는 502(실행기의 안내 글), 끝나지 않으면 504 — 제목은 바꾸지 않는다', async () => {
    const err = io({ script: [{ event: 'delta', data: { text: '연' } }, { event: 'error', data: { message: '잠시 뒤 다시 시도해 주세요.' } }] as StreamScript });
    expect(await askOrgApiChat(ctx, { agentId: AG, question: 'q' }, err.value)).toEqual({ status: 502, message: '잠시 뒤 다시 시도해 주세요.' });
    expect(err.calls.retitled).toEqual([]);
    const cut = io({ script: [{ event: 'delta', data: { text: '연' } }] as StreamScript });
    expect(await askOrgApiChat(ctx, { agentId: AG, question: 'q' }, cut.value)).toEqual({ status: 504, message: ORG_API_CHAT_UNFINISHED });
    const thrown = io({ stream: async () => { throw new Error('socket hang up'); } });
    const out = await askOrgApiChat(ctx, { agentId: AG, question: 'q' }, thrown.value);
    expect(out).toMatchObject({ status: 502 });
    expect(JSON.stringify(out)).not.toContain('socket');
  });

  it('키 표시를 못 남기면 답은 하되 continuable: false + 운영 기록, 제목 실패는 답을 바꾸지 않는다', async () => {
    const { value } = io({ markConversation: async () => { throw new Error('write'); }, retitle: async () => { throw new Error('title'); } });
    const out = await askOrgApiChat(ctx, { agentId: AG, question: 'q' }, value);
    expect(out).toMatchObject({ data: { continuable: false, answer: '연가는 21일입니다 [1].' } });
    expect(mocks.logSystem).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning', details: expect.objectContaining({ key_id: 'k1', conversation_id: CONV }) }));
  });
});

describe('범위·끝점·라우트·화면', () => {
  const token = generateOrgApiToken().token;
  const deps = (scopes: string[]): OrgApiDeps => ({
    claim: async (hash) => (hash === hashOrgApiToken(token) ? { ok: true as const, key: { id: 'k1', organization_id: ORG, created_by: 'u-admin', scopes } } : { ok: false as const, reason: 'invalid' as const }),
    loadCreator: async () => ({ id: 'u-admin', role: 'ADMIN', is_active: true, deleted_at: null, department_id: 'top' }),
    loadDepartment: async () => ({ organization_id: ORG, parent_id: null }),
    allowedIps: async () => null, orgStatus: async () => 'active',
    managedDepartmentIds: async () => ['top'], recordCall: async () => {}, now: () => NOW,
  });
  const req = { authorization: `Bearer ${token}`, ip: null };
  it('chat 범위의 키만 묻는다 — 통계·문서 키로는 403, chat 키로 통계는 못 읽는다', async () => {
    expect(ORG_API_SCOPES).toContain('chat');
    expect(ORG_API_CONTENT_SCOPES).toEqual(['chat']);
    expect(ORG_API_ENDPOINTS.chat).toMatchObject({ scope: 'chat', method: 'POST', path: '/api/v1/chat' });
    expect(parseCreateKey({ name: '민원 봇', scopes: ['chat'], days: 30 })).toMatchObject({ ok: true });
    const run = vi.fn(async () => ({ data: { answer: 'a' } }));
    for (const s of [['usage'], ['documents'], ['documents_write']]) expect((await handleOrgApiCall(deps(s), req, 'chat', run)).status).toBe(403);
    expect(run).not.toHaveBeenCalled();
    expect(await handleOrgApiCall(deps(['chat']), req, 'chat', run)).toEqual({ status: 200, body: { ok: true, data: { answer: 'a' } } });
    expect((await handleOrgApiCall(deps(['chat']), req, 'usage-summary', run)).status).toBe(403);
  });
  it('실행의 오류 코드는 응답 error.code로 나간다(밖의 시스템이 documents_unavailable을 가름)', async () => {
    const res = await handleOrgApiCall(deps(['chat']), req, 'chat', async () => ({ status: 503, message: '문서', code: 'documents_unavailable' }));
    expect(res).toEqual({ status: 503, body: { ok: false, error: { message: '문서', code: 'documents_unavailable' } } });
    const plain = await handleOrgApiCall(deps(['chat']), req, 'chat', async () => ({ status: 400, message: '틀림' }));
    expect(plain.body).toEqual({ ok: false, error: { message: '틀림' } });
  });
  it('라우트는 같은 확인을 거치고 300초, 몸은 readJsonObject, 화면은 글을 내보내는 범위를 경고한다', () => {
    const route = readFileSync('src/app/api/v1/chat/route.ts', 'utf8');
    expect(route).toContain("'chat', (ctx) => askOrgApiChat(ctx, raw)");
    expect(route).toContain('readJsonObject(request)');
    expect(route).toContain('maxDuration = 300');
    expect(route).not.toMatch(/export async function (GET|DELETE|PATCH|PUT)/);
    expect(existsSync('supabase/migrations/0101_org_api_chat_scope.sql')).toBe(true);
    const panel = readFileSync('src/components/admin/OrgApiKeysPanel.tsx', 'utf8');
    expect(panel).toContain('ORG_API_CONTENT_SCOPES');
    expect(panel).toContain('비서에게 묻기');
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0101 — chat 범위·끝점 CHECK(시험 DB)', () => {
  let db: pg.Client;
  const orgId = randomUUID(); const deptId = randomUUID(); const userId = randomUUID();
  const sql = readFileSync('supabase/migrations/0101_org_api_chat_scope.sql', 'utf8');
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('chat 범위·끝점은 받고 모르는 값·여섯 범위는 거절, 여러 번 적용해도 안전', async () => {
    await db.query('BEGIN');
    try {
      await db.query(sql);
      await db.query(sql);
      await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, '0101 기관']);
      await db.query('INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)', [deptId, '기획', `d101-${deptId.slice(0, 6)}`, orgId]);
      await db.query('INSERT INTO users (id, email, department_id) VALUES ($1, $2, $3)', [userId, `${userId}@test.local`, deptId]);
      const { rows: [k] } = await db.query(
        `INSERT INTO org_api_keys (organization_id, created_by, name, token_hash, token_prefix, scopes, expires_at) VALUES ($1, $2, 'bot', $3, 'wo_api_abcde', ARRAY['adoption','usage','documents','documents_write','chat'], now() + interval '30 days') RETURNING id`,
        [orgId, userId, 'e'.repeat(64)],
      );
      for (const e of ['chat', 'documents-create', 'budget']) {
        await db.query('INSERT INTO org_api_key_calls (key_id, organization_id, endpoint, http_status) VALUES ($1, $2, $3, 200)', [k.id, orgId, e]);
      }
      for (const bad of [
        [`INSERT INTO org_api_keys (organization_id, created_by, name, token_hash, token_prefix, scopes, expires_at) VALUES ($1, $2, 'x', $3, 'wo_api_abcde', ARRAY['chat_write'], now() + interval '30 days')`, [orgId, userId, 'f'.repeat(64)]],
        [`INSERT INTO org_api_keys (organization_id, created_by, name, token_hash, token_prefix, scopes, expires_at) VALUES ($1, $2, 'x', $3, 'wo_api_abcde', ARRAY['adoption','usage','documents','documents_write','chat','adoption'], now() + interval '30 days')`, [orgId, userId, '9'.repeat(64)]],
        ['INSERT INTO org_api_key_calls (key_id, organization_id, endpoint, http_status) VALUES ($1, $2, $3, 200)', [k.id, orgId, 'chat-stream']],
      ] as const) {
        await db.query('SAVEPOINT s');
        await expect(db.query(bad[0], [...bad[1]])).rejects.toThrow(/check/i);
        await db.query('ROLLBACK TO SAVEPOINT s');
      }
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
