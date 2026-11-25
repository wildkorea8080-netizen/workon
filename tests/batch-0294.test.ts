import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-25 — 자료함 폴더째 이름 바꾸기·옮기기(0294, 마이그레이션 없음). 고른 폴더와 그 아래 폴더의 파일을 모두 새 경로 아래로.
 * 내 자료함은 나, 부서 자료함은 관리자, 기관 자료함은 기관 전체 관리자만. 3단계·폴더 30개 규칙은 옮긴 뒤 기준.
 */

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/config', () => ({ SUPABASE_DOCUMENTS_BUCKET: 'documents' }));

import { moveLibraryFolder, planFolderMove, LIBRARY_ORG_ONLY, type LibraryActor, type LibraryIo } from '@/lib/my-library';
import { API_ROUTES } from '@/lib/api-route-ids';

const ORG = '22222222-2222-4222-8222-222222222222';
const ME = '33333333-3333-4333-8333-333333333333';
const DEPT = '77777777-7777-4777-8777-777777777777';
const staff: LibraryActor = { userId: ME, organizationId: ORG, departmentId: DEPT, isAdmin: false, managesWholeOrganization: false };
const subAdmin: LibraryActor = { ...staff, isAdmin: true };
const orgAdmin: LibraryActor = { ...staff, isAdmin: true, managesWholeOrganization: true };

describe('옮길 경로 계획', () => {
  it('그 폴더와 아래 폴더만, 이름이 비슷한 옆 폴더는 빼고 — 얕은 경로부터', () => {
    expect(planFolderMove(['예산/2026', '예산', '예산안', '감사', '예산/2026'], '예산', '재무/예산')).toEqual({
      ok: true, moves: [['예산', '재무/예산'], ['예산/2026', '재무/예산/2026']],
    });
  });
  it('3단계를 넘게 되면 거절, 자기 아래로·같은 곳·미분류는 거절, 담긴 파일이 없으면 거절', () => {
    expect(planFolderMove(['예산', '예산/2026'], '예산', '재무/예산')).toEqual({ ok: true, moves: [['예산', '재무/예산'], ['예산/2026', '재무/예산/2026']] });
    expect(planFolderMove(['예산', '예산/2026/서식'], '예산', '재무/예산')).toMatchObject({ ok: false, message: expect.stringContaining('3단계') });
    expect(planFolderMove(['예산', '예산/2026'], '예산', '예산/2026')).toMatchObject({ ok: false, message: expect.stringContaining('자기 아래') });
    expect(planFolderMove(['예산'], '예산', '예산')).toMatchObject({ ok: false });
    expect(planFolderMove(['예산'], '', '감사')).toMatchObject({ ok: false });
    expect(planFolderMove(['감사'], '예산', '재무')).toMatchObject({ ok: false, message: expect.stringContaining('없습니다') });
  });
  it('윗단계로 올리거나 미분류로 풀면 아래 경로가 함께 올라간다 — 먼저 옮긴 파일이 다시 옮겨지지 않게 얕은 것부터', () => {
    expect(planFolderMove(['가/나/다', '가/나'], '가/나', '가')).toEqual({ ok: true, moves: [['가/나', '가'], ['가/나/다', '가/다']] });
    expect(planFolderMove(['가', '가/나'], '가', '')).toEqual({ ok: true, moves: [['가', ''], ['가/나', '나']] });
  });
});

function fakeIo(values: string[], over: Partial<LibraryIo> = {}) {
  const sets: [string, string][] = [];
  // 실제 DB처럼 차례로 바꾼다 — 같은 행이 두 번 옮겨지는지 본다
  const rows = values.map((folder, i) => ({ id: String(i), folder }));
  const io = {
    folderValues: async () => rows.map((r) => r.folder),
    setFolder: async (_a: LibraryActor, _s: unknown, from: string, to: string) => {
      sets.push([from, to]);
      let n = 0;
      for (const r of rows) if (r.folder === from) { r.folder = to; n += 1; }
      return n;
    },
    ...over,
  } as unknown as LibraryIo;
  return { io, sets, rows };
}

