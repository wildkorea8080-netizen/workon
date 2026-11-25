import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-25 — 자료함 사이 복사·옮기기(0296, 마이그레이션 없음). 내 자료함·부서 자료함·기관 자료함 사이에서 파일 하나를.
 * 복사는 볼 수 있으면 누구나, 옮기기는 원래 자리에서 바꿀 수 있는 사람만, 받는 자리는 담을 수 있어야(기관 자료함은 기관 전체 관리자만).
 */

const logged: unknown[] = [];
vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/config', () => ({ SUPABASE_DOCUMENTS_BUCKET: 'documents' }));
vi.mock('@/lib/logger', () => ({ logSystem: async (p: unknown) => { logged.push(p); } }));

import { transferLibraryFile, transferTargets, LIBRARY_ORG_ONLY, LIBRARY_NOT_YOURS, LIBRARY_NOT_FOUND, type LibraryActor, type LibraryIo, type LibrarySpace } from '@/lib/my-library';
import { listLibrary } from '@/lib/my-library';

const ORG = '22222222-2222-4222-8222-222222222222';
const ME = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const DEPT = '77777777-7777-4777-8777-777777777777';
const FILE = '55555555-5555-4555-8555-555555555555';
const NEW = '66666666-6666-4666-8666-666666666666';
const staff: LibraryActor = { userId: ME, organizationId: ORG, departmentId: DEPT, isAdmin: false, managesWholeOrganization: false };
const subAdmin: LibraryActor = { ...staff, isAdmin: true };
const orgAdmin: LibraryActor = { ...staff, isAdmin: true, managesWholeOrganization: true };

function fakeIo(opts: { owner?: string; space?: LibrarySpace; values?: string[] } = {}, over: Partial<LibraryIo> = {}) {
  const calls: string[] = [];
  const inserted: Record<string, unknown>[] = [];
  const row = {
    id: FILE, file_name: '예산서식.xlsx', folder: '예산', size_bytes: 1234, source: 'generated', created_at: '2026-11-24T01:00:00Z',
    user_id: opts.owner ?? ME, storage_path: `my-library/${ORG}/d/${DEPT}/${FILE}.xlsx`,
  };
  const io = {
    findRow: async (_a: LibraryActor, s: LibrarySpace) => { calls.push(`findRow:${s}`); return s === (opts.space ?? 'department') ? row : null; },
    folderValues: async (_a: LibraryActor, s: LibrarySpace) => { calls.push(`folderValues:${s}`); return opts.values ?? ['', '서식']; },
    copyObject: async (from: string, to: string) => { calls.push(`copy:${from}->${to}`); return 'ok' as const; },
    removeObject: async (path: string) => { calls.push(`removeObject:${path}`); return 'ok' as const; },
    insert: async (r: Record<string, unknown>) => { calls.push('insert'); inserted.push(r); return { ...r, created_at: '2026-11-25T01:00:00Z' }; },
    remove: async (_a: LibraryActor, s: LibrarySpace, id: string) => { calls.push(`remove:${s}:${id}`); return 1; },
    ...over,
  } as unknown as LibraryIo;
  return { io, calls, inserted, row };
}
const newId = () => NEW;

