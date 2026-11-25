import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-25 — 여러 파일·폴더째 다른 자료함으로 복사·옮기기(0298, 마이그레이션 없음). 50개까지.
 * 보내기 전에 권한·받는 자리 상한을 한꺼번에 보고(하나라도 안 되면 아무것도 안 보냄), 폴더째면 폴더 이름·아래 구조를 받는 폴더 아래 그대로.
 */

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/config', () => ({ SUPABASE_DOCUMENTS_BUCKET: 'documents' }));
vi.mock('@/lib/logger', () => ({ logSystem: async () => {} }));

import { transferLibraryFiles, transferFolderPath, LIBRARY_TRANSFER_MAX, LIBRARY_ORG_ONLY, type LibraryActor, type LibraryIo, type LibrarySpace } from '@/lib/my-library';
import { API_ROUTES } from '@/lib/api-route-ids';

const ORG = '22222222-2222-4222-8222-222222222222';
const ME = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const DEPT = '77777777-7777-4777-8777-777777777777';
const staff: LibraryActor = { userId: ME, organizationId: ORG, departmentId: DEPT, isAdmin: false, managesWholeOrganization: false };
const subAdmin: LibraryActor = { ...staff, isAdmin: true };
const orgAdmin: LibraryActor = { ...staff, isAdmin: true, managesWholeOrganization: true };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type R = { id: string; file_name: string; folder: string; user_id: string; storage_path: string; size_bytes: number; source: string; created_at: string };
const row = (n: number, folder: string, owner = ME): R => ({
  id: id(n), file_name: `파일${n}.xlsx`, folder, user_id: owner, storage_path: `my-library/${ORG}/d/${DEPT}/${id(n)}.xlsx`, size_bytes: 10, source: 'attachment', created_at: '2026-11-25T00:00:00Z',
});

function fakeIo(rows: R[], opts: { target?: string[] } = {}, over: Partial<LibraryIo> = {}) {
  const calls: string[] = [];
  const inserted: Record<string, unknown>[] = [];
  const io = {
    folderValues: async (_a: LibraryActor, s: LibrarySpace) => (s === 'department' ? rows.map((r) => r.folder) : (opts.target ?? [])),
    findRows: async (_a: LibraryActor, _s: LibrarySpace, o: { ids?: string[]; folders?: string[]; limit: number }) => {
      calls.push(`findRows:${o.ids ? 'ids' : 'folders'}:${(o.ids ?? o.folders ?? []).length}`);
      return rows.filter((r) => (o.ids ? o.ids.includes(r.id) : o.folders!.includes(r.folder))).slice(0, o.limit);
    },
    copyObject: async (from: string) => { calls.push(`copy:${from}`); return 'ok' as const; },
    removeObject: async (p: string) => { calls.push(`removeObject:${p}`); return 'ok' as const; },
    insert: async (r: Record<string, unknown>) => { inserted.push(r); return { ...r, created_at: '2026-11-25T01:00:00Z' }; },
    remove: async (_a: LibraryActor, _s: LibrarySpace, key: string) => { calls.push(`remove:${key}`); return 1; },
    ...over,
  } as unknown as LibraryIo;
  let n = 100;
  return { io, calls, inserted, newId: () => id(++n) };
}

describe('폴더째 받는 경로', () => {
  it('폴더 이름과 아래 구조를 받는 폴더 아래 그대로, 3단계를 넘으면 null', () => {
    expect(transferFolderPath('예산', '예산', '')).toBe('예산');
    expect(transferFolderPath('예산', '예산/2026', '')).toBe('예산/2026');
    expect(transferFolderPath('예산', '예산/2026', '공유')).toBe('공유/예산/2026');
    expect(transferFolderPath('재무/예산', '재무/예산/2026', '')).toBe('예산/2026');
    expect(transferFolderPath('예산', '예산/2026/서식', '공유')).toBeNull();
    expect(transferFolderPath('예산', '예산안', '')).toBeNull();
  });
});

