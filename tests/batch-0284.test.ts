import { readFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * 2026-11-24 — 기관 API '비서에게 묻기'의 첨부(0105, 범위 chat).
 * ① 올리기 주소 ② PUT ③ 확인·읽기 ④ 묻기의 attachmentIds. 첨부 주인은 키를 만든 기관 전체 관리자 —
 * 화면 대화 첨부와 같은 함수(createUpload·confirmUpload)라 형식·크기·상한·읽기가 같다.
 */

vi.mock('@/lib/config', () => ({ SUPABASE_DOCUMENTS_BUCKET: 'documents', NODA_API_URL: 'https://noda.test', NODA_API_KEY: '' }));
vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/assistant/prepare', () => ({ prepareTurn: vi.fn() }));
vi.mock('@/lib/assistant/stream', () => ({ streamTurn: vi.fn() }));
vi.mock('@/lib/security-log', () => ({ logSecurityEvent: vi.fn(async () => true) }));
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn(async () => {}) }));

import { issueChatAttachmentUrl, confirmChatAttachment, attachmentView, type ChatAttachmentIo } from '@/lib/org-api/chat-attachments';
import { askOrgApiChat, type ChatAgentRow, type OrgApiChatIo } from '@/lib/org-api/chat';
import { ORG_API_CHAT_MAX_ATTACHMENTS, ORG_API_ENDPOINTS, parseChatAsk } from '@/lib/org-api/spec';
import { MAX_ATTACHMENTS_PER_SEND } from '@/lib/attachments/limits';
import { API_ROUTES } from '@/lib/api-route-ids';
import type { AttachmentRow } from '@/lib/attachments/types';

const ORG = 'org';
const AG = '11111111-1111-4111-8111-111111111111';
const ATT = '22222222-2222-4222-8222-222222222222';
const CONV = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-11-24T03:00:00Z');
const ctx = { keyId: 'k1', organizationId: ORG, departmentIds: ['top'], creatorId: 'u-admin', creatorDepartmentId: 'top' };
const actor = { userId: 'u-admin', departmentId: 'top', organizationId: ORG };

const row = (over: Partial<AttachmentRow> = {}): AttachmentRow => ({
  id: ATT, user_id: 'u-admin', conversation_id: null, file_name: '민원 첨부.xlsx', size_bytes: 2048, status: 'ready', error: null, created_at: '2026-11-24T03:00:00Z',
  summary: { kind: 'spreadsheet', sheets: ['Sheet1'], chars: 120, tables: [{ id: 't1', title: 'Sheet1', rows: 12, columns: ['부서', '금액'], caption: '(단위: 천원)' }], warnings: [] },
  ...over,
});

function fakeIo(over: Partial<ChatAttachmentIo> = {}) {
  const calls = { create: [] as unknown[][], confirm: [] as unknown[][] };
  const io: ChatAttachmentIo = {
    createUpload: (async (...a: unknown[]) => { calls.create.push(a); return { ok: true, id: ATT, path: 'chat-uploads/org/u-admin/x.xlsx', token: 'tok', signedUrl: 'https://store.example/upload/sign/x?token=tok', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }; }) as ChatAttachmentIo['createUpload'],
    confirmUpload: (async (...a: unknown[]) => { calls.confirm.push(a); return { ok: true, attachment: row() }; }) as ChatAttachmentIo['confirmUpload'],
    now: () => NOW,
    ...over,
  };
  return { io, calls };
}

describe('① 올리기 주소', () => {
  it('키 주인의 첨부로 발급하고 PUT 주소·형식·확인 기한을 돌려준다', async () => {
    const { io, calls } = fakeIo();
    const out = await issueChatAttachmentUrl(ctx, { fileName: '민원 첨부.xlsx', size: 2048 }, io);
    expect(out).toEqual({ data: {
      attachmentId: ATT, uploadUrl: 'https://store.example/upload/sign/x?token=tok', method: 'PUT',
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      expiresAt: new Date(NOW + 10 * 60_000).toISOString(),
    } });
    expect(calls.create[0]).toEqual([actor, { fileName: '민원 첨부.xlsx', size: 2048 }]);
    // 저장소 경로·토큰은 내보내지 않는다
    expect(JSON.stringify(out)).not.toContain('chat-uploads/');
  });
  it('틀린 요청은 400, 화면 첨부의 거절(형식·크기·보내지 않은 첨부 상한)은 그대로, 주소가 없으면 503', async () => {
    for (const bad of [null, [], { size: 1 }, { fileName: ' ', size: 1 }, { fileName: 'a.pdf', size: 0 }, { fileName: 'a.pdf', size: 1.5 }, { fileName: 'a.pdf', size: '10' }]) {
      expect(await issueChatAttachmentUrl(ctx, bad, fakeIo().io)).toMatchObject({ status: 400 });
    }
    expect(await issueChatAttachmentUrl(ctx, { fileName: 'a.pdf', size: 1 }, fakeIo({ createUpload: (async () => ({ ok: false, status: 429, message: '보내지 않은 첨부가 많습니다' })) as never }).io))
      .toEqual({ status: 429, message: '보내지 않은 첨부가 많습니다' });
    expect(await issueChatAttachmentUrl(ctx, { fileName: 'a.pdf', size: 1 }, fakeIo({ createUpload: (async () => ({ ok: true, id: ATT, path: 'p', token: 't' })) as never }).io))
      .toMatchObject({ status: 503 });
  });
});

