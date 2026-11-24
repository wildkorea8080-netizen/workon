import { readFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * 2026-11-24 — 기관 API의 문서 지우기(0104, 범위 documents_delete, DELETE /api/v1/documents/{id}).
 * 이 기관의 공식·부서 비서의 문서만, 관리자 문서 화면과 같은 길(NODA → 행 → 원본)로 지운다.
 */

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn(async () => {}) }));
vi.mock('@/lib/config', () => ({ SUPABASE_DOCUMENTS_BUCKET: 'documents', NODA_API_URL: 'https://noda.test', NODA_API_KEY: '' }));

import { deleteOrgApiDocument, ORG_API_DOCUMENT_NOT_FOUND, ORG_API_DOCUMENT_UNREAD, type OrgApiDeleteIo } from '@/lib/org-api/document-delete';
import { ORG_API_ENDPOINTS, ORG_API_SCOPES, ORG_API_WRITE_SCOPES, ORG_API_SCOPE_LABELS, parseCreateKey } from '@/lib/org-api/spec';
import { generateOrgApiToken, handleOrgApiCall, hashOrgApiToken, type OrgApiContext, type OrgApiDeps } from '@/lib/org-api/keys';
import { API_ROUTES } from '@/lib/api-route-ids';

const ORG = 'org-1';
const DOC = '66666666-6666-4666-8666-666666666666';
const AGENT = '77777777-7777-4777-8777-777777777777';
const ctx: OrgApiContext = { keyId: 'key-1', organizationId: ORG, departmentIds: ['d1'], creatorId: 'admin-1', creatorDepartmentId: 'd1' };
const doc = (over: Record<string, unknown> = {}) => ({
  id: DOC, storage_path: 'documents/d1/admin-1/a.pdf', agent_id: AGENT, file_name: '여비 규정.pdf', noda_filename: `${DOC}__여비 규정.pdf`, noda_status: 'ready', organization_id: ORG, ...over,
});
const agent = (over: Record<string, unknown> = {}) => ({ id: AGENT, deleted_at: null, tier: 'official', organization_id: ORG, ...over }) as never;

function fakeIo(over: Partial<OrgApiDeleteIo> = {}) {
  const calls = { remove: [] as unknown[][], log: [] as unknown[][], loadDocument: [] as unknown[][] };
  const io: OrgApiDeleteIo = {
    loadDocument: async (...a) => { calls.loadDocument.push(a); return doc(); },
    loadAgent: async () => agent(),
    remove: (async (...a: unknown[]) => { calls.remove.push(a); return { ok: true }; }) as OrgApiDeleteIo['remove'],
    log: (async (...a: unknown[]) => { calls.log.push(a); return true; }) as OrgApiDeleteIo['log'],
    ...over,
  };
  return { io, calls };
}

