import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { filterDocuments, normalizeDocumentTags, tagCounts, MAX_DOCUMENT_TAGS, MAX_TAG_CHARS } from '@/lib/document-tags';
import { buildAssignedDocumentRow, ASSIGN_SOURCE_COLUMNS } from '@/lib/document-files';

/** 비서 문서의 태그(0060, 2026-11-05)와 문서 목록 찾기·거르기 */

describe('태그 다듬기', () => {
  it('쉼표 글이나 배열을 받아 다듬고 겹친 것(대소문자 무시)은 처음 것만', () => {
    expect(normalizeDocumentTags(' 여비 ,#복무,  2026  개정 ,여비, PDF, pdf ,')).toEqual({ ok: true, tags: ['여비', '복무', '2026 개정', 'PDF'] });
    expect(normalizeDocumentTags(['인사​', '\u0007감사'])).toEqual({ ok: true, tags: ['인사', '감사'] });
    expect(normalizeDocumentTags([])).toEqual({ ok: true, tags: [] });
    expect(normalizeDocumentTags('')).toEqual({ ok: true, tags: [] });
  });
  it('길거나 많으면 거절한다 — 조용히 자르지 않는다', () => {
    expect(normalizeDocumentTags(['가'.repeat(MAX_TAG_CHARS + 1)]).ok).toBe(false);
    expect(normalizeDocumentTags(Array.from({ length: MAX_DOCUMENT_TAGS + 1 }, (_, i) => `t${i}`)).ok).toBe(false);
    expect(normalizeDocumentTags(Array.from({ length: MAX_DOCUMENT_TAGS }, (_, i) => `t${i}`)).ok).toBe(true);
    expect(normalizeDocumentTags([1, 2]).ok).toBe(false);
    expect(normalizeDocumentTags(null).ok).toBe(false);
  });
});

describe('목록 찾기·거르기', () => {
  const docs = [
    { id: '1', title: '여비 규정', file_name: 'a.hwpx', agent_id: 'A', noda_status: 'ready', retired_at: null, tags: ['여비', '2026'] },
    { id: '2', title: '여비 규정(2025)', file_name: 'b.hwpx', agent_id: 'A', noda_status: 'retired', retired_at: '2026-01-01', tags: ['여비'] },
    { id: '3', title: null, file_name: '복무 지침.pdf', agent_id: 'B', noda_status: 'failed', retired_at: null, tags: [] },
    { id: '4', title: '감사 편람', file_name: 'c.pdf', agent_id: 'B', noda_status: 'reading', retired_at: null },
  ];
  const ids = (f: Parameters<typeof filterDocuments>[1]) => filterDocuments(docs, f).map((d) => d.id);

  it('이름·파일 이름·태그에서 찾고, 띄어 쓴 낱말은 모두 들어 있어야 한다', () => {
    expect(ids({ q: '여비' })).toEqual(['1', '2']);
    expect(ids({ q: '복무' })).toEqual(['3']);
    expect(ids({ q: '여비 2026' })).toEqual(['1']);
    expect(ids({ q: '  ' })).toEqual(['1', '2', '3', '4']);
  });
  it('비서·상태·태그로 거르고 조건은 모두 만족해야 한다', () => {
    expect(ids({ agentId: 'B' })).toEqual(['3', '4']);
    expect(ids({ status: 'ready' })).toEqual(['1']);
    expect(ids({ status: 'retired' })).toEqual(['2']);
    expect(ids({ status: 'problem' })).toEqual(['3']);
    expect(ids({ status: 'reading' })).toEqual(['4']);
    expect(ids({ tag: '여비' })).toEqual(['1', '2']);
    expect(ids({ tag: '여비', status: 'ready' })).toEqual(['1']);
  });
  it('태그 목록은 많이 쓴 순', () => {
    expect(tagCounts(docs)).toEqual([{ tag: '여비', count: 2 }, { tag: '2026', count: 1 }]);
  });
});

