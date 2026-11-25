import { readFileSync, existsSync } from 'fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * 2026-11-24 — 내 자료함(0103). 직원이 대화에 올린 파일·비서가 만들어 준 파일을 사본으로 담아 폴더로 나눠 두고,
 * 대화·입력형 앱의 '지난 파일'에서 새 첨부로 다시 붙인다. 주인·기관을 매번 서버가 다시 본다.
 */

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/config', () => ({ SUPABASE_DOCUMENTS_BUCKET: 'documents' }));

import {
  cleanFolderName, cleanLibraryFileName, folderCounts, libraryPath, listLibrary, saveToLibrary, updateLibraryFile, deleteLibraryFile,
  findLibraryOriginal, LIBRARY_MAX_FILES, LIBRARY_MAX_FOLDERS, LIBRARY_MAX_BYTES, LIBRARY_PAGE, type LibraryIo,
} from '@/lib/my-library';
import { API_ROUTES } from '@/lib/api-route-ids';

const ORG = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const ID = '44444444-4444-4444-8444-444444444444';
const NEW_ID = '55555555-5555-4555-8555-555555555555';
const actor = { userId: USER, organizationId: ORG, departmentId: 'dept-1', isAdmin: false };

function fakeIo(over: Partial<LibraryIo> = {}) {
  const calls: Record<string, unknown[][]> = {};
  const rec = <A extends unknown[], R>(name: string, fn: (...a: A) => R) => (...a: A) => { (calls[name] ??= []).push(a); return fn(...a); };
  const io: LibraryIo = {
    findSource: rec('findSource', async () => ({ storage_path: 'chat-uploads/o/u/x.xlsx', file_name: '예산 취합.xlsx', size_bytes: 1200 })),
    folderValues: rec('folderValues', async () => ['', '예산', '예산']),
    page: rec('page', async () => []),
    findRow: rec('findRow', async () => ({ id: ID, file_name: '예산 취합.xlsx', folder: '예산', size_bytes: 1200, source: 'attachment', created_at: '2026-11-24T01:00:00Z', user_id: USER, storage_path: `my-library/${ORG}/${USER}/${ID}.xlsx` })),
    copyObject: rec('copyObject', async () => 'ok' as const),
    removeObject: rec('removeObject', async () => 'ok' as const),
    insert: rec('insert', async (row: Record<string, unknown>) => ({ ...row, created_at: '2026-11-24T02:00:00Z' })),
    update: rec('update', async (_a: unknown, _s: unknown, id: string, patch: Record<string, unknown>) => ({ id, file_name: '예산 취합.xlsx', folder: '예산', size_bytes: 1200, source: 'attachment', created_at: '2026-11-24T01:00:00Z', ...patch })),
    remove: rec('remove', async () => 1),
    userNames: rec('userNames', async () => new Map<string, string>()),
    ...over,
  };
  return { io, calls };
}

describe('다듬기 규칙', () => {
  it('폴더 이름 — 빈 글은 미분류, 공백·보이지 않는 글자 정리, 30자·/ 거절', () => {
    expect(cleanFolderName(undefined)).toBe('');
    expect(cleanFolderName('  ')).toBe('');
    expect(cleanFolderName(' 예산​  자료 ')).toBe('예산 자료');
    expect(cleanFolderName('가'.repeat(30))).toBe('가'.repeat(30));
    expect(cleanFolderName('가'.repeat(31))).toBeNull();
    expect(cleanFolderName('예산/2026/서식/1분기')).toBeNull(); // 0113 — 3단계까지
    expect(cleanFolderName(3)).toBeNull();
  });
  it('파일 이름 — 확장자는 그대로여야 한다', () => {
    expect(cleanLibraryFileName(' 2026 예산.xlsx ', '예산.xlsx')).toEqual({ ok: true, name: '2026 예산.xlsx' });
    expect(cleanLibraryFileName('예산.csv', '예산.xlsx').ok).toBe(false);
    expect(cleanLibraryFileName('', '예산.xlsx').ok).toBe(false);
    expect(cleanLibraryFileName('a/b.xlsx', '예산.xlsx').ok).toBe(false);
    expect(cleanLibraryFileName(`${'가'.repeat(120)}.xlsx`, '예산.xlsx').ok).toBe(false);
  });
  it('폴더 목록 — 미분류 먼저·이름 순·수', () => {
    expect(folderCounts(['예산', '', '감사', '예산'])).toEqual([{ name: '', count: 1 }, { name: '감사', count: 1 }, { name: '예산', count: 2 }]);
  });
  it('경로 — 서버가 기관·직원·id로 정한다', () => {
    expect(libraryPath('personal', { organizationId: ORG, userId: USER, departmentId: 'dept-1' }, ID, '보고서.HWPX')).toBe(`my-library/${ORG}/${USER}/${ID}.hwpx`);
  });
});

