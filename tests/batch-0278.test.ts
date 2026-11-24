import { readFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * 2026-11-24 — 기관 API의 문서 올리기(0100, 범위 documents_write).
 * 기관 문서관리시스템이 ① 올리기 주소 ② PUT ③ 등록으로 비서 문서함에 규정을 올리거나 새 판으로 바꾼다.
 * 화면 확인과 같은 검사(경로가 키 주인 것·10분·실제 크기·형식·권한·개수·바꿀 옛 판·태그 분류표), 나만의 비서 거절, 지우기 없음.
 */

type Call = [string, ...unknown[]];
const state = vi.hoisted(() => ({
  queries: [] as { table: string; calls: Call[] }[],
  existing: { data: [] as unknown[], error: null as unknown },
  old: { data: null as unknown, error: null as unknown },
  competing: { count: 0, error: null as unknown },
  insert: { error: null as unknown },
  inserted: [] as unknown[],
  signed: { data: { signedUrl: 'https://x.supabase.co/storage/v1/object/upload/sign/documents/p?token=t', token: 't', path: 'p' }, error: null as unknown },
  listed: { data: [] as unknown[], error: null as unknown },
  removed: [] as string[][],
}));
vi.mock('@/lib/config', () => ({ SUPABASE_DOCUMENTS_BUCKET: 'documents' }));
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn() }));
vi.mock('@/lib/noda', () => ({ nodaFilename: (id: string, name: string) => `${id}__${name}`, nodaTenant: (id: string) => `workon-a${id}`, noda: {} }));
vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {
  from(table: string) {
    const record = { table, calls: [] as Call[] };
    state.queries.push(record);
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'is', 'limit', 'order']) q[m] = (...args: unknown[]) => { record.calls.push([m, ...args]); return q; };
    q.insert = (rows: unknown[]) => { state.inserted.push(...rows); return Promise.resolve(state.insert); };
    q.maybeSingle = () => Promise.resolve(state.old);
    q.then = (resolve: (r: unknown) => unknown) => {
      if (record.calls.some((c) => c[0] === 'eq' && c[1] === 'storage_path')) return resolve(state.existing);
      if (record.calls.some((c) => c[0] === 'eq' && c[1] === 'replaces_id')) return resolve(state.competing);
      return resolve({ data: [], error: null });
    };
    return q;
  },
  storage: { from: () => ({
    createSignedUploadUrl: async () => state.signed,
    list: async () => state.listed,
    remove: async (paths: string[]) => { state.removed.push(paths); return { error: null }; },
  }) },
} }));
const mocks = vi.hoisted(() => ({
  loadAgentAccess: vi.fn(),
  recordAgentEvent: vi.fn(async () => {}),
  enableAgentCapability: vi.fn(async () => {}),
  checkUploadTargets: vi.fn(),
  getVisibleDepartmentIds: vi.fn(async () => ['top']),
  logSecurityEvent: vi.fn(async () => true),
  readDocument: vi.fn(async () => ({ status: 'reading' })),
  loadTagVocabulary: vi.fn(async () => ({ tags: ['복무', '여비'], restricted: true, updated_at: null })),
}));
vi.mock('@/lib/agent-store', () => ({ loadAgentAccess: mocks.loadAgentAccess, recordAgentEvent: mocks.recordAgentEvent, enableAgentCapability: mocks.enableAgentCapability }));
vi.mock('@/lib/department-scope', () => ({ getVisibleDepartmentIds: mocks.getVisibleDepartmentIds }));
vi.mock('@/lib/security-log', () => ({ logSecurityEvent: mocks.logSecurityEvent }));
vi.mock('@/lib/document-reading', () => ({ readDocument: mocks.readDocument, startReadingFields: (now: Date) => ({ noda_status: 'reading', noda_read_started_at: now.toISOString() }) }));
vi.mock('@/lib/document-tag-vocabulary', () => ({ loadTagVocabulary: mocks.loadTagVocabulary }));
vi.mock('@/lib/document-upload', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/document-upload')>()), checkUploadTargets: mocks.checkUploadTargets }));

import { createOrgApiDocument, createdStatus, issueDocumentUploadUrl, writableAgent, ORG_API_AGENT_NOT_FOUND, ORG_API_PATH_NOT_YOURS } from '@/lib/org-api/document-write';
import { ORG_API_ENDPOINTS, ORG_API_SCOPES, ORG_API_WRITE_SCOPES, parseCreateKey, parseDocCreate, parseDocUploadUrl } from '@/lib/org-api/spec';
import { generateOrgApiToken, handleOrgApiCall, hashOrgApiToken, type OrgApiDeps } from '@/lib/org-api/keys';
import { documentStoragePath } from '@/lib/document-upload';
import { DepartmentScopeReadError } from '@/lib/access-scope-error';

const ORG = 'org';
const AG = '11111111-1111-4111-8111-111111111111';
const OLD = '22222222-2222-4222-8222-222222222222';
const ctx = { keyId: 'k1', organizationId: ORG, departmentIds: ['top', 'child'], creatorId: 'u-admin', creatorDepartmentId: 'top' };
const NOW = Date.parse('2026-11-24T03:00:00Z');
const agent = (over: Record<string, unknown> = {}) => ({
  id: AG, tier: 'official', department_id: 'top', organization_id: ORG, visibility: 'organization', owner_id: null, created_by: 'u-admin',
  is_active: true, is_published: true, deleted_at: null, approval_status: null, version: 3, approval_version: null, ...over,
});
const path = (over: Partial<{ departmentId: string; userId: string; now: number; ext: string }> = {}) =>
  documentStoragePath({ departmentId: 'top', userId: 'u-admin', ext: 'pdf', now: NOW - 60_000, id: 'abc', ...over });
const body = (over: Record<string, unknown> = {}) => ({ path: path(), agentId: AG, fileName: '복무규정.pdf', fileType: 'application/pdf', ...over });
const listedSize = (size: number, name = path().split('/').pop()) => ({ data: [{ name, metadata: { size } }], error: null });

beforeEach(() => {
  vi.clearAllMocks();
  state.queries = []; state.inserted = []; state.removed = [];
  state.existing = { data: [], error: null };
  state.old = { data: null, error: null };
  state.competing = { count: 0, error: null };
  state.insert = { error: null };
  state.signed = { data: { signedUrl: 'https://x.supabase.co/storage/v1/object/upload/sign/documents/p?token=t', token: 't', path: 'p' }, error: null };
  state.listed = listedSize(1_000);
  mocks.loadAgentAccess.mockResolvedValue(agent());
  mocks.checkUploadTargets.mockImplementation(async (ids: string[]) => ({ ok: true, agentIds: ids, targets: new Map([[AG, agent()]]) }));
  mocks.getVisibleDepartmentIds.mockResolvedValue(['top']);
  mocks.readDocument.mockResolvedValue({ status: 'reading' });
});

describe('범위·끝점·요청 검사', () => {
  it('쓰기 범위는 따로 고르고, 끝점 둘은 그 범위의 POST', () => {
    expect(ORG_API_SCOPES).toContain('documents_write');
    // 0104부터 지우기도 따로 고르는 쓰기 범위
    expect(ORG_API_WRITE_SCOPES).toEqual(['documents_write', 'documents_delete']);
    expect(ORG_API_ENDPOINTS['documents-upload-url']).toMatchObject({ scope: 'documents_write', method: 'POST', path: '/api/v1/documents/upload-url' });
    expect(ORG_API_ENDPOINTS['documents-create']).toMatchObject({ scope: 'documents_write', method: 'POST', path: '/api/v1/documents' });
    expect(ORG_API_ENDPOINTS.documents.method).toBeUndefined();
    expect(parseCreateKey({ name: 'EDMS', scopes: ['documents_write', 'documents'], days: 90 })).toEqual({ ok: true, value: { name: 'EDMS', scopes: ['documents', 'documents_write'], days: 90 } });
  });
  it('주소 요청 — 비서 id·파일 이름·크기가 틀리면 400 글', () => {
    expect(parseDocUploadUrl(null)).toMatchObject({ ok: false });
    expect(parseDocUploadUrl({ agentId: 'x', fileName: 'a.pdf', size: 1 })).toMatchObject({ ok: false });
    expect(parseDocUploadUrl({ agentId: AG, fileName: '  ', size: 1 })).toMatchObject({ ok: false });
    for (const size of [0, -1, 1.5, '10', undefined]) expect(parseDocUploadUrl({ agentId: AG, fileName: 'a.pdf', size })).toMatchObject({ ok: false });
    expect(parseDocUploadUrl({ agentId: AG.toUpperCase(), fileName: 'a.pdf', size: 10 })).toEqual({ ok: true, value: { agentId: AG, fileName: 'a.pdf', size: 10, fileType: '' } });
  });
  it('등록 요청 — 옛 판 id·공개 범위·제목 꼴을 본다', () => {
    expect(parseDocCreate({ ...body(), replacesId: 'nope' })).toMatchObject({ ok: false });
    expect(parseDocCreate({ ...body(), visibility: 'public' })).toMatchObject({ ok: false });
    expect(parseDocCreate({ ...body(), title: 'x'.repeat(201) })).toMatchObject({ ok: false });
    expect(parseDocCreate({ ...body(), path: '' })).toMatchObject({ ok: false });
    const ok = parseDocCreate({ ...body(), replacesId: OLD.toUpperCase(), title: ' 복무​ 규정 ', effectiveFrom: '2027-01-01' });
    expect(ok).toMatchObject({ ok: true, value: { replacesId: OLD, title: '복무 규정', effectiveFrom: '2027-01-01', visibility: 'organization' } });
  });
});

describe('① 올리기 주소', () => {
  it('키 주인의 부서·사람 경로로 서명 주소를 주고, 권한은 기관 전체 관리자 범위로 본다', async () => {
    const out = await issueDocumentUploadUrl(ctx, { agentId: AG, fileName: '복무규정.pdf', size: 5_000, fileType: 'application/pdf' }, NOW) as { data: Record<string, unknown> };
    expect(out.data.path).toMatch(new RegExp(`^documents/top/u-admin/${NOW}-[0-9a-f-]+\\.pdf$`));
    expect(out.data).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, expiresAt: new Date(NOW + 600_000).toISOString() });
    expect(out.data.uploadUrl).toContain('/object/upload/sign/');
    const actor = mocks.checkUploadTargets.mock.calls[0][1];
    expect(actor).toMatchObject({ userId: 'u-admin', isAdmin: true, departmentId: 'top', organizationId: ORG, managedDepartmentIds: ['top', 'child'], managesWholeOrganization: true });
  });
  it('나만의 비서(키 주인 것이어도)·지운 비서·다른 기관 비서·없는 비서는 같은 404', async () => {
    for (const a of [agent({ tier: 'personal', owner_id: 'u-admin' }), agent({ deleted_at: '2026-11-01T00:00:00Z' }), agent({ organization_id: 'other' }), null]) {
      mocks.loadAgentAccess.mockResolvedValueOnce(a);
      expect(await issueDocumentUploadUrl(ctx, { agentId: AG, fileName: 'a.pdf', size: 10 }, NOW)).toEqual({ status: 404, message: ORG_API_AGENT_NOT_FOUND });
    }
    expect(mocks.checkUploadTargets).not.toHaveBeenCalled();
    expect(writableAgent(agent() as never, ORG)).toBe(true);
  });
  it('권한·개수 검사는 화면과 같은 함수의 답 그대로', async () => {
    mocks.checkUploadTargets.mockResolvedValueOnce({ ok: false, status: 403, message: '문서를 붙일 권한이 없는 비서가 포함돼 있습니다.' });
    expect(await issueDocumentUploadUrl(ctx, { agentId: AG, fileName: 'a.pdf', size: 10 }, NOW)).toMatchObject({ status: 403 });
  });
  it('막는 형식은 화면처럼 보안 로그(high)에 키와 함께, 너무 크면 413', async () => {
    const exe = await issueDocumentUploadUrl(ctx, { agentId: AG, fileName: '../../복무규정.pdf', size: 10 }, NOW) as { status: number };
    expect(exe.status).toBeGreaterThanOrEqual(400);
    expect(mocks.logSecurityEvent).toHaveBeenCalledWith('top', 'u-admin', 'file_upload_blocked', expect.objectContaining({ via: 'org_api', key_id: 'k1' }), 'high');
    expect(await issueDocumentUploadUrl(ctx, { agentId: AG, fileName: 'a.pdf', size: 100 * 1024 * 1024 }, NOW)).toMatchObject({ status: 413 });
  });
  it('관리자 범위를 못 읽으면 503 — 좁혀 판정하지 않는다', async () => {
    mocks.getVisibleDepartmentIds.mockRejectedValueOnce(new DepartmentScopeReadError('ancestors', 'x'));
    expect(await issueDocumentUploadUrl(ctx, { agentId: AG, fileName: 'a.pdf', size: 10 }, NOW)).toMatchObject({ status: 503 });
  });
  it('서명 주소를 못 만들면 던진다(500으로)', async () => {
    state.signed = { data: null as never, error: { message: 'boom' } };
    await expect(issueDocumentUploadUrl(ctx, { agentId: AG, fileName: 'a.pdf', size: 10 }, NOW)).rejects.toThrow(/createSignedUploadUrl/);
  });
});