describe('연결 (원본)', () => {
  const route = readFileSync('src/app/api/documents/[id]/route.ts', 'utf8');
  const list = readFileSync('src/app/api/documents/route.ts', 'utf8');
  const ui = readFileSync('src/components/admin/DocumentsManager.tsx', 'utf8');

  it('태그 고치기 — 로그인·기관 한정·볼 수 있는 문서·비서를 고칠 수 있거나 부서를 관리하는 사람만', () => {
    expect(route).toContain('getServerAuthSession');
    expect(route).toContain(".eq('organization_id', actor.organizationId)");
    expect(route).toContain('await documentTagAccess(doc, actor)');
    const access = readFileSync('src/lib/document-tag-access.ts', 'utf8');
    expect(access).toContain('canReadDocument(doc, actor)');
    expect(access).toContain('actor.isAdmin && actor.managedDepartmentIds.includes(doc.department_id)');
    expect(access).toContain('canEditAgent(agent, actor)');
    expect(route).toContain('normalizeDocumentTags(body.tags)');
  });
  it('목록이 태그를 읽고, 다른 비서에 붙일 때 태그를 옮긴다', () => {
    expect(list).toContain('effective_from, tags');
    expect(ASSIGN_SOURCE_COLUMNS).toContain('tags');
    const row = buildAssignedDocumentRow(
      { id: 's', department_id: 'd', organization_id: 'o', visibility: 'organization', uploaded_by: null, storage_path: 'p', file_name: 'a.pdf', file_type: 'pdf', title: 't', tags: ['여비'] },
      { id: 'aaaaaaaa-0000-4000-8000-000000000001', tier: 'official', department_id: 'd' } as never,
      'bbbbbbbb-0000-4000-8000-000000000001',
      new Date()
    );
    expect(row.tags).toEqual(['여비']);
    // 태그가 없던 원본도 칸은 있다(배치 insert의 키 집합이 같게)
    const bare = buildAssignedDocumentRow(
      { id: 's', department_id: 'd', organization_id: 'o', visibility: 'organization', uploaded_by: null, storage_path: 'p', file_name: 'a.pdf', file_type: 'pdf', title: 't' },
      { id: 'aaaaaaaa-0000-4000-8000-000000000001', tier: 'official', department_id: 'd' } as never,
      'bbbbbbbb-0000-4000-8000-000000000002',
      new Date()
    );
    expect(Object.keys(bare).sort()).toEqual(Object.keys(row).sort());
    expect(bare.tags).toEqual([]);
  });
  it('화면 — 찾기·거르기 칸, 태그 칩을 누르면 그 태그로 거른다, 저장 전에 다듬어 본다', () => {
    expect(ui).toContain('filterDocuments(documents, filter).map((doc) => (');
    expect(ui).toContain('aria-label="태그로 거르기"');
    expect(ui).toContain('onClick={() => setFilter((f) => ({ ...f, tag: t }))}');
    expect(ui).toContain('normalizeDocumentTags(tagEdit.text)');
    expect(readFileSync('src/lib/document-tags.ts', 'utf8')).not.toMatch(/^import /m);
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;

describe.skipIf(!url)('태그 칸 (0060, 시험 DB)', () => {
  let db: pg.Client;
  const orgId = randomUUID();
  const deptId = randomUUID();

  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
    await db.query(readFileSync('supabase/migrations/0060_document_tags.sql', 'utf8'));
    await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, `기관-${orgId.slice(0, 6)}`]);
    await db.query('INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)', [deptId, '총무과', `d-${deptId.slice(0, 8)}`, orgId]);
  });
  afterAll(async () => {
    await db?.query('DELETE FROM documents WHERE department_id = $1', [deptId]);
    await db?.query('DELETE FROM departments WHERE id = $1', [deptId]);
    await db?.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    await db?.end();
  });

  const insert = (tags?: string[]) =>
    db.query(
      `INSERT INTO documents (department_id, storage_path, file_name, metadata${tags ? ', tags' : ''}) VALUES ($1, 'p', 'a.pdf', '{}'${tags ? ', $2' : ''}) RETURNING tags`,
      tags ? [deptId, tags] : [deptId]
    );

  it('기존·새 행은 빈 배열, 다시 적용해도 안전, 10개를 넘으면 DB가 막는다', async () => {
    await db.query(readFileSync('supabase/migrations/0060_document_tags.sql', 'utf8'));
    expect((await insert()).rows[0].tags).toEqual([]);
    expect((await insert(['여비', '복무'])).rows[0].tags).toEqual(['여비', '복무']);
    await expect(insert(Array.from({ length: 11 }, (_, i) => `t${i}`))).rejects.toMatchObject({ code: '23514' });
    const nullable = await db.query("SELECT is_nullable FROM information_schema.columns WHERE table_name = 'documents' AND column_name = 'tags'");
    expect(nullable.rows[0].is_nullable).toBe('NO');
  });
});