describe('폴더째 옮기기', () => {
  it('내 자료함 — 그 폴더와 아래 파일이 모두 새 경로로, 옆 폴더는 그대로', async () => {
    const { io, rows } = fakeIo(['예산', '예산', '예산/2026', '예산안', '']);
    expect(await moveLibraryFolder(staff, { from: '예산', to: ' 재무 / 예산 ' }, io)).toEqual({ ok: true, moved: 3, folders: 2 });
    expect(rows.map((r) => r.folder)).toEqual(['재무/예산', '재무/예산', '재무/예산/2026', '예산안', '']);
  });
  it('윗단계로 올려도 파일이 두 번 옮겨지지 않는다', async () => {
    const { io, rows } = fakeIo(['가/나/다', '가/나']);
    expect(await moveLibraryFolder(staff, { from: '가/나', to: '가' }, io)).toMatchObject({ ok: true, moved: 2 });
    expect(rows.map((r) => r.folder)).toEqual(['가/다', '가']);
  });
  it('부서 자료함은 관리자만, 기관 자료함은 기관 전체 관리자만 — 거절은 아무것도 읽거나 바꾸기 전에', async () => {
    for (const [who, space] of [[staff, 'department'], [subAdmin, 'organization'], [staff, 'organization']] as const) {
      const { io, sets } = fakeIo(['예산']);
      const r = await moveLibraryFolder(who, { space, from: '예산', to: '재무' }, io);
      expect(r).toMatchObject({ ok: false, status: 403 });
      if (space === 'organization') expect(r).toMatchObject({ message: LIBRARY_ORG_ONLY });
      expect(sets).toHaveLength(0);
    }
    expect(await moveLibraryFolder(subAdmin, { space: 'department', from: '예산', to: '재무' }, fakeIo(['예산']).io)).toMatchObject({ ok: true });
    expect(await moveLibraryFolder(orgAdmin, { space: 'organization', from: '예산', to: '재무' }, fakeIo(['예산']).io)).toMatchObject({ ok: true });
  });
  it('꼴·3단계·폴더 30개 넘김·없는 폴더·잘못된 자리는 거절', async () => {
    expect(await moveLibraryFolder(staff, { from: '예산', to: 'a/b/c/d' }, fakeIo(['예산']).io)).toMatchObject({ ok: false, status: 400 });
    expect(await moveLibraryFolder(staff, { from: '예산', to: '재무/예산' }, fakeIo(['예산/2026/서식']).io)).toMatchObject({ ok: false, status: 400 });
    expect(await moveLibraryFolder(staff, { from: '없음', to: '재무' }, fakeIo(['예산']).io)).toMatchObject({ ok: false, status: 404 });
    expect(await moveLibraryFolder(staff, { space: 'everyone', from: '예산', to: '재무' }, fakeIo(['예산']).io)).toMatchObject({ ok: false, status: 400 });
    // 옮기기는 경로를 하나씩 바꾸거나 합칠 뿐이라 폴더 수가 늘지 않는다 — 30개 꽉 찬 자료함에서도 됨
    const full = Array.from({ length: 30 }, (_, i) => `f${i}`);
    expect(await moveLibraryFolder(staff, { from: 'f0', to: '새' }, fakeIo(full).io)).toMatchObject({ ok: true });
    expect(await moveLibraryFolder(staff, { from: 'f0', to: 'f1' }, fakeIo(full).io)).toMatchObject({ ok: true });
  });
  it('읽기 실패 503, 도중 실패는 옮긴 수와 함께 503', async () => {
    expect(await moveLibraryFolder(staff, { from: '예산', to: '재무' }, fakeIo([], { folderValues: async () => { throw new Error('db'); } }).io)).toMatchObject({ ok: false, status: 503 });
    let n = 0;
    const flaky = fakeIo(['가', '가/나'], { setFolder: async () => { n += 1; if (n === 2) throw new Error('db'); return 1; } });
    expect(await moveLibraryFolder(staff, { from: '가', to: '다' }, flaky.io)).toMatchObject({ ok: false, status: 503, message: expect.stringContaining('1개 옮김') });
  });
});

describe('잇기', () => {
  it('라우트·등록·화면 단추', () => {
    const route = readFileSync('src/app/api/my-library/folders/route.ts', 'utf8');
    expect(route).toContain('export async function PATCH');
    expect(route).toContain('libraryActorOr(await getServerAuthSession())'); // 0299 — 요청자(공유 자료함 포함)는 도우미가
    expect(API_ROUTES.indexOf('my-library/folders')).toBeLessThan(API_ROUTES.indexOf('my-library/[id]'));
    const lib = readFileSync('src/lib/my-library.ts', 'utf8');
    expect(lib).toContain(".update({ folder: to, updated_at: new Date().toISOString() }).eq('folder', from), actor, space)");
    expect(readFileSync('src/components/files/MyLibrarySection.tsx', 'utf8')).toContain("'/api/my-library/folders', { method: 'PATCH'");
  });
});