describe('문서 지우기', () => {
  it('이 기관 공식·부서 비서의 문서를 화면과 같은 길로 지우고 보안 로그(high)', async () => {
    const { io, calls } = fakeIo();
    expect(await deleteOrgApiDocument(ctx, DOC.toUpperCase(), io)).toEqual({ data: { id: DOC, deleted: true } });
    expect(calls.loadDocument[0]).toEqual([DOC, ORG]);
    expect(calls.remove[0][1]).toBe('admin-1');
    expect(calls.remove[0][2]).toBe('org_api');
    expect(calls.log[0]).toEqual(['d1', 'admin-1', 'org_api_document_deleted', { key_id: 'key-1', document_id: DOC, agent_id: AGENT }, 'high']);
  });
  it('부서 비서도 지운다', async () => {
    expect(await deleteOrgApiDocument(ctx, DOC, fakeIo({ loadAgent: async () => agent({ tier: 'department' }) }).io)).toMatchObject({ data: { deleted: true } });
  });
  it('없는 문서·다른 기관·비서 없는 문서·나만의 비서·지운 비서·꼴이 틀린 id는 404이고 지우지 않는다', async () => {
    const cases: Partial<OrgApiDeleteIo>[] = [
      { loadDocument: async () => null },
      { loadDocument: async () => doc({ organization_id: 'org-2' }) },
      { loadDocument: async () => doc({ agent_id: null }) },
      { loadAgent: async () => agent({ tier: 'personal' }) },
      { loadAgent: async () => agent({ deleted_at: '2026-11-01T00:00:00Z' }) },
      { loadAgent: async () => agent({ organization_id: 'org-2' }) },
      { loadAgent: async () => null },
    ];
    for (const over of cases) {
      const { io, calls } = fakeIo(over);
      expect(await deleteOrgApiDocument(ctx, DOC, io)).toEqual({ status: 404, message: ORG_API_DOCUMENT_NOT_FOUND });
      expect(calls.remove).toHaveLength(0);
      expect(calls.log).toHaveLength(0);
    }
    const { io, calls } = fakeIo();
    expect(await deleteOrgApiDocument(ctx, 'abc', io)).toMatchObject({ status: 404 });
    expect(calls.loadDocument).toHaveLength(0);
  });
  it('문서·비서를 못 읽으면 503이고 지우지 않는다', async () => {
    for (const over of [{ loadDocument: async () => { throw new Error('db'); } }, { loadAgent: async () => { throw new Error('db'); } }] as Partial<OrgApiDeleteIo>[]) {
      const { io, calls } = fakeIo(over);
      expect(await deleteOrgApiDocument(ctx, DOC, io)).toEqual({ status: 503, message: ORG_API_DOCUMENT_UNREAD });
      expect(calls.remove).toHaveLength(0);
    }
  });
  it('NODA를 못 비우면 502 documents_unavailable, 행 삭제 실패는 500 — 보안 로그는 지웠을 때만', async () => {
    const nodaFail = fakeIo({ remove: (async () => ({ ok: false, status: 502, message: '문서 보관소에서 지우지 못했습니다.' })) as OrgApiDeleteIo['remove'] });
    expect(await deleteOrgApiDocument(ctx, DOC, nodaFail.io)).toEqual({ status: 502, message: '문서 보관소에서 지우지 못했습니다.', code: 'documents_unavailable' });
    expect(nodaFail.calls.log).toHaveLength(0);
    const dbFail = fakeIo({ remove: (async () => ({ ok: false, status: 500, message: '못 지움' })) as OrgApiDeleteIo['remove'] });
    expect(await deleteOrgApiDocument(ctx, DOC, dbFail.io)).toEqual({ status: 500, message: '못 지움' });
  });
});

