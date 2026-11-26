// tests/batch-0326.test.ts
// 공유 자료함의 '하위 부서도 함께'(2026-11-26, 0132) — 켜면 고른 부서 아래 부서(몇 단계든)의 직원도 함께 쓴다.
import { readFileSync } from 'fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { memberShareIds } from '@/lib/my-library-spec';
import { createShare, listShares, parseShareInput, updateShare, type SharesDb } from '@/lib/library-shares';

const ORG = 'org-1';
const ME = '11111111-1111-4111-8111-111111111111';
const HQ = 'aaaaaaaa-0000-4000-8000-000000000001'; // 본부
const TEAM = 'aaaaaaaa-0000-4000-8000-000000000002'; // 본부 > 과
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000003';
const S_PLAIN = 'bbbbbbbb-0000-4000-8000-000000000001';
const S_DESC = 'bbbbbbbb-0000-4000-8000-000000000002';

describe('누가 드는가', () => {
  const shares = [{ id: S_PLAIN, include_descendants: false }, { id: S_DESC, include_descendants: true }];
  const links = [{ share_id: S_PLAIN, department_id: HQ }, { share_id: S_DESC, department_id: HQ }];
  it('고른 부서 직원은 둘 다, 하위 부서 직원은 켠 것만, 상위·다른 부서는 아님', () => {
    expect(memberShareIds(links, shares, HQ, [HQ])).toEqual(new Set([S_PLAIN, S_DESC]));
    expect(memberShareIds(links, shares, TEAM, [TEAM, HQ])).toEqual(new Set([S_DESC]));
    expect(memberShareIds([{ share_id: S_DESC, department_id: TEAM }], shares, HQ, [HQ])).toEqual(new Set());
    expect(memberShareIds(links, shares, OTHER, [OTHER])).toEqual(new Set());
    // 대소문자·모르는 공유 자료함 줄
    expect(memberShareIds([{ share_id: S_DESC.toUpperCase(), department_id: HQ.toUpperCase() }, { share_id: 'x', department_id: HQ }], shares, TEAM, [TEAM, HQ])).toEqual(new Set([S_DESC]));
  });
});

function fakeDb(over: Partial<SharesDb> = {}) {
  const log: string[] = [];
  const db: SharesDb = {
    list: async () => [{ id: S_PLAIN, name: '예산 협의체', created_at: 'x', include_descendants: false }],
    departmentsOf: async () => [{ share_id: S_PLAIN, department_id: HQ }],
    fileCounts: async (ids) => new Map(ids.map((i) => [i, 0])),
    orgDepartments: async (_o, ids) => ids,
    insert: async (r) => { log.push(`insert:${r.name}:${r.include_descendants}`); return { id: S_DESC, name: r.name, created_at: 'y', include_descendants: r.include_descendants }; },
    rename: async () => true,
    setIncludeDescendants: async (_o, id, v) => { log.push(`descendants:${id}:${v}`); return true; },
    setDepartments: async () => {},
    remove: async () => true,
    ...over,
  };
  return { db, log };
}

describe('관리', () => {
  it('입력 — 참·거짓만, 그것만 바꿔도 된다', () => {
    expect(parseShareInput({ includeDescendants: true }, true)).toEqual({ ok: true, includeDescendants: true });
    expect(parseShareInput({ includeDescendants: 'yes' }, true)).toMatchObject({ ok: false, status: 400 });
    expect(parseShareInput({ name: '감사', departmentIds: [HQ] }, false)).toEqual({ ok: true, name: '감사', departmentIds: [HQ] });
  });
  it('만들기는 기본 꺼짐, 고치기는 바뀔 때만 기록, 목록에 보인다', async () => {
    const a = fakeDb();
    expect(await createShare(ORG, ME, { name: '감사', departmentIds: [HQ] }, a.db)).toMatchObject({ ok: true, share: { includeDescendants: false } });
    expect(await createShare(ORG, ME, { name: '감사', departmentIds: [HQ], includeDescendants: true }, a.db)).toMatchObject({ ok: true, share: { includeDescendants: true } });
    expect(a.log).toEqual(['insert:감사:false', 'insert:감사:true']);
    const b = fakeDb();
    expect(await updateShare(ORG, S_PLAIN, { includeDescendants: true }, b.db)).toEqual({ ok: true, changed: ['include_descendants_on'] });
    // 같은 값이면 바꾸지 않는다(기록 없음)
    expect(await updateShare(ORG, S_PLAIN, { includeDescendants: false }, b.db)).toEqual({ ok: true, changed: [] });
    expect(b.log).toEqual([`descendants:${S_PLAIN}:true`]);
    expect(await updateShare(ORG, S_PLAIN, { includeDescendants: true }, fakeDb({ setIncludeDescendants: async () => false }).db)).toMatchObject({ ok: false, status: 404 });
    expect(await listShares(ORG, fakeDb({ list: async () => [{ id: S_PLAIN, name: 'x', created_at: 'x', include_descendants: true }] }).db)).toMatchObject({ ok: true, shares: [{ includeDescendants: true }] });
  });
  it('연결 — 직원 쪽 판정은 부서 계통으로, 화면에 체크 칸', () => {
    const lib = readFileSync('src/lib/my-library.ts', 'utf8');
    expect(lib).toContain('const lineage = await getVisibleDepartmentIds(departmentId);');
    expect(lib).toContain("select('id, name, include_descendants')");
    expect(lib).toContain('const member = memberShareIds(rows, shares, departmentId, lineage);');
    const panel = readFileSync('src/components/admin/LibrarySharesPanel.tsx', 'utf8');
    expect(panel).toContain('includeDescendants: draft.includeDescendants');
    expect(panel).toContain('하위 부서도 함께 — 고른 부서 아래 부서');
  });
});

describe('0132(시험 DB)', () => {
  const url = process.env.WORK_TEST_DATABASE_URL;
  let db: pg.Client;
  beforeAll(async () => {
    if (!url) return;
    if (/supabase\.(co|com)|pooler\./.test(url)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it.skipIf(!url)('칸·기본 꺼짐·두 번 적용해도 안전', async () => {
    const sql = readFileSync('supabase/migrations/0132_library_share_descendants.sql', 'utf8');
    await db.query('BEGIN');
    try {
      await db.query(sql); await db.query(sql);
      const col = await db.query(`SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name='library_shares' AND column_name='include_descendants'`);
      expect(col.rows[0]).toEqual({ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' });
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