describe('자료함 사이 복사', () => {
  it('부서 자료함 → 내 자료함 복사: 새 사본·새 행(담은 사람은 나, 원래 담은 곳 그대로), 원래 파일은 그대로', async () => {
    const { io, calls, inserted } = fakeIo({ owner: OTHER });
    const r = await transferLibraryFile(staff, FILE, { space: 'department', to: 'personal', mode: 'copy', folder: '서식' }, io, newId);
    expect(r).toMatchObject({ ok: true, mode: 'copy', to: 'personal', file: { id: NEW, folder: '서식', mine: true } });
    expect(inserted[0]).toMatchObject({
      id: NEW, user_id: ME, organization_id: ORG, space: 'personal', department_id: null, folder: '서식',
      file_name: '예산서식.xlsx', size_bytes: 1234, source: 'generated', storage_path: `my-library/${ORG}/${ME}/${NEW}.xlsx`,
    });
    expect(calls).toContain(`copy:my-library/${ORG}/d/${DEPT}/${FILE}.xlsx->my-library/${ORG}/${ME}/${NEW}.xlsx`);
    expect(calls.some((c) => c.startsWith('remove'))).toBe(false);
  });
  it('남이 담은 부서 파일도 복사는 된다(볼 수 있으니) — 옮기기는 담은 사람·관리자만', async () => {
    expect(await transferLibraryFile(staff, FILE, { space: 'department', to: 'personal', mode: 'copy' }, fakeIo({ owner: OTHER }).io, newId)).toMatchObject({ ok: true });
    expect(await transferLibraryFile(staff, FILE, { space: 'department', to: 'personal', mode: 'move' }, fakeIo({ owner: OTHER }).io, newId))
      .toEqual({ ok: false, status: 403, message: LIBRARY_NOT_YOURS });
    expect(await transferLibraryFile(subAdmin, FILE, { space: 'department', to: 'personal', mode: 'move' }, fakeIo({ owner: OTHER }).io, newId)).toMatchObject({ ok: true, mode: 'move' });
  });
  it('기관 자료함으로는 기관 전체 관리자만 — 파일을 읽기 전에 거절', async () => {
    const { io, calls } = fakeIo({ space: 'personal' });
    expect(await transferLibraryFile(subAdmin, FILE, { space: 'personal', to: 'organization', mode: 'copy' }, io, newId)).toEqual({ ok: false, status: 403, message: LIBRARY_ORG_ONLY });
    expect(calls).toEqual([]);
    const ok = fakeIo({ space: 'personal' });
    expect(await transferLibraryFile(orgAdmin, FILE, { space: 'personal', to: 'organization', mode: 'copy' }, ok.io, newId)).toMatchObject({ ok: true });
    expect(ok.inserted[0]).toMatchObject({ space: 'organization', department_id: null, storage_path: `my-library/${ORG}/o/${NEW}.xlsx` });
  });
  it('내 자료함 → 부서 자료함은 지금 내 부서로', async () => {
    const { io, inserted } = fakeIo({ space: 'personal' });
    expect(await transferLibraryFile(staff, FILE, { space: 'personal', to: 'department', mode: 'copy' }, io, newId)).toMatchObject({ ok: true });
    expect(inserted[0]).toMatchObject({ space: 'department', department_id: DEPT, folder: '', storage_path: `my-library/${ORG}/d/${DEPT}/${NEW}.xlsx` });
  });
  it('기관 자료함 파일은 누구나 내 자료함으로 복사하지만 옮기기는 기관 전체 관리자만', async () => {
    expect(await transferLibraryFile(staff, FILE, { space: 'organization', to: 'personal', mode: 'copy' }, fakeIo({ space: 'organization', owner: OTHER }).io, newId)).toMatchObject({ ok: true });
    expect(await transferLibraryFile(staff, FILE, { space: 'organization', to: 'personal', mode: 'move' }, fakeIo({ space: 'organization', owner: OTHER }).io, newId))
      .toEqual({ ok: false, status: 403, message: LIBRARY_ORG_ONLY });
  });
});