describe('담기', () => {
  it('사본을 서버가 정한 경로에 만들고 행을 넣는다', async () => {
    const { io, calls } = fakeIo();
    const r = await saveToLibrary(actor, { kind: 'attachment', id: ID.toUpperCase(), folder: ' 예산 ' }, io, () => NEW_ID);
    expect(r).toMatchObject({ ok: true, file: { id: NEW_ID, folder: '예산', file_name: '예산 취합.xlsx', source: 'attachment' } });
    expect(calls.findSource[0]).toEqual([USER, 'attachment', ID]);
    expect(calls.copyObject[0]).toEqual(['chat-uploads/o/u/x.xlsx', `my-library/${ORG}/${USER}/${NEW_ID}.xlsx`]);
    expect(calls.insert[0][0]).toMatchObject({ id: NEW_ID, user_id: USER, organization_id: ORG, folder: '예산', storage_path: `my-library/${ORG}/${USER}/${NEW_ID}.xlsx`, source: 'attachment', size_bytes: 1200 });
    // 화면 응답에 경로가 없다
    expect(JSON.stringify(r)).not.toContain('storage_path');
  });
  it('남의 것·없는 것·꼴이 틀린 요청은 404, 읽기 실패는 503', async () => {
    expect(await saveToLibrary(actor, { kind: 'attachment', id: ID }, fakeIo({ findSource: async () => null }).io)).toMatchObject({ ok: false, status: 404 });
    expect(await saveToLibrary(actor, { kind: 'folder', id: ID }, fakeIo().io)).toMatchObject({ ok: false, status: 404 });
    expect(await saveToLibrary(actor, { kind: 'generated', id: 'abc' }, fakeIo().io)).toMatchObject({ ok: false, status: 404 });
    expect(await saveToLibrary(actor, { kind: 'generated', id: ID }, fakeIo({ folderValues: async () => { throw new Error('db'); } }).io)).toMatchObject({ ok: false, status: 503 });
  });
  it('형식·크기·개수·폴더 수 상한', async () => {
    expect(await saveToLibrary(actor, { kind: 'generated', id: ID }, fakeIo({ findSource: async () => ({ storage_path: 'g/x.exe', file_name: 'x.exe', size_bytes: 10 }) }).io)).toMatchObject({ ok: false, status: 400 });
    expect(await saveToLibrary(actor, { kind: 'generated', id: ID }, fakeIo({ findSource: async () => ({ storage_path: 'g/x.hwpx', file_name: 'x.hwpx', size_bytes: LIBRARY_MAX_BYTES + 1 }) }).io)).toMatchObject({ ok: false, status: 400 });
    expect(await saveToLibrary(actor, { kind: 'generated', id: ID }, fakeIo({ folderValues: async () => Array(LIBRARY_MAX_FILES).fill('') }).io)).toMatchObject({ ok: false, status: 409 });
    const many = Array.from({ length: LIBRARY_MAX_FOLDERS }, (_, i) => `폴더${i}`);
    expect(await saveToLibrary(actor, { kind: 'generated', id: ID, folder: '새 폴더' }, fakeIo({ folderValues: async () => many }).io)).toMatchObject({ ok: false, status: 409 });
    // 있는 폴더·미분류에는 담긴다
    expect((await saveToLibrary(actor, { kind: 'generated', id: ID, folder: '폴더3' }, fakeIo({ folderValues: async () => many }).io)).ok).toBe(true);
    expect((await saveToLibrary(actor, { kind: 'generated', id: ID }, fakeIo({ folderValues: async () => many }).io)).ok).toBe(true);
    expect(await saveToLibrary(actor, { kind: 'generated', id: ID, folder: 'a/b/c/d' }, fakeIo().io)).toMatchObject({ ok: false, status: 400 });
  });
  it('원본이 없으면 404, 복사 실패는 503, 행을 못 넣으면 사본을 지운다', async () => {
    expect(await saveToLibrary(actor, { kind: 'generated', id: ID }, fakeIo({ copyObject: async () => 'missing' }).io)).toMatchObject({ ok: false, status: 404 });
    expect(await saveToLibrary(actor, { kind: 'generated', id: ID }, fakeIo({ copyObject: async () => 'error' }).io)).toMatchObject({ ok: false, status: 503 });
    const { io, calls } = fakeIo({ insert: async () => { throw new Error('db'); } });
    expect(await saveToLibrary(actor, { kind: 'generated', id: ID }, io, () => NEW_ID)).toMatchObject({ ok: false, status: 503 });
    expect(calls.removeObject[0]).toEqual([`my-library/${ORG}/${USER}/${NEW_ID}.xlsx`]);
  });
});

