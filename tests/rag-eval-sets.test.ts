import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import pg from 'pg';
import { randomUUID } from 'crypto';
import type { ActorScope } from '@/lib/agent-permissions';
import { parseRagEvalSet } from '@/lib/rag-eval';
import { canChangeRagEvalSet, normalizeSetName, prepareRagEvalSet, RAG_EVAL_SET_NAME_MAX } from '@/lib/rag-eval-sets';

/**
 * 문서 찾기 일괄 평가의 이름 붙인 세트(0059, 2026-11-05). 세트는 기관 단위 — 같은 세트로 여러 비서를 잰다.
 * 세트 글은 서버가 다시 읽어 다듬은 꼴로만 저장한다.
 */

const SET = '질문\t기대 문서\t기대 쪽\n출장 일비는 하루 얼마인가요?\t여비 규정\t12\n점심 메뉴 추천해 줘\t\t';
const actor = (over: Partial<ActorScope> = {}): ActorScope => ({
  userId: 'u1', isAdmin: true, departmentId: 'd1', organizationId: 'o1', visibleDepartmentIds: ['d1'], managedDepartmentIds: ['d1'], managesWholeOrganization: false, ...over,
});

describe('세트 저장 검사', () => {
  it('이름을 다듬고 세트를 다시 읽은 꼴로 저장한다 — 다시 읽으면 같은 세트', () => {
    const r = prepareRagEvalSet({ name: '  여비​  기본\n질문 ', set: SET.replace(/\t/g, ',').replace('질문,기대 문서,기대 쪽\n', '') });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.name).toBe('여비 기본 질문');
    expect(r.count).toBe(2);
    expect(r.text.split('\n')[0]).toBe('질문\t기대 문서\t기대 쪽');
    const again = parseRagEvalSet(r.text);
    expect(again.ok && again.rows.map((x) => [x.question, x.expected, x.page])).toEqual([
      ['출장 일비는 하루 얼마인가요?', '여비 규정', 12],
      ['점심 메뉴 추천해 줘', null, null],
    ]);
  });

  it('이름이 비었거나 길면, 세트를 읽지 못하면 거절한다', () => {
    expect(prepareRagEvalSet({ name: ' ', set: SET })).toEqual({ ok: false, message: '세트 이름을 적어 주세요.' });
    expect(prepareRagEvalSet({ name: 'ㄱ'.repeat(RAG_EVAL_SET_NAME_MAX + 1), set: SET }).ok).toBe(false);
    expect(prepareRagEvalSet({ name: '이름', set: '' }).ok).toBe(false);
    expect(prepareRagEvalSet({ name: 3, set: SET }).ok).toBe(false);
    expect(normalizeSetName(null)).toBe('');
  });

  it('고치고 지우기는 만든 사람이나 기관 전체 관리자만', () => {
    expect(canChangeRagEvalSet({ created_by: 'u1' }, actor())).toBe(true);
    expect(canChangeRagEvalSet({ created_by: 'u2' }, actor())).toBe(false);
    expect(canChangeRagEvalSet({ created_by: 'u2' }, actor({ managesWholeOrganization: true }))).toBe(true);
    expect(canChangeRagEvalSet({ created_by: null }, actor({ managesWholeOrganization: true }))).toBe(true);
    expect(canChangeRagEvalSet({ created_by: 'u1' }, actor({ isAdmin: false }))).toBe(false);
  });
});

describe('라우트·화면 (원본)', () => {
  const route = readFileSync('src/app/api/admin/rag-eval/sets/route.ts', 'utf8');
  const ui = readFileSync('src/components/admin/RagEvalPanel.tsx', 'utf8');

  it('세 핸들러 모두 관리자 확인 뒤 기관으로 한정한다', () => {
    for (const m of ['GET', 'POST', 'DELETE']) {
      const at = route.indexOf(`export async function ${m}`);
      expect(route.slice(at, at + 300), m).toContain('isAdminSession(session)');
    }
    const queries = route.split("from('rag_eval_sets')").length - 1;
    const scoped = route.split(".eq('organization_id', actor.organizationId)").length - 1;
    // insert는 organization_id를 넣고, 나머지 조회·고침·지우기는 모두 기관으로 거른다
    expect(scoped).toBe(queries - 1);
    expect(route).toContain('organization_id: actor.organizationId, name: prepared.name');
  });

  it('같은 이름은 409로 묻고(동시 저장의 유일 색인 충돌도), 덮어쓰기·지우기는 권한을 본다', () => {
    expect(route).toContain("409, 'exists'");
    expect(route).toContain("error?.code === '23505'");
    expect((route.match(/canChangeRagEvalSet\(/g) ?? []).length).toBe(2);
  });

  it('화면 — 저장·불러오기·지우기, 같은 이름이면 덮어쓸지 묻는다', () => {
    expect(ui).toContain("'/api/admin/rag-eval/sets'");
    expect(ui).toContain("r.code === 'exists' && !overwrite && window.confirm(r.message)");
    expect(ui).toContain('aria-label="저장한 세트"');
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;

describe.skipIf(!url)('세트 표 (0059, 시험 DB)', () => {
  let db: pg.Client;
  const orgId = randomUUID();
  const otherOrg = randomUUID();

  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
    // 다시 적용해도 안전
    await db.query(readFileSync('supabase/migrations/0059_rag_eval_sets.sql', 'utf8'));
    await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2), ($3, $4)', [orgId, `기관-${orgId.slice(0, 6)}`, otherOrg, `기관-${otherOrg.slice(0, 6)}`]);
  });
  afterAll(async () => {
    await db?.query('DELETE FROM organizations WHERE id = ANY($1)', [[orgId, otherOrg]]);
    await db?.end();
  });

  const insert = (org: string, name: string, text = 'x', count = 1) =>
    db.query('INSERT INTO rag_eval_sets (organization_id, name, set_text, question_count) VALUES ($1, $2, $3, $4)', [org, name, text, count]);

  it('기관 안에서 이름은 하나, 다른 기관은 같은 이름을 쓸 수 있다', async () => {
    await insert(orgId, '여비 기본');
    await expect(insert(orgId, '여비 기본')).rejects.toMatchObject({ code: '23505' });
    await expect(insert(otherOrg, '여비 기본')).resolves.toBeTruthy();
  });

  it('이름 앞뒤 공백·빈 이름·61자·질문 수 범위 밖은 DB가 막는다', async () => {
    for (const bad of [[' 앞공백', 1], ['', 1], ['ㄱ'.repeat(61), 1], ['질문수', 0], ['질문수2', 51]] as const) {
      await expect(insert(orgId, bad[0], 'x', bad[1])).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('기관을 지우면 세트도 지워지고, RLS가 켜져 있고 anon·authenticated는 권한이 없다', async () => {
    const rls = await db.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rag_eval_sets'::regclass");
    expect(rls.rows[0].relrowsecurity).toBe(true);
    const grants = await db.query(
      "SELECT r.rolname, has_table_privilege(r.rolname, 'public.rag_eval_sets', 'SELECT') sel FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated')"
    );
    for (const g of grants.rows) expect(g.sel, g.rolname).toBe(false);
    const temp = randomUUID();
    await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [temp, `기관-${temp.slice(0, 6)}`]);
    await insert(temp, '지울 세트');
    await db.query('DELETE FROM organizations WHERE id = $1', [temp]);
    const left = await db.query('SELECT count(*)::int n FROM rag_eval_sets WHERE organization_id = $1', [temp]);
    expect(left.rows[0].n).toBe(0);
  });
});
