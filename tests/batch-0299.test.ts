import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * 2026-11-25 — 공유 자료함(0116): 기관 전체 관리자가 이름과 부서 목록을 정해 만들고, 그 부서에 지금 소속된 직원이 함께 담고 다시 붙인다.
 * 요청마다 내가 든 공유 자료함(`loadLibraryShares`)을 읽고, 고른 공유 자료함이 그 안에 있을 때만 다룬다(`placeActor`).
 */

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/config', () => ({ SUPABASE_DOCUMENTS_BUCKET: 'documents' }));
vi.mock('@/lib/logger', () => ({ logSystem: async () => {} }));

import {
  cleanShareName, findLibraryOriginal, libraryMaxFiles, libraryPath, libraryPlaceLabel, listLibrary, moveLibraryFolder, parseLibrarySpace, placeActor, samePlace,
  saveToLibrary, transferLibraryFile, transferLibraryFiles, transferPlaces, LIBRARY_MAX_SHARE_FILES, LIBRARY_SHARE_NOT_FOUND,
  type LibraryActor, type LibraryIo, type LibrarySpace,
} from '@/lib/my-library';
import { createShare, deleteShare, parseShareInput, updateShare, type SharesDb } from '@/lib/library-shares';
import { API_ROUTES } from '@/lib/api-route-ids';
import { SECURITY_EVENT_LABELS } from '@/lib/security-event-text';

const ORG = '22222222-2222-4222-8222-222222222222';
const ME = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const DEPT = '77777777-7777-4777-8777-777777777777';
const DEPT2 = '88888888-8888-4888-8888-888888888888';
const SHARE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SHARE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SHARE_X = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FILE = '55555555-5555-4555-8555-555555555555';
const NEW = '66666666-6666-4666-8666-666666666666';
const shares = [{ id: SHARE_A, name: '예산 협의체' }, { id: SHARE_B, name: '감사 대응' }];
const staff: LibraryActor = { userId: ME, organizationId: ORG, departmentId: DEPT, isAdmin: false, managesWholeOrganization: false, shares };
const admin: LibraryActor = { ...staff, isAdmin: true };
const newId = () => NEW;

describe('꼴·이름', () => {
  it('자리 shared를 받고, 이름·같은 곳·보낼 곳을 공유 자료함까지 가린다', () => {
    expect(parseLibrarySpace('shared')).toBe('shared');
    expect(libraryMaxFiles('shared')).toBe(LIBRARY_MAX_SHARE_FILES);
    expect(libraryPlaceLabel({ space: 'shared', share: SHARE_A }, shares)).toBe("공유 자료함 '예산 협의체'");
    expect(libraryPlaceLabel({ space: 'shared', share: SHARE_X }, shares)).toBe('공유 자료함');
    expect(libraryPlaceLabel({ space: 'department' })).toBe('부서 자료함');
    expect(samePlace({ space: 'shared', share: SHARE_A }, { space: 'shared', share: SHARE_A.toUpperCase() })).toBe(true);
    expect(samePlace({ space: 'shared', share: SHARE_A }, { space: 'shared', share: SHARE_B })).toBe(false);
    expect(samePlace({ space: 'personal', share: 'x' }, { space: 'personal' })).toBe(true);
    const canAddTo = { personal: true, department: true, organization: false, shared: true } as Record<LibrarySpace, boolean>;
    expect(transferPlaces({ space: 'shared', share: SHARE_A }, canAddTo, shares)).toEqual([{ space: 'personal' }, { space: 'department' }, { space: 'shared', share: SHARE_B }]);
    expect(transferPlaces({ space: 'personal' }, undefined, [])).toEqual([{ space: 'department' }]);
  });
  it('공유 자료함 이름 다듬기 — 1~40자, 보이지 않는 글자·공백 정리', () => {
    expect(cleanShareName('  예산 ​ 협의체  ')).toBe('예산 협의체');
    expect(cleanShareName('')).toBeNull();
    expect(cleanShareName('가'.repeat(41))).toBeNull();
    expect(cleanShareName(3)).toBeNull();
  });
});