describe('③ 확인·읽기', () => {
  it('키 주인의 첨부를 확인하고 읽은 요약만(경로·사람 id 없음)', async () => {
    const { io, calls } = fakeIo();
    const out = await confirmChatAttachment(ctx, { attachmentId: ATT.toUpperCase() }, io);
    expect(calls.confirm[0]).toEqual([actor, ATT]);
    expect(out).toEqual({ data: attachmentView(row()) });
    expect(out).toMatchObject({ data: { attachmentId: ATT, fileName: '민원 첨부.xlsx', status: 'ready', summary: { kind: 'spreadsheet', tables: [{ id: 't1', rows: 12, columns: ['부서', '금액'] }] } } });
    expect(JSON.stringify(out)).not.toContain('u-admin');
  });
  it('읽지 못한 파일은 status failed와 까닭, 꼴이 틀리면 400, 거절(남의 것 404·기한 410)은 그대로', async () => {
    expect(await confirmChatAttachment(ctx, { attachmentId: ATT }, fakeIo({ confirmUpload: (async () => ({ ok: true, attachment: row({ status: 'failed', error: '암호가 걸린 파일', summary: null }) })) as never }).io))
      .toMatchObject({ data: { status: 'failed', error: '암호가 걸린 파일', summary: null } });
    expect(await confirmChatAttachment(ctx, { attachmentId: 'x' }, fakeIo().io)).toMatchObject({ status: 400 });
    expect(await confirmChatAttachment(ctx, null, fakeIo().io)).toMatchObject({ status: 400 });
    expect(await confirmChatAttachment(ctx, { attachmentId: ATT }, fakeIo({ confirmUpload: (async () => ({ ok: false, status: 410, message: '확인 기한이 지났습니다' })) as never }).io))
      .toEqual({ status: 410, message: '확인 기한이 지났습니다' });
  });
});

describe('④ 묻기에 붙이기', () => {
  it('attachmentIds — uuid 배열만, 중복은 하나로, 10개까지(화면과 같은 상한)', () => {
    expect(ORG_API_CHAT_MAX_ATTACHMENTS).toBe(MAX_ATTACHMENTS_PER_SEND);
    expect(parseChatAsk({ agentId: AG, question: '요약', attachmentIds: ATT })).toMatchObject({ ok: false });
    expect(parseChatAsk({ agentId: AG, question: '요약', attachmentIds: ['x'] })).toMatchObject({ ok: false });
    const eleven = Array.from({ length: 11 }, () => randomUUID());
    expect(parseChatAsk({ agentId: AG, question: '요약', attachmentIds: eleven })).toMatchObject({ ok: false });
    expect(parseChatAsk({ agentId: AG, question: '요약', attachmentIds: [ATT, ATT.toUpperCase()] })).toMatchObject({ ok: true, value: { attachmentIds: [ATT] } });
    expect(parseChatAsk({ agentId: AG, question: '요약' })).toMatchObject({ ok: true, value: { attachmentIds: [] } });
  });
  it('대화 실행기에 attachment_ids로 넘기고, 실행기의 거절(파일 받아 읽기 꺼짐 400)은 그대로', async () => {
    const bodies: Record<string, unknown>[] = [];
    const agent = { id: AG, tier: 'official', organization_id: ORG, deleted_at: null, is_active: true, agent_type: 'chat', app_definition: null } as unknown as ChatAgentRow;
    const chatIo = (prepareOk: boolean): OrgApiChatIo => ({
      loadAgent: async () => agent,
      conversationKey: async () => 'k1',
      prepare: async (_s, body) => { bodies.push(body); return prepareOk ? { ok: true, turn: { conversationId: CONV, isNewConversation: true } as never } : { ok: false, status: 400, message: '이 비서는 파일을 받지 않습니다' } as never; },
      stream: async (_t, send) => { send({ event: 'done', data: { usage: { input_tokens: 1, output_tokens: 1, model: 'm' } as never, title: 't', number_check: null, message_id: 'm1' } }); },
      markConversation: async () => {}, retitle: async () => {}, now: () => NOW,
    });
    expect(await askOrgApiChat(ctx, { agentId: AG, question: '요약', attachmentIds: [ATT] }, chatIo(true))).toMatchObject({ data: { conversationId: CONV } });
    expect(bodies[0]).toMatchObject({ agent_id: AG, message: '요약', attachment_ids: [ATT] });
    await askOrgApiChat(ctx, { agentId: AG, question: '요약' }, chatIo(true));
    expect(bodies[1]).not.toHaveProperty('attachment_ids');
    expect(await askOrgApiChat(ctx, { agentId: AG, question: '요약', attachmentIds: [ATT] }, chatIo(false))).toEqual({ status: 400, message: '이 비서는 파일을 받지 않습니다' });
  });
});

