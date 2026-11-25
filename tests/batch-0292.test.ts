import { readFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * 2026-11-25 — 기관 자료함(0112). 내 자료함·부서 자료함과 같은 표·함수에 자리 organization을 더한다.
 * 같은 기관 직원 누구나 보고·내려받고·다시 붙이며, 담기·이름/폴더 바꾸기·지우기는 기관 전체 관리자만.
 */

const db = vi.hoisted(() => ({ calls: [] as { table: string; ops: [string, unknown[]][] }[] }));
vi.mock('@/lib/supabaseAdmin', () => {
  const builder = (table: string) => {
    const ops: [string, unknown[]][] = [];
    db.calls.push({ table, ops });
    const b: Record<string, unknown> = {};
    for (const op of ['select', 'in', 'eq', 'is', 'order', 'limit', 'maybeSingle', 'ilike', 'or']) b[op] = (...a: unknown[]) => { ops.push([op, a]); return b; };
    b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
    return b;
  };
  return { supabaseAdmin: { from: (t: string) => builder(t) } };
});
vi.mock('@/lib/config', () => ({ SUPABASE_DOCUMENTS_BUCKET: 'documents' }));

import {
  canAddToLibrary, canChangeLibraryRow, deleteLibraryFile, findLibraryOriginal, libraryIo, libraryPath, listLibrary, parseLibrarySpace, saveToLibrary, updateLibraryFile,
  LIBRARY_MAX_ORGANIZATION_FILES, LIBRARY_ORG_ONLY, LIBRARY_SPACES, type LibraryIo, type LibraryActor, type LibrarySpace,
} from '@/lib/my-library';

const ORG = '22222222-2222-4222-8222-222222222222';
const ME = '33333333-3333-4333-8333-333333333333';
const OTHER = '66666666-6666-4666-8666-666666666666';
const DEPT = '77777777-7777-4777-8777-777777777777';
const ID = '44444444-4444-4444-8444-444444444444';
const NEW_ID = '55555555-5555-4555-8555-555555555555';
const staff: LibraryActor = { userId: ME, organizationId: ORG, departmentId: DEPT, isAdmin: false, managesWholeOrganization: false };
const subAdmin: LibraryActor = { ...staff, isAdmin: true, managesWholeOrganization: false };
const orgAdmin: LibraryActor = { ...staff, userId: OTHER, isAdmin: true, managesWholeOrganization: true };

function fakeIo(over: Partial<LibraryIo> = {}) {
  const calls: Record<string, unknown[][]> = {};
  const rec = <A extends unknown[], R>(name: string, fn: (...a: A) => R) => (...a: A) => { (calls[name] ??= []).push(a); return fn(...a); };
  const row = { id: ID, file_name: '기안문 서식.hwpx', folder: '서식', size_bytes: 900, source: 'generated', created_at: '2026-11-25T01:00:00Z', user_id: OTHER, storage_path: `my-library/${ORG}/o/${ID}.hwpx` };
  const io: LibraryIo = {
    findSource: rec('findSource', async () => ({ storage_path: 'generated/o/c/f.hwpx', file_name: '기안문 서식.hwpx', size_bytes: 900 })),
    folderValues: rec('folderValues', async () => ['서식']),
    page: rec('page', async () => [row]),
    findRow: rec('findRow', async (_a: LibraryActor, space: LibrarySpace) => (space === 'organization' ? row : null)),
    userNames: rec('userNames', async () => new Map([[OTHER, '박관리자']])),
    copyObject: rec('copyObject', async () => 'ok' as const),
    removeObject: rec('removeObject', async () => 'ok' as const),
    insert: rec('insert', async (r: Record<string, unknown>) => ({ ...r, created_at: '2026-11-25T02:00:00Z' })),
    update: rec('update', async (_a: unknown, _s: unknown, id: string, patch: Record<string, unknown>) => ({ ...row, id, ...patch })),
    remove: rec('remove', async () => 1),
    ...over,
  };
  return { io, calls };
}

describe('자리·권한', () => {
  it('organization 자리를 읽고, 경로는 기관 자리에, 상한 1000', () => {
    expect(parseLibrarySpace('organization')).toBe('organization');
    expect(LIBRARY_SPACES).toEqual(['personal', 'department', 'organization']);
    expect(libraryPath('organization', staff, ID, 'a.pdf')).toBe(`my-library/${ORG}/o/${ID}.pdf`);
    expect(LIBRARY_MAX_ORGANIZATION_FILES).toBe(1000);
  });
  it('담기·바꾸기는 기관 전체 관리자만 — 하위 부서 관리자·직원·담은 사람이어도 아님, 다른 자리는 그대로', () => {
    expect(canAddToLibrary('organization', orgAdmin)).toBe(true);
    expect(canAddToLibrary('organization', subAdmin)).toBe(false);
    expect(canAddToLibrary('organization', { ...staff, managesWholeOrganization: undefined })).toBe(false);
    expect(canAddToLibrary('department', staff)).toBe(true);
    expect(canChangeLibraryRow('organization', { user_id: ME }, staff)).toBe(false);
    expect(canChangeLibraryRow('organization', { user_id: OTHER }, subAdmin)).toBe(false);
    expect(canChangeLibraryRow('organization', { user_id: ME }, orgAdmin)).toBe(true);
    expect(canChangeLibraryRow('department', { user_id: OTHER }, subAdmin)).toBe(true);
  });
});

describe('기관 자료함', () => {
  it('목록 — 직원도 보고, 담은 사람 이름, 담기·고치기 여부는 기관 전체 관리자만 참', async () => {
    const { io, calls } = fakeIo();
    const r = await listLibrary(staff, { space: 'organization' }, io);
    expect(calls.page[0][1]).toBe('organization');
    expect(r).toMatchObject({ ok: true, data: { space: 'organization', limit: 1000, canManage: false, canAdd: false } });
    if (r.ok) expect(r.data.files[0]).toMatchObject({ added_by: '박관리자', mine: false });
    expect(await listLibrary(orgAdmin, { space: 'organization' }, fakeIo().io)).toMatchObject({ ok: true, data: { canManage: true, canAdd: true } });
    expect(await listLibrary(staff, { space: 'personal' }, fakeIo().io)).toMatchObject({ ok: true, data: { canAdd: true } });
  });
  it('담기 — 기관 전체 관리자만, 부서 칸 없이 기관 자리 경로로. 직원·하위 부서 관리자는 원본을 읽기도 전에 403', async () => {
    for (const who of [staff, subAdmin]) {
      const { io, calls } = fakeIo();
      expect(await saveToLibrary(who, { kind: 'generated', id: ID, space: 'organization' }, io, () => NEW_ID)).toEqual({ ok: false, status: 403, message: LIBRARY_ORG_ONLY });
      expect(calls.findSource).toBeUndefined();
      expect(calls.copyObject).toBeUndefined();
    }
    const { io, calls } = fakeIo();
    const r = await saveToLibrary(orgAdmin, { kind: 'generated', id: ID, folder: '서식', space: 'organization' }, io, () => NEW_ID);
    expect(r).toMatchObject({ ok: true, file: { id: NEW_ID, mine: true } });
    expect(calls.copyObject[0]).toEqual(['generated/o/c/f.hwpx', `my-library/${ORG}/o/${NEW_ID}.hwpx`]);
    expect(calls.insert[0][0]).toMatchObject({ space: 'organization', department_id: null, organization_id: ORG, user_id: OTHER });
  });
  it('가득 차면 기관 자료함 이름으로 알린다', async () => {
    const full = fakeIo({ folderValues: async () => Array.from({ length: 1000 }, () => '') });
    expect(await saveToLibrary(orgAdmin, { kind: 'generated', id: ID, space: 'organization' }, full.io)).toMatchObject({ ok: false, status: 409, message: expect.stringContaining('기관 자료함이 가득') });
  });
  it('바꾸기·지우기 — 직원·하위 부서 관리자는 403(사본을 건드리지 않음), 기관 전체 관리자는 됨', async () => {
    for (const who of [staff, subAdmin]) {
      const { io, calls } = fakeIo();
      expect(await updateLibraryFile(who, ID, { folder: '기준', space: 'organization' }, io)).toEqual({ ok: false, status: 403, message: LIBRARY_ORG_ONLY });
      expect(await deleteLibraryFile(who, ID, 'organization', io)).toEqual({ ok: false, status: 403, message: LIBRARY_ORG_ONLY });
      expect(calls.update).toBeUndefined();
      expect(calls.removeObject).toBeUndefined();
    }
    const { io, calls } = fakeIo();
    expect(await updateLibraryFile(orgAdmin, ID, { folder: '기준', space: 'organization' }, io)).toMatchObject({ ok: true, file: { folder: '기준' } });
    expect(await deleteLibraryFile(orgAdmin, ID, 'organization', io)).toEqual({ ok: true });
    expect(calls.removeObject[0]).toEqual([`my-library/${ORG}/o/${ID}.hwpx`]);
  });
  it('다시 붙이기·내려받기 원본 — 내 자료함 → 부서 자료함 → 기관 자료함 순으로 찾는다(직원도)', async () => {
    const { io, calls } = fakeIo();
    expect(await findLibraryOriginal(staff, ID, io)).toEqual({ storage_path: `my-library/${ORG}/o/${ID}.hwpx`, file_name: '기안문 서식.hwpx' });
    expect(calls.findRow.map((c) => c[1])).toEqual(['personal', 'department', 'organization']);
  });
});

describe('DB 조건', () => {
  it('기관 자료함 조회는 자리와 요청자 기관으로만 건다(부서·사람 조건 없음)', async () => {
    db.calls.length = 0;
    await libraryIo().page(staff, 'organization', { folder: null, query: null, cursor: null });
    const ops = db.calls.find((c) => c.table === 'my_library_files')!.ops;
    expect(ops).toEqual(expect.arrayContaining([['eq', ['space', 'organization']], ['eq', ['organization_id', ORG]]]));
    expect(ops.some(([op, a]) => op === 'eq' && (a[0] === 'user_id' || a[0] === 'department_id'))).toBe(false);
  });
});

describe('잇기', () => {
  it('라우트가 기관 전체 관리자 여부를 넘기고, 화면에 기관 자료함 탭', () => {
    for (const f of ['src/app/api/my-library/route.ts', 'src/app/api/my-library/[id]/route.ts']) {
      expect(readFileSync(f, 'utf8')).toContain('managesWholeOrganization: actor.managesWholeOrganization');
    }
    expect(readFileSync('src/components/files/MyLibrarySection.tsx', 'utf8')).toContain('LIBRARY_SPACES.map');
    expect(readFileSync('src/components/chat/ReusableFilePicker.tsx', 'utf8')).toContain(">기관 자료함</button>");
    expect(readFileSync('src/app/files/page.tsx', 'utf8')).toContain('canSave={libraryCanAdd}');
  });
  it('탈퇴 처리는 내 자료함 사본만 모은다(기관 자료함은 남는다)', () => {
    expect(readFileSync('src/lib/my-library.ts', 'utf8')).toContain(".eq('user_id', userId).eq('space', 'personal')");
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0112 — 기관 자료함 자리(시험 DB)', () => {
  let pgdb: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    pgdb = new pg.Client({ connectionString: dbUrl });
    await pgdb.connect();
  });
  afterAll(async () => { await pgdb?.end(); });
  it('여러 번 적용해도 안전·기관 자리는 부서 칸 없이만', async () => {
    expect(existsSync('supabase/migrations/0112_organization_library.sql')).toBe(true);
    await pgdb.query('BEGIN');
    try {
      const sql = readFileSync('supabase/migrations/0112_organization_library.sql', 'utf8');
      await pgdb.query(sql); await pgdb.query(sql);
      const orgId = randomUUID();
      const deptId = randomUUID();
      const userId = randomUUID();
      await pgdb.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, '0112 기관']);
      await pgdb.query('INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)', [deptId, '총무과', `d-${deptId.slice(0, 8)}`, orgId]);
      await pgdb.query("INSERT INTO users (id, email, role, department_id) VALUES ($1, $2, 'ADMIN', $3)", [userId, `a-${userId.slice(0, 8)}@x.test`, deptId]);
      const ins = (space: string, dept: string | null) => pgdb.query(
        `INSERT INTO my_library_files (id, user_id, organization_id, space, department_id, folder, file_name, size_bytes, storage_path, source)
         VALUES ($1, $2, $3, $4, $5, '', 'a.pdf', 10, $6, 'attachment')`,
        [randomUUID(), userId, orgId, space, dept, `my-library/${orgId}/o/${randomUUID()}.pdf`]);
      await ins('organization', null);
      await pgdb.query('SAVEPOINT s');
      await expect(ins('organization', deptId)).rejects.toThrow(/check/i);
      await pgdb.query('ROLLBACK TO SAVEPOINT s');
      await pgdb.query('SAVEPOINT t');
      await expect(ins('everyone', null)).rejects.toThrow(/check/i);
      await pgdb.query('ROLLBACK TO SAVEPOINT t');
      await ins('department', deptId);
      await ins('personal', null);
    } finally {
      await pgdb.query('ROLLBACK');
    }
  });
});