describe('내가 든 공유 자료함만', () => {
  it('placeActor — 든 공유 자료함이면 그 id를 싣고, 아니면 404, 다른 자리는 공유 자료함 없음', () => {
    expect(placeActor(staff, 'shared', SHARE_A.toUpperCase())).toMatchObject({ ok: true, actor: { shareId: SHARE_A } });
    expect(placeActor(staff, 'shared', SHARE_X)).toEqual({ ok: false, status: 404, message: LIBRARY_SHARE_NOT_FOUND });
    expect(placeActor(staff, 'shared', undefined)).toMatchObject({ ok: false, status: 404 });
    expect(placeActor({ ...staff, shares: undefined }, 'shared', SHARE_A)).toMatchObject({ ok: false, status: 404 });
    expect(placeActor(staff, 'department', SHARE_A)).toMatchObject({ ok: true, actor: { shareId: null } });
  });
  it('저장소 경로는 공유 자료함 아래', () => {
    expect(libraryPath('shared', { ...staff, shareId: SHARE_A }, NEW, '서식.xlsx')).toBe(`my-library/${ORG}/s/${SHARE_A}/${NEW}.xlsx`);
  });
});

type Call = { name: string; space?: LibrarySpace; shareId?: string | null };
function fakeIo(over: Partial<LibraryIo> = {}) {
  const calls: Call[] = [];
  const inserted: Record<string, unknown>[] = [];
  const row = { id: FILE, file_name: '서식.xlsx', folder: '예산', size_bytes: 10, source: 'attachment', created_at: '2026-11-25T00:00:00Z', user_id: OTHER, storage_path: `my-library/${ORG}/s/${SHARE_A}/${FILE}.xlsx` };
  const io = {
    findSource: async () => ({ storage_path: 'chat-uploads/x.xlsx', file_name: '서식.xlsx', size_bytes: 10 }),
    folderValues: async (a: LibraryActor, space: LibrarySpace) => { calls.push({ name: 'folderValues', space, shareId: a.shareId }); return ['예산']; },
    page: async (a: LibraryActor, space: LibrarySpace) => { calls.push({ name: 'page', space, shareId: a.shareId }); return [row]; },
    findRow: async (a: LibraryActor, space: LibrarySpace) => { calls.push({ name: 'findRow', space, shareId: a.shareId }); return space === 'shared' && a.shareId === SHARE_A ? row : null; },
    findRows: async (a: LibraryActor, space: LibrarySpace) => { calls.push({ name: 'findRows', space, shareId: a.shareId }); return space === 'shared' && a.shareId === SHARE_A ? [row] : []; },
    findSharedRow: async () => { calls.push({ name: 'findSharedRow' }); return row; },
    userNames: async () => new Map([[OTHER, '김주무관']]),
    copyObject: async () => 'ok' as const,
    removeObject: async () => 'ok' as const,
    insert: async (r: Record<string, unknown>) => { inserted.push(r); return { ...r, created_at: '2026-11-25T01:00:00Z' }; },
    remove: async (a: LibraryActor, space: LibrarySpace) => { calls.push({ name: 'remove', space, shareId: a.shareId }); return 1; },
    setFolder: async (a: LibraryActor, space: LibrarySpace) => { calls.push({ name: 'setFolder', space, shareId: a.shareId }); return 1; },
    ...over,
  } as unknown as LibraryIo;
  return { io, calls, inserted };
}

