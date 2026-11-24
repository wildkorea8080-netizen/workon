import { readFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * 2026-11-23 — 기관 API의 문서함 목록(0099, 범위 documents, `GET /api/v1/documents`).
 * 기관 문서관리시스템이 WORKON 문서함과 맞대 볼 수 있게: 읽기 상태·까닭·판·시행일·지금 근거로 쓰는지·태그.
 * 본문·요약·원본 경로·NODA 파일 이름·올린 사람은 없고, 나만의 비서·지운 비서의 문서는 내지 않는다.
 */

type Call = [string, ...unknown[]];
const state = vi.hoisted(() => ({
  queries: [] as { table: string; calls: Call[] }[],
  docs: { data: [] as unknown[], error: null as unknown },
  successors: { data: [] as unknown[], error: null as unknown },
  depts: { data: [] as unknown[], error: null as unknown },
}));
vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {
  from(table: string) {
    const record = { table, calls: [] as Call[] };
    state.queries.push(record);
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'is', 'or', 'order', 'limit']) q[m] = (...args: unknown[]) => { record.calls.push([m, ...args]); return q; };
    q.then = (resolve: (r: unknown) => unknown) => {
      if (table === 'departments') return resolve(state.depts);
      const isSuccessor = record.calls.some((c) => c[0] === 'in' && c[1] === 'replaces_id');
      return resolve(isSuccessor ? state.successors : state.docs);
    };
    return q;
  },
} }));

import { documentsReport, hiddenFromOrgApi } from '@/lib/org-api/documents';
import { ORG_API_DOC_STATUSES, ORG_API_ENDPOINTS, ORG_API_SCOPES, docStatusOf, parseCreateKey, parseDocListQuery } from '@/lib/org-api/spec';
import { encodeHistoryCursor } from '@/lib/apps/history';
import { generateOrgApiToken, handleOrgApiCall, hashOrgApiToken, type OrgApiDeps } from '@/lib/org-api/keys';

const ctx = { keyId: 'k1', organizationId: 'org', departmentIds: ['top', 'child'], creatorId: 'u-admin', creatorDepartmentId: 'top' };
const NOW = Date.parse('2026-11-23T03:00:00Z'); // KST 2026-11-23
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const agent = (tier: string, deleted_at: string | null = null) => ({ id: 'ag', name: tier === 'personal' ? '김주무관의 비서' : '규정 비서', tier, deleted_at });
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, file_name: `${id.slice(0, 4)}.pdf`, title: null, file_type: 'pdf', agent_id: 'ag', department_id: 'top',
  noda_status: 'ready', noda_reason: null, noda_read_at: '2026-11-01T00:00:00Z', replaces_id: null, retired_at: null, effective_from: null,
  tags: ['복무'], created_at: `2026-11-0${id[0]}T00:00:00.000Z`, agent: agent('official'), ...over,
});
const params = (over: Record<string, string | null> = {}) => ({ status: null, agent: null, cursor: null, limit: null, ...over });
const docQuery = () => state.queries.find((q) => q.table === 'documents' && !q.calls.some((c) => c[0] === 'in' && c[1] === 'replaces_id'))!;
const has = (q: { calls: Call[] }, ...call: unknown[]) => q.calls.some((c) => JSON.stringify(c) === JSON.stringify(call));

beforeEach(() => {
  state.queries = [];
  state.docs = { data: [], error: null };
  state.successors = { data: [], error: null };
  state.depts = { data: [{ id: 'top', name: '총무과' }], error: null };
});

