import { readFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * 2026-11-24 — 부서 자료함(0106). 내 자료함(0103)과 같은 표·함수에 자리(space)를 더해,
 * 지금 소속 부서 사람이 함께 담고 다시 붙인다. 바꾸기·지우기는 담은 사람이나 관리자만, 탈퇴·부서 이동에도 부서에 남는다.
 */

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/config', () => ({ SUPABASE_DOCUMENTS_BUCKET: 'documents' }));

import {
  canChangeLibraryRow, deleteLibraryFile, findLibraryOriginal, libraryPath, listLibrary, parseLibrarySpace, saveToLibrary, updateLibraryFile,
  LIBRARY_MAX_DEPARTMENT_FILES, LIBRARY_NOT_YOURS, type LibraryIo, type LibraryActor, type LibrarySpace,
} from '@/lib/my-library';
import { DEPARTMENT_RECORD_TABLES } from '@/lib/department-delete';

const ORG = '22222222-2222-4222-8222-222222222222';
const ME = '33333333-3333-4333-8333-333333333333';
const OTHER = '66666666-6666-4666-8666-666666666666';
const DEPT = '77777777-7777-4777-8777-777777777777';
const ID = '44444444-4444-4444-8444-444444444444';
const NEW_ID = '55555555-5555-4555-8555-555555555555';
const me: LibraryActor = { userId: ME, organizationId: ORG, departmentId: DEPT, isAdmin: false };
const admin: LibraryActor = { ...me, userId: '88888888-8888-4888-8888-888888888888', isAdmin: true };

function fakeIo(rowOwner = OTHER, over: Partial<LibraryIo> = {}) {
  const calls: Record<string, unknown[][]> = {};
  const rec = <A extends unknown[], R>(name: string, fn: (...a: A) => R) => (...a: A) => { (calls[name] ??= []).push(a); return fn(...a); };
  const row = { id: ID, file_name: '회의록 양식.hwpx', folder: '양식', size_bytes: 900, source: 'generated', created_at: '2026-11-24T01:00:00Z', user_id: rowOwner, storage_path: `my-library/${ORG}/d/${DEPT}/${ID}.hwpx` };
  const io: LibraryIo = {
    findSource: rec('findSource', async () => ({ storage_path: 'generated/o/c/f.hwpx', file_name: '회의록 양식.hwpx', size_bytes: 900 })),
    folderValues: rec('folderValues', async () => ['양식']),
    page: rec('page', async () => [row, { ...row, id: NEW_ID, user_id: ME }]),
    findRow: rec('findRow', async (_a: LibraryActor, space: LibrarySpace) => (space === 'department' ? row : null)),
    userNames: rec('userNames', async () => new Map([[OTHER, '김주무관']])),
    copyObject: rec('copyObject', async () => 'ok' as const),
    removeObject: rec('removeObject', async () => 'ok' as const),
    insert: rec('insert', async (r: Record<string, unknown>) => ({ ...r, created_at: '2026-11-24T02:00:00Z' })),
    update: rec('update', async (_a: unknown, _s: unknown, id: string, patch: Record<string, unknown>) => ({ ...row, id, ...patch })),
    remove: rec('remove', async () => 1),
    ...over,
  };
  return { io, calls };
}

describe('자리', () => {
  it('없으면 내 자료함, 모르는 값은 거절', () => {
    expect(parseLibrarySpace(undefined)).toBe('personal');
    expect(parseLibrarySpace('department')).toBe('department');
    expect(parseLibrarySpace('org')).toBeNull();
    expect(LIBRARY_MAX_DEPARTMENT_FILES).toBe(500);
  });
  it('부서 파일 경로는 부서 자리에(탈퇴 처리가 내 자료함 경로만 모은다)', () => {
    expect(libraryPath('department', me, ID, 'a.pdf')).toBe(`my-library/${ORG}/d/${DEPT}/${ID}.pdf`);
  });
  it('바꾸기·지우기는 담은 사람이나 관리자만 — 내 자료함은 언제나 내 것', () => {
    expect(canChangeLibraryRow('department', { user_id: OTHER }, me)).toBe(false);
    expect(canChangeLibraryRow('department', { user_id: ME }, me)).toBe(true);
    expect(canChangeLibraryRow('department', { user_id: OTHER }, admin)).toBe(true);
    expect(canChangeLibraryRow('personal', { user_id: OTHER }, me)).toBe(true);
  });
});

describe('부서 자료함', () => {
  it('목록 — 지금 부서의 파일, 담은 사람 이름·내가 담았는지, 상한 500, 관리자 여부', async () => {
    const { io, calls } = fakeIo();
    const r = await listLibrary(me, { space: 'department' }, io);
    expect(calls.page[0][1]).toBe('department');
    expect(r).toMatchObject({ ok: true, data: { space: 'department', limit: 500, canManage: false } });
    if (r.ok) {
      expect(r.data.files[0]).toMatchObject({ mine: false, added_by: '김주무관' });
      expect(r.data.files[1]).toMatchObject({ mine: true });
      expect(JSON.stringify(r.data)).not.toContain(OTHER);
      expect(JSON.stringify(r.data)).not.toContain('storage_path');
    }
    expect(await listLibrary(admin, { space: 'department' }, fakeIo().io)).toMatchObject({ ok: true, data: { canManage: true } });
    expect(await listLibrary(me, { space: 'everyone' }, fakeIo().io)).toMatchObject({ ok: false, status: 400 });
  });
  it('담기 — 담은 사람의 지금 부서로, 부서 경로에, 상한 500', async () => {
    const { io, calls } = fakeIo();
    const r = await saveToLibrary(me, { kind: 'generated', id: ID, space: 'department', folder: '양식' }, io, () => NEW_ID);
    expect(r).toMatchObject({ ok: true, file: { id: NEW_ID, mine: true } });
    expect(calls.folderValues[0][1]).toBe('department');
    expect(calls.insert[0][0]).toMatchObject({ space: 'department', department_id: DEPT, user_id: ME, storage_path: `my-library/${ORG}/d/${DEPT}/${NEW_ID}.hwpx` });
    const full = fakeIo(OTHER, { folderValues: async () => Array(LIBRARY_MAX_DEPARTMENT_FILES).fill('') });
    expect(await saveToLibrary(me, { kind: 'generated', id: ID, space: 'department' }, full.io)).toMatchObject({ ok: false, status: 409 });
    // 내 자료함 담기는 부서 칸이 없다
    const personal = fakeIo();
    await saveToLibrary(me, { kind: 'generated', id: ID }, personal.io, () => NEW_ID);
    expect(personal.calls.insert[0][0]).toMatchObject({ space: 'personal', department_id: null });
  });
  it('남이 담은 파일은 바꾸거나 지우지 못한다(403) — 관리자·담은 사람은 된다', async () => {
    expect(await updateLibraryFile(me, ID, { space: 'department', folder: '기타' }, fakeIo().io)).toEqual({ ok: false, status: 403, message: LIBRARY_NOT_YOURS });
    const del = fakeIo();
    expect(await deleteLibraryFile(me, ID, 'department', del.io)).toEqual({ ok: false, status: 403, message: LIBRARY_NOT_YOURS });
    expect(del.calls.removeObject).toBeUndefined();
    expect(await updateLibraryFile(admin, ID, { space: 'department', folder: '기타' }, fakeIo().io)).toMatchObject({ ok: true, file: { folder: '기타' } });
    expect(await deleteLibraryFile(me, ID, 'department', fakeIo(ME).io)).toEqual({ ok: true });
  });
  it('다시 붙이기·내려받기 — 내 자료함에 없으면 지금 내 부서의 부서 자료함에서', async () => {
    const { io, calls } = fakeIo();
    expect(await findLibraryOriginal(me, ID, io)).toEqual({ storage_path: `my-library/${ORG}/d/${DEPT}/${ID}.hwpx`, file_name: '회의록 양식.hwpx' });
    expect(calls.findRow.map((c) => c[1])).toEqual(['personal', 'department']);
    expect(await findLibraryOriginal(me, ID, fakeIo(OTHER, { findRow: async () => null }).io)).toBeNull();
  });
});

describe('잇기', () => {
  it('탈퇴 처리는 내 자료함만 지우고 모은다(부서 자료함은 남는다)', () => {
    const w = readFileSync('src/lib/user-withdrawal.ts', 'utf8');
    expect(w).toContain(".from('my_library_files').delete().eq('user_id', userId).eq('space', 'personal')");
    expect(readFileSync('src/lib/my-library.ts', 'utf8')).toContain(".eq('user_id', userId).eq('space', 'personal').order('id')");
  });
  it('부서 자료함이 남은 부서는 지우지 않는다', () => {
    expect(DEPARTMENT_RECORD_TABLES).toContainEqual({ table: 'my_library_files', label: '부서 자료함' });
  });
  it('다시 붙이기가 요청자의 부서를 넘긴다, 화면·고르기에 부서 자료함', () => {
    expect(readFileSync('src/lib/attachments/reuse.ts', 'utf8')).toContain('departmentId: actor.departmentId, isAdmin: false');
    const picker = readFileSync('src/components/chat/ReusableFilePicker.tsx', 'utf8');
    expect(picker).toContain("params.set('space', 'department')");
    const section = readFileSync('src/components/files/MyLibrarySection.tsx', 'utf8');
    expect(section).toContain('(f.mine || page?.canManage)');
    expect(readFileSync('src/app/files/page.tsx', 'utf8')).toContain('saveSpace={librarySpace}');
    for (const f of ['src/app/api/my-library/route.ts', 'src/app/api/my-library/[id]/route.ts', 'src/app/api/my-library/[id]/original/route.ts']) {
      expect(readFileSync(f, 'utf8')).toContain('departmentId: actor.departmentId, isAdmin: actor.isAdmin');
    }
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0106 — 자리·부서 칸(시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('여러 번 적용해도 안전, 자리와 부서 칸이 짝, 부서 외래 키는 지우기를 막는다', async () => {
    expect(existsSync('supabase/migrations/0106_department_library.sql')).toBe(true);
    await db.query('BEGIN');
    try {
      const sql = readFileSync('supabase/migrations/0106_department_library.sql', 'utf8');
      await db.query(sql); await db.query(sql);
      const orgId = randomUUID(); const deptId = randomUUID(); const userId = randomUUID();
      await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, '0106 기관']);
      await db.query('INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)', [deptId, '기획', `d106-${deptId.slice(0, 6)}`, orgId]);
      await db.query('INSERT INTO users (id, email, department_id) VALUES ($1, $2, $3)', [userId, `${userId}@test.local`, deptId]);
      const ins = (space: string, dept: string | null) => db.query(
        `INSERT INTO my_library_files (user_id, organization_id, space, department_id, file_name, size_bytes, storage_path, source) VALUES ($1, $2, $3, $4, 'a.pdf', 1, $5, 'attachment')`,
        [userId, orgId, space, dept, `my-library/${orgId}/x/${randomUUID()}.pdf`]);
      await ins('personal', null);
      await ins('department', deptId);
      for (const [space, dept] of [['personal', deptId], ['department', null], ['org', null]] as const) {
        await db.query('SAVEPOINT s');
        await expect(ins(space, dept)).rejects.toThrow();
        await db.query('ROLLBACK TO SAVEPOINT s');
      }
      await db.query('SAVEPOINT s');
      await expect(db.query('DELETE FROM departments WHERE id = $1', [deptId])).rejects.toThrow();
      await db.query('ROLLBACK TO SAVEPOINT s');
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
