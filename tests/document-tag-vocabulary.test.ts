import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import pg from 'pg';
import { randomUUID } from 'crypto';
import type { ActorScope } from '@/lib/agent-permissions';

/** 기관 태그 분류표(0061, 2026-11-05) — 표기 맞추기, '분류표의 태그만', 기관 전체 관리자만 고침, 동시 저장 충돌 */

const state = vi.hoisted(() => ({
  actor: null as unknown,
  admin: true,
  vocab: null as Record<string, unknown> | null,
  vocabError: false,
  doc: null as Record<string, unknown> | null,
  ops: [] as { table: string; op: string; values?: unknown; filters: [string, unknown][] }[],
  updateRow: null as Record<string, unknown> | null,
  insertError: null as Record<string, unknown> | null,
}));

vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => ({ user: { id: 'u1' } }), isAdminSession: () => state.admin }));
vi.mock('@/lib/actor-scope', () => ({ getActorScope: async () => state.actor }));
vi.mock('@/lib/agent-store', () => ({ loadAgentAccess: async () => null }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const rec: { table: string; op: string; values?: unknown; filters: [string, unknown][] } = { table, op: 'select', filters: [] };
      state.ops.push(rec);
      const q: Record<string, unknown> = {};
      const result = () => {
        if (table === 'document_tag_vocabularies') {
          if (rec.op === 'select') return state.vocabError ? { data: null, error: { code: 'XX000' } } : { data: state.vocab, error: null };
          if (rec.op === 'insert') return state.insertError ? { data: null, error: state.insertError } : { data: { ...(rec.values as object) }, error: null };
          if (rec.op === 'update') return { data: state.updateRow, error: null };
        }
        if (table === 'documents') {
          if (rec.op === 'select') return { data: state.doc, error: null };
          if (rec.op === 'update') return { data: { id: state.doc?.id, tags: (rec.values as { tags: string[] }).tags }, error: null };
        }
        return { data: null, error: null };
      };
      Object.assign(q, {
        select: () => q,
        eq: (col: string, v: unknown) => { rec.filters.push([col, v]); return q; },
        insert: (values: unknown) => { rec.op = 'insert'; rec.values = values; return q; },
        update: (values: unknown) => { rec.op = 'update'; rec.values = values; return q; },
        maybeSingle: () => Promise.resolve(result()),
        single: () => Promise.resolve(result()),
      });
      return q;
    },
  },
}));

import { GET, PUT } from '@/app/api/documents/tag-vocabulary/route';
import { PATCH } from '@/app/api/documents/[id]/route';
import { applyVocabulary, normalizeVocabulary, tagsOutsideVocabulary, MAX_VOCABULARY_TAGS } from '@/lib/document-tags';
import { parseTagSuggestions, suggestVocabulary } from '@/lib/document-tag-suggest';

const DOC = '11111111-0000-4000-8000-000000000001';
const T0 = '2026-11-05T01:00:00.000Z';
const wholeAdmin: ActorScope = { userId: 'u1', isAdmin: true, departmentId: 'd1', organizationId: 'org', visibleDepartmentIds: ['d1'], managedDepartmentIds: ['d1'], managesWholeOrganization: true };

const put = async (body: unknown) => {
  const res = await PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }) as never);
  return { status: res.status, body: await res.json() };
};
const patch = async (tags: unknown) => {
  const res = await PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ tags }) }) as never, { params: { id: DOC } });
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  state.actor = wholeAdmin; state.admin = true; state.vocab = null; state.vocabError = false; state.ops = []; state.updateRow = null; state.insertError = null;
  state.doc = { id: DOC, agent_id: null, department_id: 'd1', organization_id: 'org', visibility: 'organization' };
});