describe('목록', () => {
  it('폴더 목록·전체 수·다음 쪽', async () => {
    const rows = Array.from({ length: LIBRARY_PAGE + 1 }, (_, i) => ({ id: `${'0'.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`, file_name: `f${i}.pdf`, folder: '', size_bytes: 1, source: 'generated', created_at: '2026-11-24T00:00:00.000Z' }));
    const pageCalls: unknown[][] = [];
    const { io } = fakeIo({ page: async (...a) => { pageCalls.push(a); return rows; } });
    const r = await listLibrary(actor, { folder: '예산', q: '  예산​ ' }, io);
    expect(r.ok && r.data.files.length).toBe(LIBRARY_PAGE);
    expect(r.ok && r.data.next).toBeTruthy();
    expect(r.ok && r.data.folders).toEqual([{ name: '', count: 1 }, { name: '예산', count: 2 }]);
    expect(r.ok && r.data.total).toBe(3);
    expect(pageCalls[0][2]).toMatchObject({ folder: '예산', query: '예산', cursor: null });
  });
  it('폴더 안 고르면 전체, 틀린 위치·폴더는 400, 읽기 실패는 503', async () => {
    const { io, calls } = fakeIo();
    await listLibrary(actor, {}, io);
    expect(calls.page[0][1]).toBe('personal');
    expect(calls.page[0][2]).toMatchObject({ folder: null });
    expect(await listLibrary(actor, { cursor: 'zzz' }, fakeIo().io)).toMatchObject({ ok: false, status: 400 });
    expect(await listLibrary(actor, { folder: 'a/b/c/d' }, fakeIo().io)).toMatchObject({ ok: false, status: 400 });
    expect(await listLibrary(actor, {}, fakeIo({ page: async () => { throw new Error('db'); } }).io)).toMatchObject({ ok: false, status: 503 });
  });
});