describe('자료함 사이 옮기기', () => {
  it('새 사본 → 새 행 → 원래 행 → 원래 사본 순서', async () => {
    const { io, calls } = fakeIo();
    const r = await transferLibraryFile(staff, FILE, { space: 'department', to: 'personal', mode: 'move', folder: '예산' }, io, newId);
    expect(r).toMatchObject({ ok: true, mode: 'move' });
    expect(r).not.toHaveProperty('warning');
    const order = calls.filter((c) => !c.startsWith('find') && !c.startsWith('folderValues'));
    expect(order).toEqual([
      `copy:my-library/${ORG}/d/${DEPT}/${FILE}.xlsx->my-library/${ORG}/${ME}/${NEW}.xlsx`,
      'insert',
      `remove:department:${FILE}`,
      `removeObject:my-library/${ORG}/d/${DEPT}/${FILE}.xlsx`,
    ]);
  });
  it('원래 행을 못 지우면 두 곳에 남기고 그렇다고 알린다(원래 사본도 지우지 않음)', async () => {
    const { io, calls } = fakeIo({}, { remove: async () => { throw new Error('db'); } });
    const r = await transferLibraryFile(staff, FILE, { space: 'department', to: 'personal', mode: 'move' }, io, newId);
    expect(r).toMatchObject({ ok: true, warning: expect.stringContaining('두 곳에 있습니다') });
    expect(calls.some((c) => c.startsWith('removeObject'))).toBe(false);
  });
  it('원래 행이 그 사이 지워졌으면 원래 사본은 건드리지 않는다', async () => {
    const { io, calls } = fakeIo({}, { remove: async () => 0 });
    expect(await transferLibraryFile(staff, FILE, { space: 'department', to: 'personal', mode: 'move' }, io, newId)).toMatchObject({ ok: true });
    expect(calls.some((c) => c.startsWith('removeObject'))).toBe(false);
  });
  it('원래 사본을 못 지우면 운영 기록에(id·자리만)', async () => {
    logged.length = 0;
    const { io } = fakeIo({}, { removeObject: async () => 'error' as const });
    expect(await transferLibraryFile(staff, FILE, { space: 'department', to: 'personal', mode: 'move' }, io, newId)).toMatchObject({ ok: true });
    expect(logged).toEqual([expect.objectContaining({ level: 'warning', details: { library_file_id: FILE, from: 'department', to: 'personal' }, orgId: ORG })]);
    expect(JSON.stringify(logged)).not.toContain('예산서식');
  });
});

describe('거절', () => {
  it('입력 — 같은 자리·모르는 자리·모르는 방식·폴더 규칙·id 꼴', async () => {
    const { io, calls } = fakeIo();
    expect(await transferLibraryFile(staff, FILE, { space: 'department', to: 'department', mode: 'copy' }, io, newId)).toMatchObject({ ok: false, status: 400 });
    expect(await transferLibraryFile(staff, FILE, { space: 'department', to: 'everyone', mode: 'copy' }, io, newId)).toMatchObject({ ok: false, status: 400 });
    expect(await transferLibraryFile(staff, FILE, { space: 'department', to: 'personal', mode: 'link' }, io, newId)).toMatchObject({ ok: false, status: 400 });
    expect(await transferLibraryFile(staff, FILE, { space: 'department', to: 'personal', mode: 'copy', folder: '가/나/다/라' }, io, newId)).toMatchObject({ ok: false, status: 400 });
    expect(await transferLibraryFile(staff, 'abc', { space: 'department', to: 'personal', mode: 'copy' }, io, newId)).toMatchObject({ ok: false, status: 404 });
    expect(calls).toEqual([]);
  });
  it('볼 수 없는 파일 404, 못 읽음 503', async () => {
    expect(await transferLibraryFile(staff, FILE, { space: 'personal', to: 'department', mode: 'copy' }, fakeIo({ space: 'department' }).io, newId))
      .toEqual({ ok: false, status: 404, message: LIBRARY_NOT_FOUND });
    const broken = fakeIo({}, { folderValues: async () => { throw new Error('db'); } });
    expect(await transferLibraryFile(staff, FILE, { space: 'department', to: 'personal', mode: 'copy' }, broken.io, newId)).toMatchObject({ ok: false, status: 503 });
    expect(broken.calls.some((c) => c.startsWith('copy'))).toBe(false);
  });
  it('받는 자리가 가득 찼거나 폴더가 30개면 409 — 사본을 만들지 않는다', async () => {
    const full = fakeIo({ values: Array.from({ length: 300 }, () => '') });
    expect(await transferLibraryFile(staff, FILE, { space: 'department', to: 'personal', mode: 'copy' }, full.io, newId)).toMatchObject({ ok: false, status: 409, message: expect.stringContaining('300') });
    const many = fakeIo({ values: Array.from({ length: 30 }, (_, i) => `폴더${i}`) });
    expect(await transferLibraryFile(staff, FILE, { space: 'department', to: 'personal', mode: 'copy', folder: '새폴더' }, many.io, newId)).toMatchObject({ ok: false, status: 409 });
    expect(await transferLibraryFile(staff, FILE, { space: 'department', to: 'personal', mode: 'copy', folder: '폴더3' }, many.io, newId)).toMatchObject({ ok: true });
    expect(full.calls.some((c) => c.startsWith('copy'))).toBe(false);
  });
  it('원본 사본이 없으면 404, 복사 실패 503, 새 행을 못 넣으면 새 사본을 지우고 503 — 원래 파일은 그대로', async () => {
    expect(await transferLibraryFile(staff, FILE, { space: 'department', to: 'personal', mode: 'move' }, fakeIo({}, { copyObject: async () => 'missing' as const }).io, newId)).toMatchObject({ ok: false, status: 404 });
    expect(await transferLibraryFile(staff, FILE, { space: 'department', to: 'personal', mode: 'move' }, fakeIo({}, { copyObject: async () => 'error' as const }).io, newId)).toMatchObject({ ok: false, status: 503 });
    const failed = fakeIo({}, { insert: async () => { throw new Error('db'); } });
    expect(await transferLibraryFile(staff, FILE, { space: 'department', to: 'personal', mode: 'move' }, failed.io, newId)).toMatchObject({ ok: false, status: 503 });
    expect(failed.calls.filter((c) => c.startsWith('remove'))).toEqual([`removeObject:my-library/${ORG}/${ME}/${NEW}.xlsx`]);
  });
});

