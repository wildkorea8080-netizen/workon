import { readFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * 2026-11-25 — 기관 API '직원으로 묻기'(0108, 범위 chat_as_user). asUser(이메일)로 이 기관의 쓸 수 있는 직원으로 묻고 첨부를 올린다.
 * 그 직원의 권한·한도·대화가 되고, 이어 묻기는 같은 키·같은 직원만. 계정을 만들지 않는다.
 */

vi.mock('@/lib/config', () => ({ SUPABASE_DOCUMENTS_BUCKET: 'documents', NODA_API_URL: 'https://noda.test', NODA_API_KEY: '' }));
vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/assistant/prepare', () => ({ prepareTurn: vi.fn() }));
vi.mock('@/lib/assistant/stream', () => ({ streamTurn: vi.fn() }));
const mocks = vi.hoisted(() => ({ logSecurityEvent: vi.fn(async () => true), logSystem: vi.fn(async () => {}) }));
vi.mock('@/lib/security-log', () => ({ logSecurityEvent: mocks.logSecurityEvent }));
vi.mock('@/lib/logger', () => ({ logSystem: mocks.logSystem }));

import { apiActor, ORG_API_AS_USER_INACTIVE, ORG_API_AS_USER_NOT_FOUND, ORG_API_AS_USER_SCOPE_DENIED, ORG_API_AS_USER_UNREAD, type AsUserIo } from '@/lib/org-api/as-user';
import { askOrgApiChat, type ChatAgentRow, type OrgApiChatIo } from '@/lib/org-api/chat';
import { issueChatAttachmentUrl, confirmChatAttachment, type ChatAttachmentIo } from '@/lib/org-api/chat-attachments';
import { ORG_API_IDENTITY_SCOPES, ORG_API_SCOPES, ORG_API_SCOPE_LABELS, parseAsUser, parseChatAsk, parseCreateKey } from '@/lib/org-api/spec';

const ORG = 'org';
const AG = '11111111-1111-4111-8111-111111111111';
const CONV = '33333333-3333-4333-8333-333333333333';
const ATT = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-11-25T03:00:00Z');
const ctx = (scopes = ['chat', 'chat_as_user']) => ({ keyId: 'k1', organizationId: ORG, departmentIds: ['top', 'child'], creatorId: 'u-admin', creatorDepartmentId: 'top', scopes });
const row = (over: Record<string, unknown> = {}) => ({ id: 'u-kim', email: 'kim@agency.go.kr', full_name: '김주무관', role: 'USER', department_id: 'child', is_active: true, deleted_at: null, is_super_admin: false, ...over });
const users = (rows: unknown[] | Error): AsUserIo => ({ findByEmail: async () => { if (rows instanceof Error) throw rows; return rows as never; } });

beforeEach(() => { vi.clearAllMocks(); });

describe('범위·요청', () => {
  it('직원으로 묻기는 따로 고르는 범위, 묻기와 함께만', () => {
    expect(ORG_API_SCOPES).toContain('chat_as_user');
    expect(ORG_API_IDENTITY_SCOPES).toEqual(['chat_as_user']);
    expect(ORG_API_SCOPE_LABELS.chat_as_user).toContain('asUser');
    expect(parseCreateKey({ name: '그룹웨어 봇', scopes: ['chat_as_user'], days: 30 })).toMatchObject({ ok: false });
    expect(parseCreateKey({ name: '그룹웨어 봇', scopes: ['chat', 'chat_as_user'], days: 30 })).toMatchObject({ ok: true, value: { scopes: ['chat', 'chat_as_user'] } });
  });
  it('asUser는 이메일 꼴만, 소문자로', () => {
    expect(parseAsUser(undefined)).toEqual({ ok: true, value: null });
    expect(parseAsUser(' Kim@Agency.go.kr ')).toEqual({ ok: true, value: 'kim@agency.go.kr' });
    expect(parseAsUser('kim')).toMatchObject({ ok: false });
    expect(parseAsUser(3)).toMatchObject({ ok: false });
    expect(parseChatAsk({ agentId: AG, question: '연가?', asUser: 'Kim@Agency.go.kr' })).toMatchObject({ ok: true, value: { asUser: 'kim@agency.go.kr' } });
    expect(parseChatAsk({ agentId: AG, question: '연가?', asUser: 'nope' })).toMatchObject({ ok: false });
  });
});

describe('직원 찾기', () => {
  it('asUser가 없으면 키를 만든 관리자', async () => {
    expect(await apiActor(ctx([]), null, users([]))).toEqual({ ok: true, actor: { id: 'u-admin', role: 'ADMIN', departmentId: 'top', asUser: false } });
  });
  it('이 기관의 쓸 수 있는 직원이면 그 사람의 역할·부서로', async () => {
    expect(await apiActor(ctx(), 'kim@agency.go.kr', users([row()]))).toEqual({ ok: true, actor: { id: 'u-kim', role: 'USER', departmentId: 'child', asUser: true } });
    expect(await apiActor(ctx(), 'kim@agency.go.kr', users([row({ role: 'ADMIN' })]))).toMatchObject({ ok: true, actor: { role: 'ADMIN' } });
  });
  it('범위가 없으면 403, 없음·둘·다른 기관·슈퍼관리자·소속 없음은 같은 404, 사용 중지·탈퇴는 403, 못 읽으면 503', async () => {
    expect(await apiActor(ctx(['chat']), 'kim@agency.go.kr', users([row()]))).toEqual({ ok: false, status: 403, message: ORG_API_AS_USER_SCOPE_DENIED });
    expect(await apiActor({ ...ctx(), scopes: undefined }, 'kim@agency.go.kr', users([row()]))).toMatchObject({ ok: false, status: 403 });
    for (const rows of [[], [row(), row({ id: 'u-2' })], [row({ department_id: 'other-org-dept' })], [row({ is_super_admin: true })], [row({ department_id: null })]]) {
      expect(await apiActor(ctx(), 'kim@agency.go.kr', users(rows))).toEqual({ ok: false, status: 404, message: ORG_API_AS_USER_NOT_FOUND });
    }
    expect(await apiActor(ctx(), 'kim@agency.go.kr', users([row({ is_active: false })]))).toEqual({ ok: false, status: 403, message: ORG_API_AS_USER_INACTIVE });
    expect(await apiActor(ctx(), 'kim@agency.go.kr', users([row({ deleted_at: '2026-11-01T00:00:00Z' })]))).toMatchObject({ ok: false, status: 403 });
    expect(await apiActor(ctx(), 'kim@agency.go.kr', users(new Error('db')))).toEqual({ ok: false, status: 503, message: ORG_API_AS_USER_UNREAD });
  });
});

describe('묻기', () => {
  const agent = { id: AG, tier: 'official', organization_id: ORG, deleted_at: null, is_active: true, agent_type: 'chat', app_definition: null } as unknown as ChatAgentRow;
  function chatIo(over: Partial<OrgApiChatIo> = {}) {
    const calls = { session: [] as unknown[], key: [] as unknown[][], marked: [] as unknown[][] };
    const io: OrgApiChatIo = {
      loadAgent: async () => agent,
      conversationKey: async (...a) => { calls.key.push(a); return 'k1'; },
      prepare: async (session, body) => { calls.session.push(session); return { ok: true, turn: { conversationId: CONV, isNewConversation: !body.conversation_id } as never }; },
      stream: async (_t, send) => { send({ event: 'delta', data: { text: '답' } }); send({ event: 'done', data: { usage: { input_tokens: 1, output_tokens: 1, model: 'm' } as never, title: 't', number_check: null, message_id: 'm1' } }); },
      markConversation: async (...a) => { calls.marked.push(a); },
      retitle: async () => {},
      now: () => NOW,
      asUser: users([row()]),
      ...over,
    };
    return { io, calls };
  }
  it('그 직원의 세션 꼴로 묻고, 대화에 직원으로 물었다고 남기고, 보안 로그는 medium·직원 id', async () => {
    const { io, calls } = chatIo();
    expect(await askOrgApiChat(ctx(), { agentId: AG, question: '연가?', asUser: 'kim@agency.go.kr' }, io)).toMatchObject({ data: { conversationId: CONV, answer: '답' } });
    expect((calls.session[0] as { user: unknown }).user).toEqual({ id: 'u-kim', role: 'USER', departmentId: 'child' });
    expect(calls.marked[0]).toEqual([CONV, 'k1', new Date(NOW).toISOString(), true]);
    expect(mocks.logSecurityEvent).toHaveBeenCalledWith('top', 'u-admin', 'org_api_chat_started', { key_id: 'k1', conversation_id: CONV, agent_id: AG, as_user_id: 'u-kim' }, 'medium');
  });
  it('이어 묻기는 그 직원의 대화로 찾는다(같은 키·같은 직원)', async () => {
    const { io, calls } = chatIo();
    await askOrgApiChat(ctx(), { agentId: AG, question: '그럼 병가는?', conversationId: CONV, asUser: 'kim@agency.go.kr' }, io);
    expect(calls.key[0]).toEqual([CONV, 'u-kim', AG]);
    const other = chatIo({ conversationKey: async () => null });
    expect(await askOrgApiChat(ctx(), { agentId: AG, question: '?', conversationId: CONV, asUser: 'kim@agency.go.kr' }, other.io)).toMatchObject({ status: 404 });
  });
  it('범위·직원 거절은 대화 실행기를 부르지 않는다, 실행기의 거절(그 직원이 못 쓰는 비서 403)은 그대로', async () => {
    const noScope = chatIo();
    expect(await askOrgApiChat(ctx(['chat']), { agentId: AG, question: '?', asUser: 'kim@agency.go.kr' }, noScope.io)).toEqual({ status: 403, message: ORG_API_AS_USER_SCOPE_DENIED });
    expect(noScope.calls.session).toHaveLength(0);
    const denied = chatIo({ prepare: async () => ({ ok: false, status: 403, message: '이 비서를 사용할 권한이 없습니다.' }) as never });
    expect(await askOrgApiChat(ctx(), { agentId: AG, question: '?', asUser: 'kim@agency.go.kr' }, denied.io)).toEqual({ status: 403, message: '이 비서를 사용할 권한이 없습니다.' });
  });
});

describe('첨부', () => {
  function attIo(over: Partial<ChatAttachmentIo> = {}) {
    const calls = { create: [] as unknown[][], confirm: [] as unknown[][] };
    const io: ChatAttachmentIo = {
      createUpload: (async (...a: unknown[]) => { calls.create.push(a); return { ok: true, id: ATT, path: 'p', token: 't', signedUrl: 'https://store/x', mimeType: 'application/pdf' }; }) as ChatAttachmentIo['createUpload'],
      confirmUpload: (async (...a: unknown[]) => { calls.confirm.push(a); return { ok: true, attachment: { id: ATT, user_id: 'u-kim', conversation_id: null, file_name: 'a.pdf', size_bytes: 1, status: 'ready', summary: null, error: null, created_at: '' } }; }) as ChatAttachmentIo['confirmUpload'],
      now: () => NOW,
      asUser: users([row()]),
      ...over,
    };
    return { io, calls };
  }
  it('asUser면 그 직원의 첨부로 올리고 확인한다', async () => {
    const { io, calls } = attIo();
    await issueChatAttachmentUrl(ctx(), { fileName: 'a.pdf', size: 1, asUser: 'kim@agency.go.kr' }, io);
    await confirmChatAttachment(ctx(), { attachmentId: ATT, asUser: 'kim@agency.go.kr' }, io);
    expect(calls.create[0][0]).toEqual({ userId: 'u-kim', departmentId: 'child', organizationId: ORG });
    expect(calls.confirm[0][0]).toEqual({ userId: 'u-kim', departmentId: 'child', organizationId: ORG });
  });
  it('asUser 꼴이 틀리면 400, 범위가 없으면 403 — 올리지 않는다', async () => {
    const bad = attIo();
    expect(await issueChatAttachmentUrl(ctx(), { fileName: 'a.pdf', size: 1, asUser: 'x' }, bad.io)).toMatchObject({ status: 400 });
    expect(await issueChatAttachmentUrl(ctx(['chat']), { fileName: 'a.pdf', size: 1, asUser: 'kim@agency.go.kr' }, bad.io)).toMatchObject({ status: 403 });
    expect(bad.calls.create).toHaveLength(0);
    // asUser 없이는 예전처럼 키 주인의 첨부
    const plain = attIo();
    await issueChatAttachmentUrl(ctx(['chat']), { fileName: 'a.pdf', size: 1 }, plain.io);
    expect(plain.calls.create[0][0]).toEqual({ userId: 'u-admin', departmentId: 'top', organizationId: ORG });
  });
});

describe('화면', () => {
  it('키 화면이 직원으로 묻기를 따로 경고한다', () => {
    const panel = readFileSync('src/components/admin/OrgApiKeysPanel.tsx', 'utf8');
    expect(panel).toContain('ORG_API_IDENTITY_SCOPES.includes(s)');
    expect(panel).toContain('어느 직원으로든 물을 수 있게');
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0108 — chat_as_user 범위 CHECK(시험 DB)', () => {
  let db: pg.Client;
  const orgId = randomUUID(); const deptId = randomUUID(); const userId = randomUUID();
  const sql = readFileSync('supabase/migrations/0108_org_api_chat_as_user.sql', 'utf8');
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('chat_as_user는 받고 모르는 값·여덟 범위는 거절, 여러 번 적용해도 안전', async () => {
    expect(existsSync('supabase/migrations/0108_org_api_chat_as_user.sql')).toBe(true);
    await db.query('BEGIN');
    try {
      await db.query(sql); await db.query(sql);
      await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, '0108 기관']);
      await db.query('INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)', [deptId, '기획', `d108-${deptId.slice(0, 6)}`, orgId]);
      await db.query('INSERT INTO users (id, email, department_id) VALUES ($1, $2, $3)', [userId, `${userId}@test.local`, deptId]);
      const ins = (hash: string, scopes: string[]) => db.query(
        `INSERT INTO org_api_keys (organization_id, created_by, name, token_hash, token_prefix, scopes, expires_at) VALUES ($1, $2, 'bot', $3, 'wo_api_abcde', $4, now() + interval '30 days')`,
        [orgId, userId, hash, scopes]);
      await ins('e'.repeat(64), ['chat', 'chat_as_user']);
      for (const [hash, scopes] of [['f'.repeat(64), ['chat_as_admin']], ['9'.repeat(64), ['adoption', 'usage', 'documents', 'documents_write', 'documents_delete', 'chat', 'chat_as_user', 'adoption']]] as const) {
        await db.query('SAVEPOINT s');
        await expect(ins(hash, [...scopes])).rejects.toThrow(/check/i);
        await db.query('ROLLBACK TO SAVEPOINT s');
      }
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