describe('끝점·라우트', () => {
  it('범위는 chat, 두 끝점은 POST', () => {
    expect(ORG_API_ENDPOINTS['chat-attachment-upload-url']).toMatchObject({ scope: 'chat', method: 'POST', path: '/api/v1/chat/attachments/upload-url' });
    expect(ORG_API_ENDPOINTS['chat-attachment-confirm']).toMatchObject({ scope: 'chat', method: 'POST', path: '/api/v1/chat/attachments' });
    for (const r of ['v1/chat/attachments', 'v1/chat/attachments/upload-url']) expect(API_ROUTES).toContain(r);
    const confirm = readFileSync('src/app/api/v1/chat/attachments/route.ts', 'utf8');
    expect(confirm).toContain("'chat-attachment-confirm'");
    expect(confirm).toContain('export const maxDuration = 300');
    expect(readFileSync('src/app/api/v1/chat/attachments/upload-url/route.ts', 'utf8')).toContain("'chat-attachment-upload-url'");
    expect(readFileSync('src/lib/attachments/store.ts', 'utf8')).toContain('signedUrl: data.signedUrl, mimeType: MIME_BY_EXT[ext]');
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0105 — 첨부 끝점 호출 기록 CHECK(시험 DB)', () => {
  let db: pg.Client;
  const orgId = randomUUID(); const deptId = randomUUID(); const userId = randomUUID();
  const sql = readFileSync('supabase/migrations/0105_org_api_chat_attachments.sql', 'utf8');
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('두 끝점은 받고 모르는 끝점은 거절, 여러 번 적용해도 안전', async () => {
    expect(existsSync('supabase/migrations/0105_org_api_chat_attachments.sql')).toBe(true);
    await db.query('BEGIN');
    try {
      await db.query(sql);
      await db.query(sql);
      await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, '0105 기관']);
      await db.query('INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)', [deptId, '기획', `d105-${deptId.slice(0, 6)}`, orgId]);
      await db.query('INSERT INTO users (id, email, department_id) VALUES ($1, $2, $3)', [userId, `${userId}@test.local`, deptId]);
      const { rows: [k] } = await db.query(
        `INSERT INTO org_api_keys (organization_id, created_by, name, token_hash, token_prefix, scopes, expires_at) VALUES ($1, $2, 'bot', $3, 'wo_api_abcde', ARRAY['chat'], now() + interval '30 days') RETURNING id`,
        [orgId, userId, 'e'.repeat(64)],
      );
      for (const e of ['chat-attachment-upload-url', 'chat-attachment-confirm', 'chat', 'documents-delete']) {
        await db.query('INSERT INTO org_api_key_calls (key_id, organization_id, endpoint, http_status) VALUES ($1, $2, $3, 200)', [k.id, orgId, e]);
      }
      await db.query('SAVEPOINT s');
      await expect(db.query('INSERT INTO org_api_key_calls (key_id, organization_id, endpoint, http_status) VALUES ($1, $2, $3, 200)', [k.id, orgId, 'chat-attachment-delete'])).rejects.toThrow(/check/i);
      await db.query('ROLLBACK TO SAVEPOINT s');
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
