import { readFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * 2026-11-25 — 자료함 여러 단계 폴더(0113). `예산/2026/서식`처럼 `/`로 나눠 3단계까지(한 단계 30자),
 * 폴더를 고르면 그 아래 폴더의 파일도 함께 보이고, 폴더 목록은 윗단계까지 합친 나무로 보인다.
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
  cleanFolderName, folderLabel, folderTree, libraryIo, listLibrary, saveToLibrary, subtreeFolders, updateLibraryFile,
  LIBRARY_FOLDER_RULE, type LibraryActor, type LibraryIo,
} from '@/lib/my-library';

const ORG = '22222222-2222-4222-8222-222222222222';
const ME = '33333333-3333-4333-8333-333333333333';
const DEPT = '77777777-7777-4777-8777-777777777777';
const ID = '44444444-4444-4444-8444-444444444444';
const actor: LibraryActor = { userId: ME, organizationId: ORG, departmentId: DEPT, isAdmin: false };

describe('폴더 경로 다듬기', () => {
  it('/로 나눈 3단계까지 — 단계마다 다듬고 빈 단계는 버린다', () => {
    expect(cleanFolderName('예산/2026/서식')).toBe('예산/2026/서식');
    expect(cleanFolderName(' 예산 / 2026 //서식/ ')).toBe('예산/2026/서식');
    expect(cleanFolderName('/예산/')).toBe('예산');
    expect(cleanFolderName('///')).toBe('');
    expect(cleanFolderName(' 예산​ /[2026]')).toBe('예산/2026');
  });
  it('4단계·한 단계 31자·역슬래시·큰따옴표·글이 아닌 값은 거절', () => {
    expect(cleanFolderName('a/b/c/d')).toBeNull();
    expect(cleanFolderName(`a/${'가'.repeat(31)}`)).toBeNull();
    expect(cleanFolderName(`${'가'.repeat(30)}/${'나'.repeat(30)}/${'다'.repeat(30)}`)).toBe(`${'가'.repeat(30)}/${'나'.repeat(30)}/${'다'.repeat(30)}`);
    expect(cleanFolderName('a\\b')).toBeNull();
    expect(cleanFolderName('a"b')).toBeNull();
    expect(cleanFolderName(5)).toBeNull();
  });
  it('화면 이름', () => {
    expect(folderLabel('예산/2026')).toBe('예산 › 2026');
    expect(folderLabel('')).toBe('미분류');
  });
});

describe('폴더 나무·아래 폴더', () => {
  it('윗단계 폴더도 넣고 수는 그 아래까지 합친다 — 미분류 먼저, 깊이 우선 이름 순', () => {
    const tree = folderTree([
      { name: '예산/2026/서식', count: 2 }, { name: '', count: 1 }, { name: '감사', count: 3 }, { name: '예산', count: 1 }, { name: '예산/2025', count: 4 },
    ]);
    expect(tree).toEqual([
      { path: '', name: '미분류', depth: 0, count: 1 },
      { path: '감사', name: '감사', depth: 0, count: 3 },
      { path: '예산', name: '예산', depth: 0, count: 7 },
      { path: '예산/2025', name: '2025', depth: 1, count: 4 },
      { path: '예산/2026', name: '2026', depth: 1, count: 2 },
      { path: '예산/2026/서식', name: '서식', depth: 2, count: 2 },
    ]);
  });
  it('고른 폴더와 그 아래만 — 이름이 비슷한 옆 폴더(예산안)는 빼고, 미분류는 미분류만', () => {
    const values = ['예산', '예산/2026', '예산/2026/서식', '예산안', '감사', '', '예산/2026'];
    expect(subtreeFolders(values, '예산').sort()).toEqual(['예산', '예산/2026', '예산/2026/서식']);
    expect(subtreeFolders(values, '예산/2026').sort()).toEqual(['예산/2026', '예산/2026/서식']);
    expect(subtreeFolders(values, '없는 폴더')).toEqual(['없는 폴더']);
    expect(subtreeFolders(values, '')).toEqual(['']);
  });
});

function fakeIo(over: Partial<LibraryIo> = {}) {
  const calls: Record<string, unknown[][]> = {};
  const rec = <A extends unknown[], R>(name: string, fn: (...a: A) => R) => (...a: A) => { (calls[name] ??= []).push(a); return fn(...a); };
  const row = { id: ID, file_name: '서식.hwpx', folder: '예산', size_bytes: 9, source: 'generated', created_at: '2026-11-25T01:00:00Z', user_id: ME, storage_path: `my-library/${ORG}/${ME}/${ID}.hwpx` };
  const io: LibraryIo = {
    findSource: rec('findSource', async () => ({ storage_path: 'generated/a.hwpx', file_name: '서식.hwpx', size_bytes: 9 })),
    folderValues: rec('folderValues', async () => ['예산', '예산/2026', '예산안']),
    page: rec('page', async () => []),
    findRow: rec('findRow', async () => row),
    userNames: async () => new Map(),
    copyObject: async () => 'ok' as const,
    removeObject: async () => 'ok' as const,
    insert: rec('insert', async (r: Record<string, unknown>) => ({ ...r, created_at: 'x' })),
    update: rec('update', async (_a: unknown, _s: unknown, id: string, patch: Record<string, unknown>) => ({ ...row, id, ...patch })),
    remove: async () => 1,
    ...over,
  };
  return { io, calls };
}