describe('여러 파일 보내기', () => {
  it('고른 파일을 모두 받는 폴더로 복사 — 담은 사람은 나, 원래 파일은 그대로', async () => {
    const rows = [row(1, '예산'), row(2, '', OTHER)];
    const { io, calls, inserted, newId } = fakeIo(rows);
    const r = await transferLibraryFiles(staff, { space: 'department', to: 'personal', mode: 'copy', folder: '받은 것', ids: [id(1), id(2).toUpperCase()] }, io, newId);
    expect(r).toEqual({ ok: true, mode: 'copy', to: 'personal', sent: 2, failed: [], warnings: [] });
    expect(inserted.map((x) => [x.folder, x.user_id, x.space])).toEqual([['받은 것', ME, 'personal'], ['받은 것', ME, 'personal']]);
    expect(calls.some((c) => c.startsWith('remove'))).toBe(false);
  });
  it('옮기기는 모두 바꿀 수 있어야 — 하나라도 남의 파일이면 아무것도 보내지 않는다(관리자는 된다)', async () => {
    const rows = [row(1, ''), row(2, '', OTHER)];
    const staffRun = fakeIo(rows);
    expect(await transferLibraryFiles(staff, { space: 'department', to: 'personal', mode: 'move', ids: [id(1), id(2)] }, staffRun.io, staffRun.newId))
      .toMatchObject({ ok: false, status: 403, message: expect.stringContaining('1개') });
    expect(staffRun.calls.some((c) => c.startsWith('copy'))).toBe(false);
    const adminRun = fakeIo(rows);
    expect(await transferLibraryFiles(subAdmin, { space: 'department', to: 'personal', mode: 'move', ids: [id(1), id(2)] }, adminRun.io, adminRun.newId)).toMatchObject({ ok: true, sent: 2 });
    expect(adminRun.calls.filter((c) => c.startsWith('remove:'))).toEqual([`remove:${id(1)}`, `remove:${id(2)}`]);
  });
  it('볼 수 없는 파일이 섞이면 404, 받는 자리가 모자라면 409 — 보내기 전에', async () => {
    const { io, calls, newId } = fakeIo([row(1, '')]);
    expect(await transferLibraryFiles(staff, { space: 'department', to: 'personal', mode: 'copy', ids: [id(1), id(9)] }, io, newId)).toMatchObject({ ok: false, status: 404 });
    const full = fakeIo([row(1, ''), row(2, '')], { target: Array.from({ length: 299 }, () => '') });
    expect(await transferLibraryFiles(staff, { space: 'department', to: 'personal', mode: 'copy', ids: [id(1), id(2)] }, full.io, full.newId)).toMatchObject({ ok: false, status: 409, message: expect.stringContaining('1개만') });
    const folders = fakeIo([row(1, '')], { target: Array.from({ length: 30 }, (_, i) => `f${i}`) });
    expect(await transferLibraryFiles(staff, { space: 'department', to: 'personal', mode: 'copy', folder: '새', ids: [id(1)] }, folders.io, folders.newId)).toMatchObject({ ok: false, status: 409 });
    expect([...calls, ...full.calls, ...folders.calls].some((c) => c.startsWith('copy'))).toBe(false);
  });
  it('도중에 실패한 파일은 건너뛰고 이어 가며 실패 목록으로 알린다', async () => {
    const rows = [row(1, ''), row(2, ''), row(3, '')];
    const { io, newId } = fakeIo(rows, {}, { copyObject: async (from: string) => (from.includes(id(2)) ? 'missing' as const : 'ok' as const) });
    const r = await transferLibraryFiles(staff, { space: 'department', to: 'personal', mode: 'copy', ids: [id(1), id(2), id(3)] }, io, newId);
    expect(r).toMatchObject({ ok: true, sent: 2, failed: [{ id: id(2), file_name: '파일2.xlsx', message: expect.stringContaining('남아 있지') }] });
  });
  it('옮기다 원래 행을 못 지우면 경고 목록에', async () => {
    const { io, newId } = fakeIo([row(1, '')], {}, { remove: async () => { throw new Error('db'); } });
    const r = await transferLibraryFiles(staff, { space: 'department', to: 'personal', mode: 'move', ids: [id(1)] }, io, newId);
    expect(r).toMatchObject({ ok: true, sent: 1, warnings: [expect.stringContaining('두 곳에')] });
  });
});