describe('범위·끝점', () => {
  it('지우기는 올리기와 따로 고르는 쓰기 범위, 끝점은 DELETE', () => {
    expect(ORG_API_SCOPES).toContain('documents_delete');
    expect(ORG_API_WRITE_SCOPES).toEqual(['documents_write', 'documents_delete']);
    expect(ORG_API_SCOPE_LABELS.documents_delete).toContain('되돌릴 수 없음');
    expect(ORG_API_ENDPOINTS['documents-delete']).toMatchObject({ scope: 'documents_delete', method: 'DELETE', path: '/api/v1/documents/{id}' });
    expect(parseCreateKey({ name: '문서관리', scopes: ['documents_write', 'documents_delete'], days: 90 })).toMatchObject({ ok: true });
  });
  it('올리기 키로는 지우지 못한다(403), 지우기 키로 부르면 run을 탄다', async () => {
    const token = generateOrgApiToken().token;
    const deps = (scopes: string[]): OrgApiDeps => ({
      claim: async (hash) => (hash === hashOrgApiToken(token) ? { ok: true as const, key: { id: 'k1', organization_id: ORG, created_by: 'admin-1', scopes } } : { ok: false as const, reason: 'invalid' as const }),
      loadCreator: async () => ({ id: 'admin-1', role: 'ADMIN', is_active: true, deleted_at: null, department_id: 'top' }),
      loadDepartment: async () => ({ organization_id: ORG, parent_id: null }),
      allowedIps: async () => null, orgStatus: async () => 'active',
      managedDepartmentIds: async () => ['top'], recordCall: async () => {}, now: () => Date.parse('2026-11-24T00:00:00Z'),
    });
    const req = { authorization: `Bearer ${token}`, ip: null };
    const run = vi.fn(async () => ({ data: { id: DOC, deleted: true } }));
    for (const sc of [['documents_write'], ['documents'], ['chat']]) expect((await handleOrgApiCall(deps(sc), req, 'documents-delete', run)).status).toBe(403);
    expect(run).not.toHaveBeenCalled();
    expect(await handleOrgApiCall(deps(['documents_delete']), req, 'documents-delete', run)).toEqual({ status: 200, body: { ok: true, data: { id: DOC, deleted: true } } });
    // 지우기 키로 올리지는 못한다
    expect((await handleOrgApiCall(deps(['documents_delete']), req, 'documents-create', run)).status).toBe(403);
  });
  it('라우트·인증 목록·화면 경고', () => {
    expect(API_ROUTES).toContain('v1/documents/[id]');
    const route = readFileSync('src/app/api/v1/documents/[id]/route.ts', 'utf8');
    expect(route).toContain("'documents-delete'");
    expect(route).toContain('deleteOrgApiDocument(ctx, params.id)');
    expect(route).not.toMatch(/export async function (GET|POST|PATCH|PUT)/);
    expect(readFileSync('tests/route-auth.test.ts', 'utf8')).toContain("['/v1/documents/[id]'");
    expect(readFileSync('src/components/admin/OrgApiKeysPanel.tsx', 'utf8')).toContain("scopes.includes('documents_delete')");
    expect(readFileSync('src/lib/security-event-text.ts', 'utf8')).toContain("org_api_document_deleted: '기관 API로 문서 지움'");
  });
  it('화면 삭제와 API 삭제가 같은 지우기를 쓴다', () => {
    expect(readFileSync('src/app/api/documents/route.ts', 'utf8')).toContain('deleteAgentDocument(doc, actor.userId)');
    expect(readFileSync('src/lib/org-api/document-delete.ts', 'utf8')).toContain("remove: deleteAgentDocument");
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0104 — 지우기 범위·끝점 CHECK(시험 DB)', () => {
  let db: pg.Client;
  const orgId = randomUUID(); const deptId = randomUUID(); const userId = randomUUID();
  const sql = readFileSync('supabase/migrations/0104_org_api_documents_delete.sql', 'utf8');
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('documents_delete 범위·끝점은 받고 모르는 값·일곱 범위는 거절, 여러 번 적용해도 안전', async () => {
    expect(existsSync('supabase/migrations/0104_org_api_documents_delete.sql')).toBe(true);
    await db.query('BEGIN');
    try {
      await db.query(sql);
      await db.query(sql);
      await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, '0104 기관']);
      await db.query('INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)', [deptId, '기획', `d104-${deptId.slice(0, 6)}`, orgId]);
      await db.query('INSERT INTO users (id, email, department_id) VALUES ($1, $2, $3)', [userId, `${userId}@test.local`, deptId]);
      const { rows: [k] } = await db.query(
        `INSERT INTO org_api_keys (organization_id, created_by, name, token_hash, token_prefix, scopes, expires_at) VALUES ($1, $2, 'dms', $3, 'wo_api_abcde', ARRAY['adoption','usage','documents','documents_write','documents_delete','chat'], now() + interval '30 days') RETURNING id`,
        [orgId, userId, 'e'.repeat(64)],
      );
      for (const e of ['documents-delete', 'documents-create', 'chat']) {
        await db.query('INSERT INTO org_api_key_calls (key_id, organization_id, endpoint, http_status) VALUES ($1, $2, $3, 200)', [k.id, orgId, e]);
      }
      for (const bad of [
        [`INSERT INTO org_api_keys (organization_id, created_by, name, token_hash, token_prefix, scopes, expires_at) VALUES ($1, $2, 'x', $3, 'wo_api_abcde', ARRAY['documents_purge'], now() + interval '30 days')`, [orgId, userId, 'f'.repeat(64)]],
        [`INSERT INTO org_api_keys (organization_id, created_by, name, token_hash, token_prefix, scopes, expires_at) VALUES ($1, $2, 'x', $3, 'wo_api_abcde', ARRAY['adoption','usage','documents','documents_write','documents_delete','chat','adoption'], now() + interval '30 days')`, [orgId, userId, '9'.repeat(64)]],
        ['INSERT INTO org_api_key_calls (key_id, organization_id, endpoint, http_status) VALUES ($1, $2, $3, 200)', [k.id, orgId, 'documents-purge']],
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
