import { readFileSync } from 'fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { sourceEffectiveLabel } from '@/components/chat/source-label';
import { adminCommonList, type CommonLibraryRow } from '@/lib/common-library-admin';
import { compareEndpoint } from '@/components/admin/EditionCompareModal';

/**
 * 2026-11-12 묶음 — ① 앱 실행 현황이 시험 판 실행을 세지 않음(0089) ② 근거 칩의 시행일 ③ 기관 관리자의 공통 기준 문서 '옛 판과 비교'
 */

describe('근거 칩의 시행일', () => {
  it('기관 문서 판의 시행일만 공문 날짜 꼴로, 공통 자료실·꼴이 틀린 값은 빈 글', () => {
    expect(sourceEffectiveLabel({ effectiveFrom: '2026-01-01' })).toBe('시행 2026.1.1.');
    expect(sourceEffectiveLabel({ effectiveFrom: '2026-11-30' })).toBe('시행 2026.11.30.');
    expect(sourceEffectiveLabel({ scope: 'common', effectiveFrom: '2026-01-01' })).toBe('');
    expect(sourceEffectiveLabel({})).toBe('');
    expect(sourceEffectiveLabel({ effectiveFrom: '2026-1-1' })).toBe('');
    expect(sourceEffectiveLabel({ effectiveFrom: '<b>x</b>' })).toBe('');
  });
  it('칩이 시행일을 보이고 마우스 글에도 싣는다', () => {
    const chip = readFileSync('src/components/chat/SourceCitation.tsx', 'utf8');
    expect(chip).toContain('const effective = sourceEffectiveLabel(source);');
    expect(chip).toContain('{effective && <span className="text-slate-400 flex-shrink-0">{effective}</span>}');
  });
});

describe('기관 관리자 공통 기준 문서 비교', () => {
  const row = (over: Partial<CommonLibraryRow>): CommonLibraryRow => ({
    id: '11111111-1111-4111-8111-111111111111', org_type: '지방자치단체', title: '예산편성기준', edition_year: 2026, usage_terms: '공공누리 1유형',
    file_name: 'a.pdf', size_bytes: 1, noda_status: 'ready', retired_at: null, replaces_id: null, created_at: '2026-11-01T00:00:00Z', ...over,
  });
  it('바꾼 옛 판이 있는 현재 판만 비교 단추', () => {
    const list = adminCommonList('지방자치단체', [
      row({}),
      row({ id: '22222222-2222-4222-8222-222222222222', title: '회계기준', replaces_id: '33333333-3333-4333-8333-333333333333' }),
    ]);
    expect(list.documents.map((d) => [d.title, d.hasPreviousEdition])).toEqual([['예산편성기준', false], ['회계기준', true]]);
  });
  it('주소 — 관리자 전용 길', () => {
    expect(compareEndpoint('admin-common', 'x')).toBe('/api/admin/common-documents/x/compare');
    expect(compareEndpoint('common', 'x')).toBe('/api/super/common-documents/x/compare');
    expect(compareEndpoint('documents', 'x')).toBe('/api/documents/x/compare');
  });
  it('연결(원본) — 관리자 검사·이 기관 유형의 행만·화면 단추', () => {
    const route = readFileSync('src/app/api/admin/common-documents/[id]/compare/route.ts', 'utf8');
    expect(route).toContain('if (!isAdminSession(session)) return jsonError');
    expect(route).toContain(".eq('id', id).eq('org_type', orgType).maybeSingle()");
    expect(route).toContain('export const maxDuration = 300;');
    const panel = readFileSync('src/components/admin/CommonLibraryPanel.tsx', 'utf8');
    expect(panel).toContain("compareEndpoint('admin-common', compareId)");
    expect(panel).toContain('{d.hasPreviousEdition && (');
  });
});

describe('0089 원본', () => {
  it('시험 판 실행을 빼는 조건, 같은 반환·권한', () => {
    const sql = readFileSync('supabase/migrations/0089_app_run_states_no_drafts.sql', 'utf8');
    expect(sql).toContain("AND NOT coalesce(m.source_references ? 'app_draft', false)");
    expect(sql).toContain('RETURNS TABLE (agent_id uuid, created_at timestamptz, has_answer boolean, steps jsonb)');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.app_run_states(uuid[], timestamptz, int) TO service_role;');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.app_run_states(uuid[], timestamptz, int) FROM PUBLIC, anon, authenticated;');
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('0089 app_run_states (시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
    const sql = readFileSync('supabase/migrations/0089_app_run_states_no_drafts.sql', 'utf8');
    await db.query(sql);
    await db.query(sql);
  });
  afterAll(async () => { await db?.end(); });
  it('시험 판 답변의 대화는 빼고, 지금 판 답변·답변 없는 실행은 센다', async () => {
    await db.query('BEGIN');
    try {
      const org = (await db.query("INSERT INTO organizations (name) VALUES ('0089 시험 기관') RETURNING id")).rows[0].id;
      const dept = (await db.query("INSERT INTO departments (name, slug, organization_id) VALUES ('총무과', 'run-0089', $1) RETURNING id", [org])).rows[0].id;
      const agent = (await db.query("INSERT INTO agents (name, department_id, organization_id, tier, visibility) VALUES ('시험 앱', $1, $2, 'official', 'organization') RETURNING id", [dept, org])).rows[0].id;
      const conv = async (refs: object | null) => {
        const id = (await db.query('INSERT INTO conversations (department_id, agent_id) VALUES ($1, $2) RETURNING id', [dept, agent])).rows[0].id;
        if (refs) await db.query("INSERT INTO messages (conversation_id, role, content, source_references) VALUES ($1, 'assistant', '결과', $2)", [id, JSON.stringify(refs)]);
        return id;
      };
      await conv({ app_steps: [{ name: '정리', status: 'done' }] });
      await conv({ app_steps: [{ name: '정리', status: 'failed' }], app_draft: { saved_at: '2026-11-11T00:00:00Z' } });
      await conv(null);
      const r = await db.query("SELECT has_answer, steps FROM app_run_states($1, now() - interval '1 day', 100) ORDER BY has_answer DESC", [[agent]]);
      expect(r.rows).toEqual([
        { has_answer: true, steps: [{ name: '정리', status: 'done' }] },
        { has_answer: false, steps: null },
      ]);
      const priv = await db.query("SELECT has_function_privilege('anon', 'public.app_run_states(uuid[], timestamptz, int)', 'EXECUTE') a, has_function_privilege('service_role', 'public.app_run_states(uuid[], timestamptz, int)', 'EXECUTE') s");
      expect(priv.rows[0]).toEqual({ a: false, s: true });
    } finally { await db.query('ROLLBACK'); }
  });
});