describe('고치기·지우기·원본', () => {
  it('이름·폴더 바꾸기 — 확장자 바꾸기 400, 없는 것 404, 새 폴더 상한 409', async () => {
    const { io, calls } = fakeIo();
    expect(await updateLibraryFile(actor, ID, { file_name: '새 이름.xlsx', folder: '감사' }, io)).toMatchObject({ ok: true, file: { file_name: '새 이름.xlsx', folder: '감사' } });
    expect(calls.update[0][3]).toMatchObject({ file_name: '새 이름.xlsx', folder: '감사' });
    expect(await updateLibraryFile(actor, ID, { file_name: '새 이름.pdf' }, fakeIo().io)).toMatchObject({ ok: false, status: 400 });
    expect(await updateLibraryFile(actor, ID, {}, fakeIo().io)).toMatchObject({ ok: false, status: 400 });
    expect(await updateLibraryFile(actor, ID, { folder: '감사' }, fakeIo({ findRow: async () => null }).io)).toMatchObject({ ok: false, status: 404 });
    expect(await updateLibraryFile(actor, 'nope', { folder: '감사' }, fakeIo().io)).toMatchObject({ ok: false, status: 404 });
    const many = Array.from({ length: LIBRARY_MAX_FOLDERS }, (_, i) => `폴더${i}`);
    expect(await updateLibraryFile(actor, ID, { folder: '새 폴더' }, fakeIo({ folderValues: async () => many }).io)).toMatchObject({ ok: false, status: 409 });
  });
  it('지우기 — 사본 먼저, 사본을 못 지우면 행을 남긴다', async () => {
    const { io, calls } = fakeIo();
    expect(await deleteLibraryFile(actor, ID, undefined, io)).toEqual({ ok: true });
    expect(calls.removeObject[0]).toEqual([`my-library/${ORG}/${USER}/${ID}.xlsx`]);
    const failing = fakeIo({ removeObject: async () => 'error' });
    expect(await deleteLibraryFile(actor, ID, undefined, failing.io)).toMatchObject({ ok: false, status: 503 });
    expect(failing.calls.remove).toBeUndefined();
    // 사본이 이미 없으면 행만 지운다
    expect(await deleteLibraryFile(actor, ID, undefined, fakeIo({ removeObject: async () => 'missing' }).io)).toEqual({ ok: true });
    expect(await deleteLibraryFile(actor, ID, undefined, fakeIo({ findRow: async () => null }).io)).toMatchObject({ ok: false, status: 404 });
  });
  it('원본 찾기는 주인·기관 조건으로', async () => {
    const { io, calls } = fakeIo();
    expect(await findLibraryOriginal(actor, ID, io)).toEqual({ storage_path: `my-library/${ORG}/${USER}/${ID}.xlsx`, file_name: '예산 취합.xlsx' });
    expect(calls.findRow[0]).toEqual([actor, 'personal', ID]);
    expect(await findLibraryOriginal(actor, 'x', io)).toBeNull();
  });
  it('실제 저장소·DB 길은 모든 조회·변경에 주인과 기관을 건다', () => {
    const src = readFileSync('src/lib/my-library.ts', 'utf8');
    const io = src.slice(src.indexOf('export function libraryIo'));
    // 자리 조건(scoped)이 내 자료함은 담은 사람·기관, 부서 자료함은 지금 부서·기관을 건다
    expect(io).toContain(".eq('space', 'personal').eq('user_id', actor.userId).eq('organization_id', actor.organizationId)");
    expect(io).toContain(".eq('space', 'department').eq('department_id', actor.departmentId).eq('organization_id', actor.organizationId)");
    // 넣기 말고 여섯(폴더 값·쪽·한 행·고치기·지우기·폴더째 옮기기 0294) 모두 그 조건으로
    expect(io.split('scoped(').length - 1).toBe(6);
  });
});