describe('분류표 다듬기·맞추기', () => {
  it('줄바꿈·쉼표로 받고 겹친 것은 처음 것만, 100개·20자를 넘으면 거절', () => {
    expect(normalizeVocabulary('여비\n#복무, 계약\n여비\n\n', false)).toEqual({ ok: true, vocabulary: { tags: ['여비', '복무', '계약'], restricted: false } });
    expect(normalizeVocabulary(Array.from({ length: MAX_VOCABULARY_TAGS + 1 }, (_, i) => `t${i}`), false).ok).toBe(false);
    expect(normalizeVocabulary(['가'.repeat(21)], false).ok).toBe(false);
    expect(normalizeVocabulary([], true)).toMatchObject({ ok: false });
    expect(normalizeVocabulary([], 'yes')).toMatchObject({ ok: false });
  });

  it('분류표 표기로 맞추고, 분류표의 태그만이면 밖의 태그를 알리며 거절', () => {
    const vocab = { tags: ['PDF', '여비'], restricted: false };
    expect(applyVocabulary(['pdf', '복무', 'Pdf'], vocab)).toEqual({ ok: true, tags: ['PDF', '복무'] });
    expect(applyVocabulary(['pdf', '복무'], { ...vocab, restricted: true })).toMatchObject({ ok: false, outside: ['복무'] });
    expect(applyVocabulary([], { ...vocab, restricted: true })).toEqual({ ok: true, tags: [] });
  });

  it('쓰였지만 분류표에 없는 태그(많이 쓴 순)', () => {
    const docs = [{ file_name: 'a', noda_status: 'ready', tags: ['여비', '복무'] }, { file_name: 'b', noda_status: 'ready', tags: ['복무', 'pdf'] }];
    expect(tagsOutsideVocabulary(docs, ['여비', 'PDF'])).toEqual([{ tag: '복무', count: 2 }]);
  });

  it('AI 초안 목록 — 분류표 먼저·쓰는 태그 잇기, 분류표만이면 분류표만, only면 밖의 답 버림', () => {
    expect(suggestVocabulary(['출장여비'], ['여비', '출장여비'], false)).toEqual(['출장여비', '여비']);
    expect(suggestVocabulary(['출장여비'], ['여비'], true)).toEqual(['출장여비']);
    expect(suggestVocabulary(Array.from({ length: 50 }, (_, i) => `c${i}`), ['여비'], false)).toHaveLength(50);
    expect(parseTagSuggestions('["출장여비", "복무"]', ['출장여비'], true)).toEqual(['출장여비']);
  });
});

describe('분류표 API', () => {
  it('GET — 같은 기관 누구나 보고, 고칠 수 있는지는 기관 전체 관리자만 참', async () => {
    state.actor = { ...wholeAdmin, isAdmin: false, managesWholeOrganization: false };
    const res = await (await GET()).json();
    expect(res).toEqual({ ok: true, data: { tags: [], restricted: false, updatedAt: null, canEdit: false } });
  });

  it('PUT — 관리자가 아니거나 기관 전체 관리자가 아니면 403, 쓰지 않는다', async () => {
    state.admin = false;
    expect((await put({ tags: ['여비'], restricted: false, baseUpdatedAt: null })).status).toBe(403);
    state.admin = true;
    state.actor = { ...wholeAdmin, managesWholeOrganization: false };
    expect((await put({ tags: ['여비'], restricted: false, baseUpdatedAt: null })).status).toBe(403);
    expect(state.ops.filter((o) => o.op !== 'select')).toHaveLength(0);
  });

  it('PUT — 처음엔 새 행(기관 한정), 동시에 처음 저장하면 409', async () => {
    const r = await put({ tags: '여비\n복무', restricted: true, baseUpdatedAt: null });
    expect(r.status).toBe(200);
    const ins = state.ops.find((o) => o.op === 'insert')!;
    expect(ins.values).toMatchObject({ organization_id: 'org', tags: ['여비', '복무'], restricted: true, updated_by: 'u1' });
    state.insertError = { code: '23505' };
    expect((await put({ tags: ['여비'], restricted: false, baseUpdatedAt: null })).body.error.code).toBe('conflict');
  });

  it('PUT — 고칠 때는 읽은 시각을 기준으로 조건부, 기준이 다르거나 그 사이 바뀌면 409', async () => {
    state.vocab = { tags: ['여비'], restricted: false, updated_at: T0 };
    expect((await put({ tags: ['여비'], restricted: false, baseUpdatedAt: null })).status).toBe(409);
    expect((await put({ tags: ['여비'], restricted: false, baseUpdatedAt: '2026-11-04T00:00:00.000Z' })).status).toBe(409);
    state.ops = [];
    state.updateRow = null; // 조건에 맞는 행이 없다 = 그 사이 바뀜
    expect((await put({ tags: ['여비'], restricted: false, baseUpdatedAt: T0 })).status).toBe(409);
    const upd = state.ops.find((o) => o.op === 'update')!;
    expect(upd.filters).toEqual([['organization_id', 'org'], ['updated_at', T0]]);
    state.updateRow = { tags: ['여비', '복무'], restricted: false, updated_at: '2026-11-05T02:00:00.000Z' };
    expect((await put({ tags: ['여비', '복무'], restricted: false, baseUpdatedAt: T0 })).body).toMatchObject({ ok: true, data: { tags: ['여비', '복무'] } });
  });

  it('PUT — 빈 분류표로 분류표의 태그만을 켜면 400', async () => {
    expect((await put({ tags: [], restricted: true, baseUpdatedAt: null })).status).toBe(400);
  });
});