describe('범위·끝점·요청 검사', () => {
  it('키 범위에 documents가 있고 끝점은 그 범위로', () => {
    expect(ORG_API_SCOPES).toContain('documents');
    expect(ORG_API_ENDPOINTS.documents).toMatchObject({ scope: 'documents' });
    expect(ORG_API_ENDPOINTS.documents.path.startsWith('/api/v1/documents')).toBe(true);
    expect(parseCreateKey({ name: '문서관리', scopes: ['documents', 'usage'], days: 30 })).toEqual({ ok: true, value: { name: '문서관리', scopes: ['usage', 'documents'], days: 30 } });
  });
  it('상태 이름 — NULL은 legacy, 모르는 값도 legacy로(꾸미지 않음)', () => {
    expect(docStatusOf(null)).toBe('legacy');
    expect(docStatusOf('ready')).toBe('ready');
    expect(docStatusOf('retired')).toBe('retired');
    expect(docStatusOf('weird')).toBe('legacy');
  });
  it('틀린 거르기는 기본값으로 바꾸지 않고 400', () => {
    expect(parseDocListQuery(params({ status: 'done' }))).toMatchObject({ ok: false });
    expect(parseDocListQuery(params({ agent: 'abc' }))).toMatchObject({ ok: false });
    for (const limit of ['0', '201', '1.5', '-3', 'x']) expect(parseDocListQuery(params({ limit }))).toMatchObject({ ok: false });
    expect(parseDocListQuery(params({ status: 'failed', agent: A.toUpperCase(), limit: '200' }))).toEqual({ ok: true, value: { status: 'failed', agentId: A, cursor: null, limit: 200 } });
    expect(parseDocListQuery(params())).toEqual({ ok: true, value: { status: null, agentId: null, cursor: null, limit: 100 } });
    for (const s of ORG_API_DOC_STATUSES) expect(parseDocListQuery(params({ status: s }))).toMatchObject({ ok: true });
  });
});