describe('잇기', () => {
  it('다시 붙이기가 내 자료함을 주인·기관 조건으로 찾는다', () => {
    const reuse = readFileSync('src/lib/attachments/reuse.ts', 'utf8');
    expect(reuse).toContain("kind !== 'library'");
    expect(reuse).toContain('findLibraryOriginal({ userId: actor.userId, organizationId: actor.organizationId, departmentId: actor.departmentId, isAdmin: false }, id)');
    expect(readFileSync('src/lib/attachments/reuse-types.ts', 'utf8')).toContain("'attachment' | 'generated' | 'library'");
  });
  it('지난 파일 고르기에 내 자료함 탭, 결과물 화면에 자료함·담기', () => {
    const picker = readFileSync('src/components/chat/ReusableFilePicker.tsx', 'utf8');
    expect(picker).toContain("kind: 'library'");
    expect(picker).toContain('/api/my-library');
    const page = readFileSync('src/app/files/page.tsx', 'utf8');
    expect(page).toContain('<MyLibrarySection');
    expect(page).toContain('saveKind="generated"');
    expect(page).toContain('saveKind="attachment"');
  });
  it('탈퇴 처리가 경로를 먼저 모으고 행·사본을 지운다', () => {
    const src = readFileSync('src/lib/user-withdrawal.ts', 'utf8');
    const paths = src.indexOf('listUserLibraryPaths(userId)');
    const convDelete = src.indexOf("from('conversations').delete()");
    const rowDelete = src.indexOf("from('my_library_files').delete()");
    const stamp = src.indexOf('deleted_at: new Date()');
    const objects = src.indexOf('removeUserFiles(userId, libraryPaths)');
    expect(paths).toBeGreaterThan(0);
    expect(paths).toBeLessThan(convDelete);
    expect(rowDelete).toBeGreaterThan(convDelete);
    expect(objects).toBeGreaterThan(stamp);
  });
  it('라우트 셋이 목록에 있고 모두 세션을 본다', () => {
    for (const r of ['my-library', 'my-library/[id]', 'my-library/[id]/original']) expect(API_ROUTES).toContain(r);
    for (const f of ['src/app/api/my-library/route.ts', 'src/app/api/my-library/[id]/route.ts', 'src/app/api/my-library/[id]/original/route.ts']) {
      const src = readFileSync(f, 'utf8');
      expect(src).toContain('getServerAuthSession()');
      expect(src).toContain('actorScopeOr503');
      expect(src).not.toContain('request.json()');
    }
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0103 — 내 자료함 표(시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('여러 번 적용해도 안전·RLS 켜짐·꼴 CHECK', async () => {
    expect(existsSync('supabase/migrations/0103_my_library.sql')).toBe(true);
    await db.query('BEGIN');
    try {
      const sql = readFileSync('supabase/migrations/0103_my_library.sql', 'utf8');
      await db.query(sql); await db.query(sql);
      const rls = await db.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'my_library_files'");
      expect(rls.rows).toEqual([{ relrowsecurity: true }]);
      const { rows: [org] } = await db.query("INSERT INTO organizations (name) VALUES ('시험 기관 0281') RETURNING id");
      const { rows: [dept] } = await db.query("INSERT INTO departments (name, slug, organization_id) VALUES ('시험 부서', 'test-0281', $1) RETURNING id", [org.id]);
      const { rows: [user] } = await db.query("INSERT INTO users (email, full_name, department_id, role) VALUES ('t0281@example.com', '시험', $1, 'USER') RETURNING id", [dept.id]);
      const insert = (over: Record<string, unknown>) => {
        const v = { folder: '', file_name: 'a.xlsx', size_bytes: 1, storage_path: `my-library/${org.id}/${user.id}/x${Math.random()}.xlsx`, source: 'attachment', ...over };
        return db.query('INSERT INTO my_library_files (user_id, organization_id, folder, file_name, size_bytes, storage_path, source) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [user.id, org.id, v.folder, v.file_name, v.size_bytes, v.storage_path, v.source]);
      };
      await insert({});
      for (const bad of [{ folder: '가'.repeat(101) } /* 0113 — 폴더 경로는 100자까지 */, { storage_path: 'generated/x.xlsx' }, { source: 'upload' }, { size_bytes: 0 }, { file_name: '' }]) {
        await db.query('SAVEPOINT s');
        await expect(insert(bad)).rejects.toThrow();
        await db.query('ROLLBACK TO SAVEPOINT s');
      }
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