describe('공유 자료함 다루기', () => {
  it('목록 — 고른 공유 자료함으로만 읽고, 내가 든 목록·고른 것·담은 사람 이름을 싣는다', async () => {
    const { io, calls } = fakeIo();
    const r = await listLibrary(staff, { space: 'shared', share: SHARE_A }, io);
    expect(r).toMatchObject({ ok: true, data: { space: 'shared', share: SHARE_A, shares, canManage: false, canAdd: true, files: [{ added_by: '김주무관', mine: false }] } });
    expect(calls.every((c) => c.shareId === SHARE_A)).toBe(true);
    expect(await listLibrary(admin, { space: 'shared', share: SHARE_A }, io)).toMatchObject({ ok: true, data: { canManage: true } });
    // 다른 자리 목록에도 든 목록이 실린다(탭을 그린다)
    expect(await listLibrary(staff, { space: 'personal' }, io)).toMatchObject({ ok: true, data: { shares, share: null, canAddTo: { shared: true } } });
  });
  it('든 공유 자료함이 아니면 읽기 전에 404', async () => {
    const { io, calls } = fakeIo();
    expect(await listLibrary(staff, { space: 'shared', share: SHARE_X }, io)).toMatchObject({ ok: false, status: 404 });
    expect(await saveToLibrary(staff, { kind: 'attachment', id: FILE, space: 'shared', share: SHARE_X }, io, newId)).toMatchObject({ ok: false, status: 404 });
    expect(calls).toEqual([]);
  });
  it('담기 — share_id·공유 자료함 경로로', async () => {
    const { io, inserted } = fakeIo();
    expect(await saveToLibrary(staff, { kind: 'attachment', id: FILE, space: 'shared', share: SHARE_A, folder: '예산' }, io, newId)).toMatchObject({ ok: true });
    expect(inserted[0]).toMatchObject({ space: 'shared', share_id: SHARE_A, department_id: null, storage_path: `my-library/${ORG}/s/${SHARE_A}/${NEW}.xlsx` });
  });
  it('남이 담은 파일 옮기기·폴더째 옮기기는 관리자만', async () => {
    expect(await moveLibraryFolder(staff, { space: 'shared', share: SHARE_A, from: '예산', to: '재무' }, fakeIo().io)).toMatchObject({ ok: false, status: 403 });
    expect(await moveLibraryFolder(admin, { space: 'shared', share: SHARE_A, from: '예산', to: '재무' }, fakeIo().io)).toMatchObject({ ok: true });
    expect(await transferLibraryFile(staff, FILE, { space: 'shared', share: SHARE_A, to: 'personal', mode: 'move' }, fakeIo().io, newId))
      .toMatchObject({ ok: false, status: 403, message: expect.stringContaining('공유 자료함의 파일은') });
  });
  it('다른 공유 자료함으로 보내기 — 받는 쪽 share_id, 같은 곳은 400, 든 곳이 아니면 404', async () => {
    const { io, inserted, calls } = fakeIo();
    expect(await transferLibraryFile(admin, FILE, { space: 'shared', share: SHARE_A, to: 'shared', toShare: SHARE_B, mode: 'move' }, io, newId)).toMatchObject({ ok: true, to: 'shared' });
    expect(inserted[0]).toMatchObject({ space: 'shared', share_id: SHARE_B, storage_path: `my-library/${ORG}/s/${SHARE_B}/${NEW}.xlsx` });
    expect(calls.find((c) => c.name === 'remove')).toMatchObject({ space: 'shared', shareId: SHARE_A });
    expect(await transferLibraryFile(admin, FILE, { space: 'shared', share: SHARE_A, to: 'shared', toShare: SHARE_A, mode: 'copy' }, io, newId)).toMatchObject({ ok: false, status: 400 });
    expect(await transferLibraryFile(admin, FILE, { space: 'shared', share: SHARE_A, to: 'shared', toShare: SHARE_X, mode: 'copy' }, io, newId)).toMatchObject({ ok: false, status: 404 });
    expect(await transferLibraryFile(admin, FILE, { space: 'shared', share: SHARE_X, to: 'personal', mode: 'copy' }, io, newId)).toMatchObject({ ok: false, status: 404 });
  });
  it('여러 파일 보내기도 공유 자료함에서·으로', async () => {
    const { io, inserted } = fakeIo();
    expect(await transferLibraryFiles(staff, { space: 'shared', share: SHARE_A, to: 'personal', mode: 'copy', ids: [FILE] }, io, newId)).toMatchObject({ ok: true, sent: 1 });
    expect(inserted[0]).toMatchObject({ space: 'personal', share_id: null });
  });
  it('다시 붙이기·내려받기 — 내/부서/기관 자료함에 없으면 지금 부서가 든 공유 자료함에서 찾는다', async () => {
    const none = fakeIo({ findRow: async () => null });
    expect(await findLibraryOriginal(staff, FILE, none.io)).toEqual({ storage_path: `my-library/${ORG}/s/${SHARE_A}/${FILE}.xlsx`, file_name: '서식.xlsx' });
    expect(none.calls.at(-1)).toEqual({ name: 'findSharedRow' });
  });
});