describe('documentsReport', () => {
  it('기관·관리 범위 부서로, 본문·원본·올린 사람 칸은 읽지도 내지도 않는다', async () => {
    state.docs = { data: [row(A)], error: null };
    const out = await documentsReport(ctx, params(), NOW) as { data: { documents: Record<string, unknown>[]; next: string | null } };
    const q = docQuery();
    expect(has(q, 'eq', 'organization_id', 'org')).toBe(true);
    expect(has(q, 'in', 'department_id', ['top', 'child'])).toBe(true);
    expect(has(q, 'limit', 101)).toBe(true);
    const select = String(q.calls.find((c) => c[0] === 'select')![1]);
    for (const col of ['summary', 'storage_path', 'noda_filename', 'uploaded_by', 'metadata', 'noda_doc_id']) expect(select).not.toMatch(new RegExp(`\\b${col}\\b`));
    const doc = out.data.documents[0];
    expect(doc).toMatchObject({ id: A, title: `${A.slice(0, 4)}.pdf`, agent: { id: 'ag', name: '규정 비서' }, departmentName: '총무과', status: 'ready', citable: true, tags: ['복무'], reason: null });
    expect(Object.keys(doc).sort()).toEqual(['agent', 'citable', 'createdAt', 'departmentId', 'departmentName', 'edition', 'fileName', 'fileType', 'id', 'readAt', 'reason', 'status', 'tags', 'title']);
    expect(out.data.next).toBeNull();
  });

  it('나만의 비서·지운 비서의 문서는 내지 않는다(비서 없는 옛 문서는 낸다)', async () => {
    state.docs = { data: [row(A, { agent: agent('personal') }), row(B, { agent: agent('department', '2026-11-20T00:00:00Z') }), row(C, { agent_id: null, agent: null, noda_status: null }), row(D, { agent: null })], error: null };
    const out = await documentsReport(ctx, params(), NOW) as { data: { documents: { id: string; status: string; agent: unknown }[] } };
    expect(out.data.documents.map((d) => d.id)).toEqual([C]);
    expect(out.data.documents[0]).toMatchObject({ status: 'legacy', agent: null });
    expect(JSON.stringify(out)).not.toContain('김주무관');
    expect(hiddenFromOrgApi(row(A, { agent: [agent('official')] }) as never)).toBe(false);
  });

  it('판 — 시행 중인 읽힌 새 판이 대신하면 옛 판은 근거 아님(replacedById), 시행일 전인 새 판은 근거 아님', async () => {
    state.docs = { data: [row(A), row(B, { replaces_id: C, effective_from: '2026-12-01' }), row(C)], error: null };
    state.successors = { data: [
      { id: D, noda_status: 'ready', replaces_id: A, effective_from: '2026-11-01' },
      { id: B, noda_status: 'ready', replaces_id: C, effective_from: '2026-12-01' },
    ], error: null };
    const out = await documentsReport(ctx, params(), NOW) as { data: { documents: { id: string; citable: boolean; edition: Record<string, unknown> }[] } };
    const by = Object.fromEntries(out.data.documents.map((d) => [d.id, d]));
    expect(by[A]).toMatchObject({ citable: false, edition: { replacedById: D } });
    expect(by[B]).toMatchObject({ citable: false, edition: { replacesId: C, effectiveFrom: '2026-12-01' } });
    expect(by[C]).toMatchObject({ citable: true, edition: { replacedById: B } });
    expect(has(state.queries.find((q) => q.calls.some((c) => c[0] === 'in' && c[1] === 'replaces_id'))!, 'eq', 'organization_id', 'org')).toBe(true);
  });

  it('읽지 못한 까닭은 실패·못 읽음에만, 읽는 중은 근거 아님', async () => {
    state.docs = { data: [row(A, { noda_status: 'unreadable', noda_reason: '암호가 걸린 파일' }), row(B, { noda_status: 'reading', noda_reason: '옛 까닭' })], error: null };
    const out = await documentsReport(ctx, params(), NOW) as { data: { documents: { status: string; reason: string | null; citable: boolean }[] } };
    expect(out.data.documents).toMatchObject([{ status: 'unreadable', reason: '암호가 걸린 파일', citable: false }, { status: 'reading', reason: null, citable: false }]);
  });

  it('거르기·쪽 넘기기 — legacy는 NULL, 다음 쪽은 읽은 마지막 행(숨긴 행이어도) 뒤부터', async () => {
    state.docs = { data: [row(A), row(B, { agent: agent('personal') }), row(C)], error: null };
    const out = await documentsReport(ctx, params({ limit: '2', status: 'legacy', agent: A }), NOW) as { data: { documents: { id: string }[]; next: string } };
    const q = docQuery();
    expect(has(q, 'is', 'noda_status', null)).toBe(true);
    expect(has(q, 'eq', 'agent_id', A)).toBe(true);
    expect(out.data.documents.map((d) => d.id)).toEqual([A]);
    expect(out.data.next).toBe(encodeHistoryCursor(row(B).created_at, B));

    state.queries = [];
    state.docs = { data: [], error: null };
    await documentsReport(ctx, params({ status: 'failed', cursor: out.data.next }), NOW);
    expect(has(docQuery(), 'eq', 'noda_status', 'failed')).toBe(true);
    expect(has(docQuery(), 'or', `created_at.gt.${row(B).created_at},and(created_at.eq.${row(B).created_at},id.gt.${B})`)).toBe(true);
  });

  it('틀린 cursor는 400(읽지 않음), 판·부서 읽기 실패는 던진다(꾸민 판정 없음)', async () => {
    expect(await documentsReport(ctx, params({ cursor: 'zzz' }), NOW)).toMatchObject({ status: 400 });
    expect(state.queries).toHaveLength(0);
    state.docs = { data: [row(A)], error: null };
    state.successors = { data: [], error: { message: 'boom' } };
    await expect(documentsReport(ctx, params(), NOW)).rejects.toThrow(/editions/);
    state.successors = { data: [], error: null };
    state.depts = { data: [], error: { message: 'boom' } };
    await expect(documentsReport(ctx, params(), NOW)).rejects.toThrow(/departments/);
    state.docs = { data: [], error: { message: 'boom' } };
    await expect(documentsReport(ctx, params(), NOW)).rejects.toThrow(/documents/);
  });
});