describe('폴더째 보내기', () => {
  it('그 폴더와 아래 폴더의 파일을, 이름이 비슷한 옆 폴더는 빼고, 구조를 지켜 보낸다', async () => {
    const rows = [row(1, '예산'), row(2, '예산/2026'), row(3, '예산안'), row(4, '')];
    const { io, calls, inserted, newId } = fakeIo(rows);
    const r = await transferLibraryFiles(staff, { space: 'department', to: 'personal', mode: 'copy', folder: '공유', fromFolder: '예산' }, io, newId);
    expect(r).toMatchObject({ ok: true, sent: 2 });
    expect(calls[0]).toBe('findRows:folders:2');
    expect(inserted.map((x) => x.folder)).toEqual(['공유/예산', '공유/예산/2026']);
  });
  it('받는 폴더 아래에 두면 3단계를 넘으면 400, 빈 폴더 404, 50개 넘으면 400, 미분류는 폴더째로 못 보냄', async () => {
    const deep = fakeIo([row(1, '예산/2026/서식')]);
    expect(await transferLibraryFiles(staff, { space: 'department', to: 'personal', mode: 'copy', folder: '공유', fromFolder: '예산' }, deep.io, deep.newId)).toMatchObject({ ok: false, status: 400 });
    const empty = fakeIo([row(1, '감사')]);
    expect(await transferLibraryFiles(staff, { space: 'department', to: 'personal', mode: 'copy', fromFolder: '예산' }, empty.io, empty.newId)).toMatchObject({ ok: false, status: 404 });
    const many = fakeIo(Array.from({ length: LIBRARY_TRANSFER_MAX + 1 }, (_, i) => row(i + 1, '예산')));
    expect(await transferLibraryFiles(staff, { space: 'department', to: 'personal', mode: 'copy', fromFolder: '예산' }, many.io, many.newId)).toMatchObject({ ok: false, status: 400, message: expect.stringContaining('나눠') });
    expect(await transferLibraryFiles(staff, { space: 'department', to: 'personal', mode: 'copy', fromFolder: '' }, empty.io, empty.newId)).toMatchObject({ ok: false, status: 400 });
  });
});

describe('입력 거절', () => {
  it('같은 자리·방식·ids와 fromFolder 둘 다/둘 다 없음·빈 목록·51개·id 꼴·기관 자료함은 기관 전체 관리자만', async () => {
    const { io, calls, newId } = fakeIo([row(1, '')]);
    const base = { space: 'department', to: 'personal', mode: 'copy' };
    expect(await transferLibraryFiles(staff, { ...base, to: 'department', ids: [id(1)] }, io, newId)).toMatchObject({ ok: false, status: 400 });
    expect(await transferLibraryFiles(staff, { ...base, mode: 'x', ids: [id(1)] }, io, newId)).toMatchObject({ ok: false, status: 400 });
    expect(await transferLibraryFiles(staff, { ...base, ids: [id(1)], fromFolder: '예산' }, io, newId)).toMatchObject({ ok: false, status: 400 });
    expect(await transferLibraryFiles(staff, { ...base }, io, newId)).toMatchObject({ ok: false, status: 400 });
    expect(await transferLibraryFiles(staff, { ...base, ids: [] }, io, newId)).toMatchObject({ ok: false, status: 400 });
    expect(await transferLibraryFiles(staff, { ...base, ids: Array.from({ length: LIBRARY_TRANSFER_MAX + 1 }, (_, i) => id(i)) }, io, newId)).toMatchObject({ ok: false, status: 400 });
    expect(await transferLibraryFiles(staff, { ...base, ids: ['abc'] }, io, newId)).toMatchObject({ ok: false, status: 404 });
    expect(await transferLibraryFiles(subAdmin, { ...base, to: 'organization', ids: [id(1)] }, io, newId)).toEqual({ ok: false, status: 403, message: LIBRARY_ORG_ONLY });
    expect(calls).toEqual([]);
    expect(await transferLibraryFiles(orgAdmin, { ...base, to: 'organization', ids: [id(1)] }, io, newId)).toMatchObject({ ok: true, sent: 1 });
  });
  it('못 읽으면 503', async () => {
    const { io, newId } = fakeIo([row(1, '')], {}, { findRows: async () => { throw new Error('db'); } });
    expect(await transferLibraryFiles(staff, { space: 'department', to: 'personal', mode: 'copy', ids: [id(1)] }, io, newId)).toMatchObject({ ok: false, status: 503 });
  });
});

describe('잇기', () => {
  it('라우트·라우트 목록·화면', () => {
    expect(API_ROUTES).toContain('my-library/transfer');
    const route = readFileSync('src/app/api/my-library/transfer/route.ts', 'utf8');
    expect(route).toContain('transferLibraryFiles(');
    expect(route).toContain('ids: body.ids, fromFolder: body.fromFolder');
    expect(route).toContain('share: body.share, to: body.to, toShare: body.toShare');
    const ui = readFileSync('src/components/files/MyLibrarySection.tsx', 'utf8');
    expect(ui).toContain("api<BatchResult>('/api/my-library/transfer'");
    expect(ui).toContain("...(what.kind === 'files' ? { ids: what.ids } : { fromFolder: what.folder })");
    expect(ui).toContain('useEffect(() => { setSelected([]); }, [query, folder, refreshKey]);');
  });
});