describe('③ 등록', () => {
  it('행 하나를 키 주인 이름으로 만들고 문서 찾기를 켜고 보안 로그를 남긴 뒤 읽기를 건다', async () => {
    mocks.readDocument.mockResolvedValueOnce({ status: 'ready' });
    const out = await createOrgApiDocument(ctx, body({ title: '복무 규정' }), NOW) as { data: Record<string, unknown> };
    expect(state.inserted).toHaveLength(1);
    const row = state.inserted[0] as Record<string, unknown>;
    expect(row).toMatchObject({ uploaded_by: 'u-admin', agent_id: AG, storage_path: path(), file_name: '복무규정.pdf', title: '복무 규정', department_id: 'top', visibility: 'organization', replaces_id: null, effective_from: null, tags: [] });
    expect(out.data).toMatchObject({ id: row.id, agentId: AG, status: 'ready' });
    expect(mocks.enableAgentCapability).toHaveBeenCalledWith(AG, 'doc_search', 'u-admin');
    expect(mocks.recordAgentEvent).toHaveBeenCalledWith(AG, 'document_added', 'u-admin', expect.objectContaining({ via: 'org_api' }));
    expect(mocks.logSecurityEvent).toHaveBeenCalledWith('top', 'u-admin', 'org_api_document_uploaded', { key_id: 'k1', document_id: row.id, agent_id: AG, replaces_id: null }, 'medium');
    expect(mocks.readDocument).toHaveBeenCalledWith(row.id);
  });
  it('읽기 걸기가 던져도 등록은 됐다 — 읽는 중으로 답한다', async () => {
    mocks.readDocument.mockRejectedValueOnce(new Error('noda down'));
    expect(await createOrgApiDocument(ctx, body(), NOW)).toMatchObject({ data: { status: 'reading' } });
    expect(createdStatus({ status: 'busy' })).toBe('reading');
    expect(createdStatus({ status: 'unreadable' })).toBe('unreadable');
  });
  it('다른 사람(부서)의 경로·꼴이 틀린 경로는 받지 않는다', async () => {
    expect(await createOrgApiDocument(ctx, body({ path: path({ userId: 'u-other' }) }), NOW)).toEqual({ status: 403, message: ORG_API_PATH_NOT_YOURS });
    expect(await createOrgApiDocument(ctx, body({ path: path({ departmentId: 'child' }) }), NOW)).toEqual({ status: 403, message: ORG_API_PATH_NOT_YOURS });
    expect(await createOrgApiDocument(ctx, body({ path: '../documents/x.pdf' }), NOW)).toMatchObject({ status: 400 });
    expect(state.inserted).toHaveLength(0);
    expect(state.removed).toHaveLength(0);
  });
  it('같은 path를 다시 보내면 409(원본을 지우지 않음) — 10분이 지났어도', async () => {
    state.existing = { data: [{ id: 'doc-1' }], error: null };
    const out = await createOrgApiDocument(ctx, body({ path: path({ now: NOW - 3_600_000 }) }), NOW) as { status: number; message: string };
    expect(out.status).toBe(409);
    expect(out.message).toContain('doc-1');
    expect(state.removed).toHaveLength(0);
  });
  it('10분이 지났거나·올린 것이 없거나·너무 크거나·확장자가 다르면 원본을 치우고 거절', async () => {
    expect(await createOrgApiDocument(ctx, body({ path: path({ now: NOW - 700_000 }) }), NOW)).toMatchObject({ status: 410 });
    state.listed = { data: [], error: null };
    expect(await createOrgApiDocument(ctx, body(), NOW)).toMatchObject({ status: 413 });
    state.listed = listedSize(50 * 1024 * 1024);
    expect(await createOrgApiDocument(ctx, body(), NOW)).toMatchObject({ status: 413 });
    state.listed = listedSize(1_000);
    expect(await createOrgApiDocument(ctx, body({ fileName: '복무규정.hwp' }), NOW)).toMatchObject({ status: 400 });
    expect(state.removed).toHaveLength(4);
    expect(state.inserted).toHaveLength(0);
  });
  it('비서·권한 문제는 원본을 남겨 다시 등록할 수 있게 한다', async () => {
    mocks.loadAgentAccess.mockResolvedValueOnce(agent({ tier: 'personal', owner_id: 'u-admin' }));
    expect(await createOrgApiDocument(ctx, body(), NOW)).toEqual({ status: 404, message: ORG_API_AGENT_NOT_FOUND });
    expect(state.removed).toHaveLength(0);
  });
  it('새 판 — 같은 기관의 옛 판을 조건으로 읽고, 화면과 같은 판정(지난 판·경쟁 새 판은 409)', async () => {
    state.old = { data: { id: OLD, agent_id: AG, noda_status: 'ready', retired_at: null }, error: null };
    const out = await createOrgApiDocument(ctx, body({ replacesId: OLD, effectiveFrom: '2027-01-01' }), NOW) as { data: Record<string, unknown> };
    expect(out.data).toMatchObject({ replacesId: OLD, effectiveFrom: '2027-01-01' });
    expect(state.inserted[0]).toMatchObject({ replaces_id: OLD, effective_from: '2027-01-01' });
    const oldQuery = state.queries.find((q) => q.calls.some((c) => c[0] === 'eq' && c[1] === 'id' && c[2] === OLD))!;
    expect(oldQuery.calls).toContainEqual(['eq', 'organization_id', ORG]);
    state.inserted = [];
    state.old = { data: { id: OLD, agent_id: AG, noda_status: 'retired', retired_at: '2026-11-01T00:00:00Z' }, error: null };
    expect(await createOrgApiDocument(ctx, body({ replacesId: OLD }), NOW)).toMatchObject({ status: 409 });
    state.old = { data: { id: OLD, agent_id: AG, noda_status: 'ready', retired_at: null }, error: null };
    state.competing = { count: 1, error: null };
    expect(await createOrgApiDocument(ctx, body({ replacesId: OLD }), NOW)).toMatchObject({ status: 409 });
    state.old = { data: null, error: null };
    state.competing = { count: 0, error: null };
    expect(await createOrgApiDocument(ctx, body({ replacesId: OLD }), NOW)).toMatchObject({ status: 409 });
    expect(state.inserted).toHaveLength(0);
    state.old = { data: null, error: { message: 'boom' } };
    await expect(createOrgApiDocument(ctx, body({ replacesId: OLD }), NOW)).rejects.toThrow(/replaces/);
  });
  it('없는 날짜 시행일은 400', async () => {
    expect(await createOrgApiDocument(ctx, body({ effectiveFrom: '2027-02-30' }), NOW)).toMatchObject({ status: 400 });
  });
  it('태그 — 분류표 표기로 맞추고, 분류표만이면 밖의 태그 400, 분류표를 못 읽으면 503(등록하지 않음)', async () => {
    const out = await createOrgApiDocument(ctx, body({ tags: ['복무'] }), NOW) as { data: { tags: string[] } };
    expect(out.data.tags).toEqual(['복무']);
    expect(await createOrgApiDocument(ctx, body({ tags: ['인사'] }), NOW)).toMatchObject({ status: 400 });
    mocks.loadTagVocabulary.mockRejectedValueOnce(new Error('boom'));
    expect(await createOrgApiDocument(ctx, body({ tags: ['복무'] }), NOW)).toMatchObject({ status: 503 });
    expect(await createOrgApiDocument(ctx, body({ tags: 5 }), NOW)).toMatchObject({ status: 400 });
    expect(state.inserted).toHaveLength(1);
  });
  it('읽기·쓰기 실패는 던진다(500 — 성공처럼 답하지 않음)', async () => {
    state.existing = { data: [], error: { message: 'boom' } };
    await expect(createOrgApiDocument(ctx, body(), NOW)).rejects.toThrow(/existing/);
    state.existing = { data: [], error: null };
    state.insert = { error: { message: 'boom' } };
    await expect(createOrgApiDocument(ctx, body(), NOW)).rejects.toThrow(/insert/);
    expect(mocks.logSecurityEvent).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'org_api_document_uploaded', expect.anything(), expect.anything());
  });
});