describe('호출 확인 — 범위', () => {
  const token = generateOrgApiToken().token;
  const deps = (scopes: string[]): OrgApiDeps => ({
    claim: async (hash) => (hash === hashOrgApiToken(token) ? { ok: true as const, key: { id: 'k1', organization_id: 'org', created_by: 'u1', scopes } } : { ok: false as const, reason: 'invalid' as const }),
    loadCreator: async () => ({ id: 'u1', role: 'ADMIN', is_active: true, deleted_at: null, department_id: 'top' }),
    loadDepartment: async () => ({ organization_id: 'org', parent_id: null }),
    allowedIps: async () => null, orgStatus: async () => 'active',
    managedDepartmentIds: async () => ['top'], recordCall: async () => {}, now: () => NOW,
  });
  it('usage 키로는 문서함 목록을 못 읽고, documents 키로는 읽는다', async () => {
    const run = vi.fn(async () => ({ data: { documents: [] } }));
    expect((await handleOrgApiCall(deps(['adoption', 'usage']), { authorization: `Bearer ${token}`, ip: null }, 'documents', run)).status).toBe(403);
    expect(run).not.toHaveBeenCalled();
    expect((await handleOrgApiCall(deps(['documents']), { authorization: `Bearer ${token}`, ip: null }, 'documents', run)).status).toBe(200);
    expect((await handleOrgApiCall(deps(['documents']), { authorization: `Bearer ${token}`, ip: null }, 'usage-summary', run)).status).toBe(403);
  });
  it('라우트는 documents 끝점으로 같은 확인을 거친다', () => {
    const src = readFileSync('src/app/api/v1/documents/route.ts', 'utf8');
    expect(src).toContain("'documents', (ctx) => documentsReport(ctx,");
    expect(src).toContain('handleOrgApiCall(orgApiDeps()');
    expect(existsSync('supabase/migrations/0099_org_api_documents_scope.sql')).toBe(true);
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('0099 — 키 범위·호출 기록 CHECK(시험 DB)', () => {
  let db: pg.Client;
  const orgId = randomUUID(); const deptId = randomUUID(); const userId = randomUUID();
  const sql = readFileSync('supabase/migrations/0099_org_api_documents_scope.sql', 'utf8');
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('documents 범위·끝점은 받고 모르는 값은 거절, 여러 번 적용해도 안전', async () => {
    await db.query('BEGIN');
    try {
      // 트랜잭션 안에서 다시 건다 — 같은 시험 DB에서 0086을 다시 거는 시험과 겹쳐도 이 트랜잭션은 잠금을 쥔 채 본다
      await db.query(sql);
      await db.query(sql);
      await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, '0099 기관']);
      await db.query('INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)', [deptId, '기획', `d99-${deptId.slice(0, 6)}`, orgId]);
      await db.query('INSERT INTO users (id, email, department_id) VALUES ($1, $2, $3)', [userId, `${userId}@test.local`, deptId]);
      const { rows: [k] } = await db.query(
        `INSERT INTO org_api_keys (organization_id, created_by, name, token_hash, token_prefix, scopes, expires_at) VALUES ($1, $2, '문서관리', $3, 'wo_api_abcde', ARRAY['adoption','usage','documents'], now() + interval '30 days') RETURNING id`,
        [orgId, userId, 'b'.repeat(64)],
      );
      for (const e of ['documents', 'budget', 'adoption-report']) {
        await db.query('INSERT INTO org_api_key_calls (key_id, organization_id, endpoint, http_status) VALUES ($1, $2, $3, 200)', [k.id, orgId, e]);
      }
      for (const bad of [
        [`INSERT INTO org_api_keys (organization_id, created_by, name, token_hash, token_prefix, scopes, expires_at) VALUES ($1, $2, 'x', $3, 'wo_api_abcde', ARRAY['users'], now() + interval '30 days')`, [orgId, userId, 'c'.repeat(64)]],
        [`INSERT INTO org_api_keys (organization_id, created_by, name, token_hash, token_prefix, scopes, expires_at) VALUES ($1, $2, 'x', $3, 'wo_api_abcde', ARRAY[]::text[], now() + interval '30 days')`, [orgId, userId, 'd'.repeat(64)]],
        ['INSERT INTO org_api_key_calls (key_id, organization_id, endpoint, http_status) VALUES ($1, $2, $3, 200)', [k.id, orgId, 'users']],
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