describe('태그 저장이 분류표를 따른다', () => {
  it('분류표 표기로 맞춰 저장한다', async () => {
    state.vocab = { tags: ['PDF', '여비'], restricted: false, updated_at: T0 };
    const r = await patch(['pdf', '복무']);
    expect(r.body).toMatchObject({ ok: true, data: { tags: ['PDF', '복무'] } });
  });

  it('분류표의 태그만이면 밖의 태그는 400(outside 목록), 저장하지 않는다', async () => {
    state.vocab = { tags: ['여비'], restricted: true, updated_at: T0 };
    const r = await patch(['여비', '복무']);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: 'outside_vocabulary', outside: ['복무'] });
    expect(state.ops.some((o) => o.table === 'documents' && o.op === 'update')).toBe(false);
  });

  it('분류표를 못 읽으면 저장하지 않는다(제한을 건너뛰지 않음)', async () => {
    state.vocabError = true;
    expect((await patch(['여비'])).status).toBe(500);
    expect(state.ops.some((o) => o.table === 'documents' && o.op === 'update')).toBe(false);
  });
});

describe('연결 (원본)', () => {
  it('화면 — 분류표 칸·분류표 칩으로 더하기·저장 전에 분류표로 먼저 봄', () => {
    const ui = readFileSync('src/components/admin/DocumentsManager.tsx', 'utf8');
    expect(ui).toContain('<TagVocabularyPanel');
    expect(ui).toContain('aria-label="분류표에서 더하기"');
    expect(ui).toContain('applyVocabulary(checked.tags, vocab)');
    const panel = readFileSync('src/components/admin/TagVocabularyPanel.tsx', 'utf8');
    expect(panel).toContain('baseUpdatedAt: vocabulary.updatedAt');
    expect(panel).toContain("result?.error?.code === 'conflict'");
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;

describe.skipIf(!url)('분류표 표 (0061, 시험 DB)', () => {
  let db: pg.Client;
  const orgId = randomUUID();
  const sql = () => readFileSync('supabase/migrations/0061_document_tag_vocabulary.sql', 'utf8');

  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
    await db.query(sql());
    await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, `기관-${orgId.slice(0, 6)}`]);
  });
  afterAll(async () => {
    await db?.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    await db?.end();
  });

  it('다시 적용해도 안전, 기관마다 한 행, 빈 분류표로 켜기·100개 넘기를 DB가 막는다', async () => {
    await db.query(sql());
    await db.query('INSERT INTO document_tag_vocabularies (organization_id, tags) VALUES ($1, $2)', [orgId, ['여비']]);
    await expect(db.query('INSERT INTO document_tag_vocabularies (organization_id) VALUES ($1)', [orgId])).rejects.toMatchObject({ code: '23505' });
    await expect(db.query("UPDATE document_tag_vocabularies SET tags = '{}', restricted = true WHERE organization_id = $1", [orgId])).rejects.toMatchObject({ code: '23514' });
    await expect(db.query('UPDATE document_tag_vocabularies SET tags = $2 WHERE organization_id = $1', [orgId, Array.from({ length: 101 }, (_, i) => `t${i}`)])).rejects.toMatchObject({ code: '23514' });
    const row = await db.query('SELECT restricted FROM document_tag_vocabularies WHERE organization_id = $1', [orgId]);
    expect(row.rows[0].restricted).toBe(false);
    const rls = await db.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'document_tag_vocabularies'");
    expect(rls.rows[0].relrowsecurity).toBe(true);
  });
});