describe('공유 자료함 관리', () => {
  it('입력 — 만들기는 이름·부서 둘 다, 고치기는 보낸 것만, 부서 1~50곳 겹침 없이', () => {
    expect(parseShareInput({ name: ' 예산 협의체 ', departmentIds: [DEPT, DEPT.toUpperCase(), DEPT2] }, false)).toEqual({ ok: true, name: '예산 협의체', departmentIds: [DEPT, DEPT2] });
    expect(parseShareInput({ name: '예산' }, false)).toMatchObject({ ok: false });
    expect(parseShareInput({ name: '예산', departmentIds: [] }, false)).toMatchObject({ ok: false });
    expect(parseShareInput({ name: '예산', departmentIds: ['x'] }, false)).toMatchObject({ ok: false });
    expect(parseShareInput({ name: '예산', departmentIds: Array.from({ length: 51 }, () => randomUUID()) }, false)).toMatchObject({ ok: false });
    expect(parseShareInput({ name: '감사' }, true)).toEqual({ ok: true, name: '감사' });
    expect(parseShareInput({}, true)).toMatchObject({ ok: false });
  });
  function fakeDb(over: Partial<SharesDb> = {}) {
    const log: string[] = [];
    const db: SharesDb = {
      list: async () => [{ id: SHARE_A, name: '예산 협의체', created_at: 'x' }],
      departmentsOf: async () => [{ share_id: SHARE_A, department_id: DEPT }],
      fileCounts: async (ids) => new Map(ids.map((i) => [i, 0])),
      orgDepartments: async (_o, ids) => ids,
      insert: async (r) => { log.push(`insert:${r.name}`); return { id: SHARE_B, name: r.name, created_at: 'y' }; },
      rename: async (_o, id, name) => { log.push(`rename:${id}:${name}`); return true; },
      setDepartments: async (id, ids) => { log.push(`set:${id}:${ids.length}`); },
      remove: async (_o, id) => { log.push(`remove:${id}`); return true; },
      ...over,
    };
    return { db, log };
  }
  it('만들기 — 이 기관 부서만, 50개 상한, 같은 이름 409, 부서를 못 넣으면 만든 것을 지운다', async () => {
    const ok = fakeDb();
    expect(await createShare(ORG, ME, { name: '감사 대응', departmentIds: [DEPT, DEPT2] }, ok.db)).toMatchObject({ ok: true, share: { id: SHARE_B, departmentIds: [DEPT, DEPT2], files: 0 } });
    expect(ok.log).toEqual(['insert:감사 대응', `set:${SHARE_B}:2`]);
    expect(await createShare(ORG, ME, { name: '감사', departmentIds: [DEPT] }, fakeDb({ orgDepartments: async () => [] }).db)).toMatchObject({ ok: false, status: 400 });
    expect(await createShare(ORG, ME, { name: '감사', departmentIds: [DEPT] }, fakeDb({ list: async () => Array.from({ length: 50 }, (_, i) => ({ id: randomUUID(), name: `s${i}`, created_at: 'x' })) }).db)).toMatchObject({ ok: false, status: 409 });
    expect(await createShare(ORG, ME, { name: '예산 협의체', departmentIds: [DEPT] }, fakeDb({ insert: async () => { throw { code: '23505' }; } }).db)).toMatchObject({ ok: false, status: 409 });
    const half = fakeDb({ setDepartments: async () => { throw new Error('db'); } });
    expect(await createShare(ORG, ME, { name: '감사', departmentIds: [DEPT] }, half.db)).toMatchObject({ ok: false, status: 503 });
    expect(half.log).toContain(`remove:${SHARE_B}`);
  });
  it('고치기 — 없는 공유 자료함 404, 같은 이름은 바꾸지 않음, 부서 바꾸기', async () => {
    const { db, log } = fakeDb();
    expect(await updateShare(ORG, SHARE_X, { name: 'x' }, db)).toMatchObject({ ok: false, status: 404 });
    expect(await updateShare(ORG, SHARE_A, { name: '예산 협의체', departmentIds: [DEPT2] }, db)).toEqual({ ok: true, changed: ['departments'] });
    expect(log).toEqual([`set:${SHARE_A}:1`]);
    expect(await updateShare(ORG, SHARE_A, { name: '감사' }, fakeDb({ rename: async () => { throw { code: '23505' }; } }).db)).toMatchObject({ ok: false, status: 409 });
  });
  it('지우기 — 파일이 남았으면 409(그 사이 담긴 것도), 없는 것 404', async () => {
    expect(await deleteShare(ORG, SHARE_A, fakeDb({ fileCounts: async () => new Map([[SHARE_A, 3]]) }).db)).toMatchObject({ ok: false, status: 409, message: expect.stringContaining('3개') });
    expect(await deleteShare(ORG, SHARE_A, fakeDb({ remove: async () => { throw { code: '23503' }; } }).db)).toMatchObject({ ok: false, status: 409 });
    expect(await deleteShare(ORG, SHARE_X, fakeDb().db)).toMatchObject({ ok: false, status: 404 });
    expect(await deleteShare(ORG, SHARE_A, fakeDb().db)).toEqual({ ok: true, name: '예산 협의체' });
  });
});