describe('목록·담기·옮기기', () => {
  it('폴더를 고르면 그 폴더와 아래 폴더 목록을 쪽 읽기에 넘긴다, 전체는 거르지 않는다', async () => {
    const { io, calls } = fakeIo();
    await listLibrary(actor, { folder: '예산' }, io);
    expect((calls.page[0][2] as { folders: string[] }).folders.sort()).toEqual(['예산', '예산/2026']);
    const all = fakeIo();
    await listLibrary(actor, {}, all.io);
    expect(all.calls.page[0][2]).toMatchObject({ folder: null, folders: null });
  });
  it('여러 단계 폴더로 담고 옮긴다, 4단계는 규칙 안내로 거절', async () => {
    const a = fakeIo();
    expect(await saveToLibrary(actor, { kind: 'generated', id: ID, folder: '예산 / 2026 / 서식' }, a.io, () => ID)).toMatchObject({ ok: true, file: { folder: '예산/2026/서식' } });
    expect(a.calls.insert[0][0]).toMatchObject({ folder: '예산/2026/서식' });
    const b = fakeIo();
    expect(await updateLibraryFile(actor, ID, { folder: '감사/2026' }, b.io)).toMatchObject({ ok: true, file: { folder: '감사/2026' } });
    expect(await saveToLibrary(actor, { kind: 'generated', id: ID, folder: 'a/b/c/d' }, fakeIo().io)).toEqual({ ok: false, status: 400, message: LIBRARY_FOLDER_RULE });
  });
  it('DB 쪽 읽기는 폴더 목록이 있으면 in, 없으면 하나를 eq로', async () => {
    db.calls.length = 0;
    await libraryIo().page(actor, 'personal', { folder: '예산', folders: ['예산', '예산/2026'], query: null, cursor: null });
    await libraryIo().page(actor, 'personal', { folder: '예산', query: null, cursor: null });
    const [withTree, single] = db.calls.filter((c) => c.table === 'my_library_files').map((c) => c.ops);
    expect(withTree).toContainEqual(['in', ['folder', ['예산', '예산/2026']]]);
    expect(withTree.some(([op, a]) => op === 'eq' && a[0] === 'folder')).toBe(false);
    expect(single).toContainEqual(['eq', ['folder', '예산']]);
  });
});

describe('잇기', () => {
  it('자료함 화면·지난 파일이 나무와 경로 이름으로 보인다', () => {
    const section = readFileSync('src/components/files/MyLibrarySection.tsx', 'utf8');
    expect(section).toContain('folderTree(page?.folders ?? [])');
    expect(section).toContain('{folderLabel(f.folder)}');
    expect(readFileSync('src/components/chat/ReusableFilePicker.tsx', 'utf8')).toContain('folderTree(folders).map');
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0113 — 폴더 경로 길이(시험 DB)', () => {
  let pgdb: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    pgdb = new pg.Client({ connectionString: dbUrl });
    await pgdb.connect();
  });
  afterAll(async () => { await pgdb?.end(); });
  it('여러 번 적용해도 안전·100자까지(옛 30자 CHECK는 사라짐)', async () => {
    expect(existsSync('supabase/migrations/0113_library_nested_folders.sql')).toBe(true);
    await pgdb.query('BEGIN');
    try {
      const sql = readFileSync('supabase/migrations/0113_library_nested_folders.sql', 'utf8');
      await pgdb.query(sql); await pgdb.query(sql);
      const checks = await pgdb.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid = 'public.my_library_files'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%folder%'`);
      expect(checks.rows).toHaveLength(1);
      const orgId = randomUUID();
      const userId = randomUUID();
      await pgdb.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, '0113 기관']);
      await pgdb.query("INSERT INTO users (id, email, role) VALUES ($1, $2, 'USER')", [userId, `u-${userId.slice(0, 8)}@x.test`]);
      const ins = (folder: string) => pgdb.query(
        `INSERT INTO my_library_files (id, user_id, organization_id, folder, file_name, size_bytes, storage_path, source)
         VALUES ($1, $2, $3, $4, 'a.pdf', 10, $5, 'attachment')`, [randomUUID(), userId, orgId, folder, `my-library/${orgId}/${randomUUID()}.pdf`]);
      await ins(`${'가'.repeat(30)}/${'나'.repeat(30)}/${'다'.repeat(30)}`);
      await pgdb.query('SAVEPOINT s');
      await expect(ins('가'.repeat(101))).rejects.toThrow(/check/i);
      await pgdb.query('ROLLBACK TO SAVEPOINT s');
    } finally {
      await pgdb.query('ROLLBACK');
    }
  });
});