describe('호출 확인 — 쓰기 범위', () => {
  const token = generateOrgApiToken().token;
  const deps = (scopes: string[]): OrgApiDeps => ({
    claim: async (hash) => (hash === hashOrgApiToken(token) ? { ok: true as const, key: { id: 'k1', organization_id: ORG, created_by: 'u-admin', scopes } } : { ok: false as const, reason: 'invalid' as const }),
    loadCreator: async () => ({ id: 'u-admin', role: 'ADMIN', is_active: true, deleted_at: null, department_id: 'top' }),
    loadDepartment: async () => ({ organization_id: ORG, parent_id: null }),
    allowedIps: async () => null, orgStatus: async () => 'active',
    managedDepartmentIds: async () => ['top'], recordCall: async () => {}, now: () => NOW,
  });
  const req = { authorization: `Bearer ${token}`, ip: null };
  it('읽기 키(documents)로는 못 올리고, 쓰기 키로는 올린다 — 쓰기 키로 목록은 못 읽는다', async () => {
    const run = vi.fn(async (c: { creatorId: string; creatorDepartmentId: string }) => ({ data: { by: c.creatorId, dept: c.creatorDepartmentId } }));
    expect((await handleOrgApiCall(deps(['documents']), req, 'documents-create', run)).status).toBe(403);
    expect(run).not.toHaveBeenCalled();
    const res = await handleOrgApiCall(deps(['documents_write']), req, 'documents-create', run, { successStatus: 201 });
    expect(res).toEqual({ status: 201, body: { ok: true, data: { by: 'u-admin', dept: 'top' } } });
    expect((await handleOrgApiCall(deps(['documents_write']), req, 'documents', run)).status).toBe(403);
  });
  it('쓰기 끝점의 실패 글은 통계 글이 아니다', async () => {
    const res = await handleOrgApiCall(deps(['documents_write']), req, 'documents-upload-url', async () => { throw new Error('x'); }, { failureMessage: '올리기 주소를 만들지 못했습니다.' });
    expect(res).toEqual({ status: 500, body: { ok: false, error: { message: '올리기 주소를 만들지 못했습니다.' } } });
  });
  it('라우트는 같은 확인을 거치고, 몸은 readJsonObject로, 지우기(DELETE) 핸들러는 없다', () => {
    const create = readFileSync('src/app/api/v1/documents/route.ts', 'utf8');
    expect(create).toContain("'documents-create', (ctx) => createOrgApiDocument(ctx, raw)");
    expect(create).toContain('successStatus: 201');
    expect(create).toContain('readJsonObject(request)');
    expect(create).not.toMatch(/export async function (DELETE|PATCH|PUT)/);
    const url = readFileSync('src/app/api/v1/documents/upload-url/route.ts', 'utf8');
    expect(url).toContain("'documents-upload-url', (ctx) => issueDocumentUploadUrl(ctx, raw)");
    expect(url).toContain('readJsonObject(request)');
    expect(existsSync('supabase/migrations/0100_org_api_documents_write.sql')).toBe(true);
    const panel = readFileSync('src/components/admin/OrgApiKeysPanel.tsx', 'utf8');
    expect(panel).toContain('ORG_API_WRITE_SCOPES');
    expect(panel).toContain("e.method ?? 'GET'");
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0100 — 쓰기 범위·끝점 CHECK(시험 DB)', () => {
  let db: pg.Client;
  const orgId = randomUUID(); const deptId = randomUUID(); const userId = randomUUID();
  const sql = readFileSync('supabase/migrations/0100_org_api_documents_write.sql', 'utf8');
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('documents_write 범위·끝점 둘은 받고 모르는 값은 거절, 여러 번 적용해도 안전', async () => {
    await db.query('BEGIN');
    try {
      await db.query(sql);
      await db.query(sql);
      await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, '0100 기관']);
      await db.query('INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)', [deptId, '기획', `d100-${deptId.slice(0, 6)}`, orgId]);
      await db.query('INSERT INTO users (id, email, department_id) VALUES ($1, $2, $3)', [userId, `${userId}@test.local`, deptId]);
      const { rows: [k] } = await db.query(
        `INSERT INTO org_api_keys (organization_id, created_by, name, token_hash, token_prefix, scopes, expires_at) VALUES ($1, $2, 'EDMS', $3, 'wo_api_abcde', ARRAY['adoption','usage','documents','documents_write'], now() + interval '30 days') RETURNING id`,
        [orgId, userId, 'e'.repeat(64)],
      );
      for (const e of ['documents-upload-url', 'documents-create', 'documents', 'budget']) {
        await db.query('INSERT INTO org_api_key_calls (key_id, organization_id, endpoint, http_status) VALUES ($1, $2, $3, 201)', [k.id, orgId, e]);
      }
      for (const bad of [
        [`INSERT INTO org_api_keys (organization_id, created_by, name, token_hash, token_prefix, scopes, expires_at) VALUES ($1, $2, 'x', $3, 'wo_api_abcde', ARRAY['documents_delete'], now() + interval '30 days')`, [orgId, userId, 'f'.repeat(64)]],
        [`INSERT INTO org_api_keys (organization_id, created_by, name, token_hash, token_prefix, scopes, expires_at) VALUES ($1, $2, 'x', $3, 'wo_api_abcde', ARRAY['adoption','usage','documents','documents_write','adoption'], now() + interval '30 days')`, [orgId, userId, '9'.repeat(64)]],
        ['INSERT INTO org_api_key_calls (key_id, organization_id, endpoint, http_status) VALUES ($1, $2, $3, 200)', [k.id, orgId, 'documents-delete']],
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