describe('잇기', () => {
  it('라우트·라우트 목록·보안 로그', () => {
    for (const r of ['admin/library-shares', 'admin/library-shares/[id]', 'my-library/shares']) expect(API_ROUTES).toContain(r);
    const list = readFileSync('src/app/api/admin/library-shares/route.ts', 'utf8');
    expect(list).toContain("if (!scope.managesWholeOrganization) return jsonError(");
    expect(list).toContain("'library_share_changed'");
    const one = readFileSync('src/app/api/admin/library-shares/[id]/route.ts', 'utf8');
    expect(one.match(/requireAdminWholeOrg\(\)/g)?.length).toBe(3);
    expect(one).toContain('isAdminSession(session)');
    expect(SECURITY_EVENT_LABELS.library_share_changed).toBe('공유 자료함 바꾸기');
  });
  it('자료함 라우트 넷이 공유 자료함 목록을 읽는 요청자 도우미를 쓰고, 못 읽으면 503', () => {
    for (const f of ['src/app/api/my-library/route.ts', 'src/app/api/my-library/[id]/route.ts', 'src/app/api/my-library/folders/route.ts', 'src/app/api/my-library/transfer/route.ts', 'src/app/api/my-library/shares/route.ts']) {
      expect(readFileSync(f, 'utf8')).toContain('libraryActorOr(await getServerAuthSession())');
    }
    const helper = readFileSync('src/lib/my-library-actor.ts', 'utf8');
    expect(helper).toContain('shares = await loadLibraryShares(actor.organizationId, actor.departmentId);');
    expect(helper).toContain('return jsonError(LIBRARY_RETRY, 503);');
  });
  it('화면 — 결과물 화면·지난 파일·관리자 기관 정보', () => {
    const section = readFileSync('src/components/files/MyLibrarySection.tsx', 'utf8');
    expect(section).toContain("onClick={() => onSpaceChange('shared', s.id)}");
    expect(section).toContain("if (space === 'shared' && share) params.set('share', share);");
    expect(section).toContain("const placeBody = space === 'shared' ? { space, share } : { space };");
    const picker = readFileSync('src/components/chat/ReusableFilePicker.tsx', 'utf8');
    expect(picker).toContain("void fetch('/api/my-library/shares')");
    expect(picker).toContain("if (tab.startsWith('shared:')) { params.set('space', 'shared'); params.set('share', tab.slice(7)); }");
    expect(picker).toContain('공유 자료함 목록을 지금 불러오지 못했습니다.');
    expect(readFileSync('src/app/admin/organization/page.tsx', 'utf8')).toContain('<LibrarySharesPanel />');
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0116 — 공유 자료함 표(시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('여러 번 적용해도 안전·자리 CHECK·파일이 남으면 지우지 못함·부서를 지우면 그 줄만 빠짐·이름 하나·RLS', async () => {
    await db.query('BEGIN');
    try {
      const sql = readFileSync('supabase/migrations/0116_library_shares.sql', 'utf8');
      await db.query(sql); await db.query(sql);
      const org = randomUUID(); const dept = randomUUID(); const user = randomUUID(); const share = randomUUID();
      await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [org, '0116 기관']);
      await db.query("INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, '총무과', $2, $3)", [dept, `d-${dept.slice(0, 8)}`, org]);
      await db.query("INSERT INTO users (id, email, role, department_id) VALUES ($1, $2, 'USER', $3)", [user, `${user}@x.test`, dept]);
      await db.query("INSERT INTO library_shares (id, organization_id, name) VALUES ($1, $2, '예산 협의체')", [share, org]);
      await db.query('INSERT INTO library_share_departments (share_id, department_id) VALUES ($1, $2)', [share, dept]);
      await db.query('SAVEPOINT a');
      await expect(db.query("INSERT INTO library_shares (organization_id, name) VALUES ($1, '예산 협의체')", [org])).rejects.toThrow(/duplicate|unique/i);
      await db.query('ROLLBACK TO SAVEPOINT a');
      const file = (space: string, shareId: string | null, deptId: string | null) => db.query(
        "INSERT INTO my_library_files (user_id, organization_id, space, department_id, share_id, folder, file_name, size_bytes, storage_path, source) VALUES ($1, $2, $3, $4, $5, '', 'a.xlsx', 1, $6, 'attachment')",
        [user, org, space, deptId, shareId, `my-library/${randomUUID()}`]);
      await file('shared', share, null);
      for (const [space, s, d] of [['shared', null, null], ['shared', share, dept], ['personal', share, null], ['department', share, dept]] as [string, string | null, string | null][]) {
        await db.query('SAVEPOINT b');
        await expect(file(space, s, d)).rejects.toThrow(/check/i);
        await db.query('ROLLBACK TO SAVEPOINT b');
      }
      await db.query('SAVEPOINT c');
      await expect(db.query('DELETE FROM library_shares WHERE id = $1', [share])).rejects.toThrow(/foreign key/i);
      await db.query('ROLLBACK TO SAVEPOINT c');
      await db.query('DELETE FROM library_share_departments WHERE department_id = $1', [dept]);
      expect((await db.query('SELECT count(*)::int n FROM library_shares WHERE id = $1', [share])).rows[0].n).toBe(1);
      const rls = await db.query("SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('library_shares', 'library_share_departments') ORDER BY relname");
      expect(rls.rows).toEqual([{ relname: 'library_share_departments', relrowsecurity: true }, { relname: 'library_shares', relrowsecurity: true }]);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