describe('보낼 곳 고르기', () => {
  it('목록 응답의 canAddTo — 기관 자료함은 기관 전체 관리자만', async () => {
    const { io } = fakeIo();
    const page = { ...io, page: async () => [], userNames: async () => new Map() } as unknown as LibraryIo;
    expect(await listLibrary(staff, { space: 'personal' }, page)).toMatchObject({ ok: true, data: { canAddTo: { personal: true, department: true, organization: false, shared: true } } });
    expect(await listLibrary(orgAdmin, { space: 'personal' }, page)).toMatchObject({ ok: true, data: { canAddTo: { personal: true, department: true, organization: true, shared: true } } });
  });
  it('transferTargets — 지금 자리는 빼고, 담을 수 있는 곳만, 못 읽었으면 기관 자료함은 뺀다', () => {
    expect(transferTargets('department', { personal: true, department: true, organization: false, shared: true })).toEqual(['personal']);
    expect(transferTargets('personal', { personal: true, department: true, organization: true, shared: true })).toEqual(['department', 'organization']);
    expect(transferTargets('organization', undefined)).toEqual(['personal', 'department']);
    expect(transferTargets('personal', undefined)).toEqual(['department']);
  });
});

describe('잇기', () => {
  it('라우트 POST가 transferLibraryFile로, 화면이 그 길을 부른다', () => {
    const route = readFileSync('src/app/api/my-library/[id]/route.ts', 'utf8');
    expect(route).toMatch(/export async function POST[\s\S]*transferLibraryFile\(actor, params\.id, \{ space: body\.space, share: body\.share, to: body\.to, toShare: body\.toShare, folder: body\.folder, mode: body\.mode \}\)/);
    const ui = readFileSync('src/components/files/MyLibrarySection.tsx', 'utf8');
    expect(ui).toContain("method: 'POST', json: { ...placeBody, to: to.space, toShare: to.share ?? undefined, mode, folder: target.trim() }");
    expect(ui).toContain('transferPlaces(here, page?.canAddTo, shares)'); // 0299 — 공유 자료함도 보낼 곳
    expect(ui).toContain('disabled={!t.canMove}'); // 0298 — 공용 폼, 한 파일이면 canChange(what.file)
    expect(ui).toContain("what.kind === 'file' ? canChange(what.file)");
  });
});
