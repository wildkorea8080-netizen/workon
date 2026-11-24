// src/lib/my-library.ts
// 내 자료함(2026-11-24, 0103)·부서 자료함(2026-11-24, 0106) — 직원이 대화에 올린 파일·비서가 만들어 준 파일을 **사본**으로 담아
// 폴더로 나눠 두고, 대화·입력형 앱의 '지난 파일'에서 새 첨부로 다시 붙인다. 대화를 지워도 남는다.
//
// 자리(space) 둘:
// - personal(내 자료함) — 담은 사람만 본다. 조회·변경은 `user_id = 요청자`·`organization_id = 요청자 기관`.
// - department(부서 자료함) — **요청자의 지금 부서** 사람이 함께 본다(하위·상위 부서는 따로). 조회는 `department_id = 요청자 부서`·기관,
//   이름·폴더 바꾸기·지우기는 담은 사람이나 관리자만. 부서를 옮기면 옛 부서의 파일은 옛 부서에 남는다. 탈퇴해도 남는다.
// 다시 붙이기·내려받기 때마다 서버가 그 조건으로 행을 다시 찾는다(화면이 고른 id를 믿지 않는다).
// 저장소 경로는 서버가 정하고(my-library/{기관}/{직원}/… · my-library/{기관}/d/{부서}/…) 화면에 내보내지 않는다.
import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { isStorageNotFound } from '@/lib/storage-error';
import { decodeHistoryCursor, encodeHistoryCursor } from '@/lib/apps/history';
import { fileNamePattern, normalizeFileQuery } from '@/lib/file-search';
import { attachmentExtension } from '@/lib/attachments/limits';
import {
  cleanFolderName, cleanLibraryFileName, sortFolders, parseLibrarySpace,
  LIBRARY_MAX_BYTES, LIBRARY_MAX_FOLDERS, LIBRARY_PAGE, libraryMaxFiles,
  type LibraryFile, type LibraryFolder, type LibrarySource, type LibrarySpace,
} from '@/lib/my-library-spec';

export * from '@/lib/my-library-spec';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = 'id, file_name, folder, size_bytes, source, created_at, user_id';

/** 요청자 — 부서 자료함은 이 부서, 관리자면 남이 담은 부서 파일도 고치고 지운다 */
export type LibraryActor = { userId: string; organizationId: string; departmentId: string; isAdmin: boolean };
type Failure = { ok: false; status: number; message: string };
type Row = Record<string, unknown> & { storage_path: string; file_name: string; user_id: string };

export const LIBRARY_NOT_FOUND = '자료함에서 그 파일을 찾을 수 없습니다.';
export const LIBRARY_RETRY = '자료함을 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
export const LIBRARY_NOT_YOURS = '부서 자료함의 파일은 담은 사람이나 관리자만 바꾸거나 지울 수 있습니다.';
const SOURCE_NOT_FOUND = '담을 파일을 찾을 수 없습니다.';
const BAD_SPACE = 'space는 personal(내 자료함) 또는 department(부서 자료함)로 적어 주세요.';

/** 저장소 경로 — 서버가 정한다 */
export function libraryPath(space: LibrarySpace, actor: Pick<LibraryActor, 'organizationId' | 'userId' | 'departmentId'>, id: string, fileName: string): string {
  const ext = attachmentExtension(fileName) ?? 'bin';
  return space === 'department'
    ? `my-library/${actor.organizationId}/d/${actor.departmentId}/${id}.${ext}`
    : `my-library/${actor.organizationId}/${actor.userId}/${id}.${ext}`;
}

/** 행 → 화면 꼴(경로·사람 id 없음 — 내가 담았는지·담은 사람 이름만) */
export function toLibraryFile(r: Record<string, unknown>, me?: string, names?: Map<string, string>): LibraryFile {
  const userId = typeof r.user_id === 'string' ? r.user_id : '';
  return {
    id: String(r.id),
    file_name: String(r.file_name ?? ''),
    folder: typeof r.folder === 'string' ? r.folder : '',
    size_bytes: Number(r.size_bytes ?? 0),
    source: r.source === 'generated' ? 'generated' : 'attachment',
    created_at: String(r.created_at ?? ''),
    mine: me !== undefined ? userId === me : true,
    ...(names ? { added_by: names.get(userId) ?? null } : {}),
  };
}

/** 폴더 목록(순수) — 행들의 폴더 값을 세어 미분류 먼저·이름 순 */
export function folderCounts(values: string[]): LibraryFolder[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return sortFolders(Array.from(counts, ([name, count]) => ({ name, count })));
}

/** 부서 자료함에서 바꾸거나 지울 수 있는가 — 담은 사람이나 관리자 */
export function canChangeLibraryRow(space: LibrarySpace, row: { user_id: string }, actor: LibraryActor): boolean {
  return space === 'personal' || row.user_id === actor.userId || actor.isAdmin;
}

/** 저장소·DB에 닿는 일 — 시험이 바꿔 끼운다 */
export interface LibraryIo {
  /** 담을 원본 — 요청자의 것만(첨부는 읽힌 것만). 없으면 null, DB 오류면 던진다 */
  findSource(userId: string, kind: LibrarySource, id: string): Promise<{ storage_path: string; file_name: string; size_bytes: number } | null>;
  /** 이 자리의 모든 행의 폴더 값 — DB 오류면 던진다 */
  folderValues(actor: LibraryActor, space: LibrarySpace): Promise<string[]>;
  /** 한 쪽 — DB 오류면 던진다 */
  page(actor: LibraryActor, space: LibrarySpace, opts: { folder: string | null; query: string | null; cursor: { at: string; id: string } | null }): Promise<Record<string, unknown>[]>;
  /** 이 자리에서 볼 수 있는 한 행(경로 포함) — 없으면 null, DB 오류면 던진다 */
  findRow(actor: LibraryActor, space: LibrarySpace, id: string): Promise<Row | null>;
  /** 담은 사람 이름(부서 자료함 표시용) — 못 읽으면 빈 표 */
  userNames(ids: string[]): Promise<Map<string, string>>;
  copyObject(from: string, to: string): Promise<'ok' | 'missing' | 'error'>;
  removeObject(path: string): Promise<'ok' | 'missing' | 'error'>;
  /** 넣기 — 넣은 행. 실패면 던진다 */
  insert(row: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** 고치기 — 바뀐 행, 없으면 null. 실패면 던진다 */
  update(actor: LibraryActor, space: LibrarySpace, id: string, patch: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  /** 지우기 — 지운 수. 실패면 던진다 */
  remove(actor: LibraryActor, space: LibrarySpace, id: string): Promise<number>;
}

function spaceOf(raw: unknown): LibrarySpace | null {
  return parseLibrarySpace(raw);
}

/** 자료함 목록 — 고른 자리·폴더(null = 전체)·이름 찾기·쪽 넘기기, 폴더 목록과 전체 수를 함께 */
export async function listLibrary(
  actor: LibraryActor,
  input: { space?: unknown; folder?: unknown; q?: unknown; cursor?: unknown },
  io: LibraryIo = libraryIo(),
): Promise<{ ok: true; data: { space: LibrarySpace; files: LibraryFile[]; next: string | null; folders: LibraryFolder[]; total: number; limit: number; canManage: boolean } } | Failure> {
  const space = spaceOf(input.space);
  if (!space) return { ok: false, status: 400, message: BAD_SPACE };
  let folder: string | null = null;
  if (input.folder !== undefined && input.folder !== null) {
    folder = cleanFolderName(input.folder);
    if (folder === null) return { ok: false, status: 400, message: '폴더 이름이 올바르지 않습니다.' };
  }
  let cursor: { at: string; id: string } | null = null;
  if (typeof input.cursor === 'string' && input.cursor) {
    cursor = decodeHistoryCursor(input.cursor);
    if (!cursor) return { ok: false, status: 400, message: '목록 위치가 올바르지 않습니다.' };
  }
  const query = normalizeFileQuery(typeof input.q === 'string' ? input.q : null);
  try {
    const [values, rows] = await Promise.all([io.folderValues(actor, space), io.page(actor, space, { folder, query, cursor })]);
    const shown = rows.slice(0, LIBRARY_PAGE);
    const names = space === 'department'
      ? await io.userNames([...new Set(shown.map((r) => String(r.user_id ?? '')).filter(Boolean))])
      : undefined;
    const files = shown.map((r) => toLibraryFile(r, actor.userId, names));
    const last = files[files.length - 1];
    return {
      ok: true,
      data: {
        space,
        files,
        next: rows.length > LIBRARY_PAGE && last ? encodeHistoryCursor(last.created_at, last.id) : null,
        folders: folderCounts(values),
        total: values.length,
        limit: libraryMaxFiles(space),
        // 부서 자료함에서 남이 담은 파일도 고치고 지울 수 있는가(관리자)
        canManage: space === 'personal' || actor.isAdmin,
      },
    };
  } catch {
    return { ok: false, status: 503, message: LIBRARY_RETRY };
  }
}

/**
 * 담기 — 내 첨부(읽힌 것)나 비서가 만들어 준 파일을 자료함에 **사본**으로. 원본은 그대로 둔다.
 * 자리마다 개수(내 300·부서 500)·폴더 30개·파일 10MB·첨부할 수 있는 형식만. 사본을 만든 뒤 행을 못 넣으면 사본을 지운다
 */
export async function saveToLibrary(
  actor: LibraryActor,
  input: { kind?: unknown; id?: unknown; folder?: unknown; space?: unknown },
  io: LibraryIo = libraryIo(),
  newId: () => string = randomUUID,
): Promise<{ ok: true; file: LibraryFile } | Failure> {
  if ((input.kind !== 'attachment' && input.kind !== 'generated') || typeof input.id !== 'string' || !UUID.test(input.id)) {
    return { ok: false, status: 404, message: SOURCE_NOT_FOUND };
  }
  const space = spaceOf(input.space);
  if (!space) return { ok: false, status: 400, message: BAD_SPACE };
  const folder = cleanFolderName(input.folder);
  if (folder === null) return { ok: false, status: 400, message: `폴더 이름은 / 없이 30자까지입니다.` };

  let source: Awaited<ReturnType<LibraryIo['findSource']>>;
  let values: string[];
  try {
    [source, values] = await Promise.all([io.findSource(actor.userId, input.kind, input.id.toLowerCase()), io.folderValues(actor, space)]);
  } catch {
    return { ok: false, status: 503, message: LIBRARY_RETRY };
  }
  if (!source) return { ok: false, status: 404, message: SOURCE_NOT_FOUND };
  if (!attachmentExtension(source.file_name)) return { ok: false, status: 400, message: '이 형식의 파일은 자료함에 담을 수 없습니다(대화에 다시 붙일 수 있는 형식만).' };
  if (!(source.size_bytes > 0) || source.size_bytes > LIBRARY_MAX_BYTES) {
    return { ok: false, status: 400, message: `파일이 커서 담을 수 없습니다(${Math.round(LIBRARY_MAX_BYTES / 1024 / 1024)}MB까지).` };
  }
  const max = libraryMaxFiles(space);
  if (values.length >= max) {
    return { ok: false, status: 409, message: `${space === 'department' ? '부서' : '내'} 자료함이 가득 찼습니다(${max}개). 쓰지 않는 파일을 지운 뒤 담아 주세요.` };
  }
  const folders = new Set(values.filter((v) => v !== ''));
  if (folder !== '' && !folders.has(folder) && folders.size >= LIBRARY_MAX_FOLDERS) {
    return { ok: false, status: 409, message: `폴더는 ${LIBRARY_MAX_FOLDERS}개까지입니다. 있는 폴더에 담아 주세요.` };
  }

  const id = newId();
  const path = libraryPath(space, actor, id, source.file_name);
  const copied = await io.copyObject(source.storage_path, path);
  if (copied === 'missing') return { ok: false, status: 404, message: '원본 파일이 더 남아 있지 않습니다.' };
  if (copied === 'error') return { ok: false, status: 503, message: '파일을 지금 담지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  try {
    const row = await io.insert({
      id,
      user_id: actor.userId,
      organization_id: actor.organizationId,
      space,
      department_id: space === 'department' ? actor.departmentId : null,
      folder,
      file_name: source.file_name,
      size_bytes: source.size_bytes,
      storage_path: path,
      source: input.kind,
    });
    return { ok: true, file: toLibraryFile(row, actor.userId) };
  } catch {
    await io.removeObject(path);
    return { ok: false, status: 503, message: '파일을 지금 담지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  }
}

/** 이름 바꾸기·폴더 옮기기 — 확장자는 그대로, 새 폴더는 30개 안에서. 부서 자료함은 담은 사람·관리자만 */
export async function updateLibraryFile(
  actor: LibraryActor,
  id: string,
  input: { file_name?: unknown; folder?: unknown; space?: unknown },
  io: LibraryIo = libraryIo(),
): Promise<{ ok: true; file: LibraryFile } | Failure> {
  const space = spaceOf(input.space);
  if (!space) return { ok: false, status: 400, message: BAD_SPACE };
  if (!UUID.test(id)) return { ok: false, status: 404, message: LIBRARY_NOT_FOUND };
  if (input.file_name === undefined && input.folder === undefined) return { ok: false, status: 400, message: '바꿀 이름이나 폴더를 보내 주세요.' };
  let row: Row | null;
  let values: string[];
  try {
    [row, values] = await Promise.all([io.findRow(actor, space, id.toLowerCase()), io.folderValues(actor, space)]);
  } catch {
    return { ok: false, status: 503, message: LIBRARY_RETRY };
  }
  if (!row) return { ok: false, status: 404, message: LIBRARY_NOT_FOUND };
  if (!canChangeLibraryRow(space, row, actor)) return { ok: false, status: 403, message: LIBRARY_NOT_YOURS };
  const patch: Record<string, unknown> = {};
  if (input.file_name !== undefined) {
    const named = cleanLibraryFileName(input.file_name, row.file_name);
    if (!named.ok) return { ok: false, status: 400, message: named.message };
    patch.file_name = named.name;
  }
  if (input.folder !== undefined) {
    const folder = cleanFolderName(input.folder);
    if (folder === null) return { ok: false, status: 400, message: '폴더 이름은 / 없이 30자까지입니다.' };
    const folders = new Set(values.filter((v) => v !== ''));
    if (folder !== '' && !folders.has(folder) && folders.size >= LIBRARY_MAX_FOLDERS) {
      return { ok: false, status: 409, message: `폴더는 ${LIBRARY_MAX_FOLDERS}개까지입니다. 있는 폴더로 옮겨 주세요.` };
    }
    patch.folder = folder;
  }
  patch.updated_at = new Date().toISOString();
  try {
    const updated = await io.update(actor, space, id.toLowerCase(), patch);
    if (!updated) return { ok: false, status: 404, message: LIBRARY_NOT_FOUND };
    return { ok: true, file: toLibraryFile(updated, actor.userId) };
  } catch {
    return { ok: false, status: 503, message: '바꾸지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  }
}

/** 지우기 — 사본 먼저(없음은 지운 것), 그다음 행. 사본을 못 지우면 행을 남긴다(다시 지울 수 있게). 부서 자료함은 담은 사람·관리자만 */
export async function deleteLibraryFile(actor: LibraryActor, id: string, spaceInput: unknown, io: LibraryIo = libraryIo()): Promise<{ ok: true } | Failure> {
  const space = spaceOf(spaceInput);
  if (!space) return { ok: false, status: 400, message: BAD_SPACE };
  if (!UUID.test(id)) return { ok: false, status: 404, message: LIBRARY_NOT_FOUND };
  let row: Row | null;
  try {
    row = await io.findRow(actor, space, id.toLowerCase());
  } catch {
    return { ok: false, status: 503, message: LIBRARY_RETRY };
  }
  if (!row) return { ok: false, status: 404, message: LIBRARY_NOT_FOUND };
  if (!canChangeLibraryRow(space, row, actor)) return { ok: false, status: 403, message: LIBRARY_NOT_YOURS };
  if ((await io.removeObject(row.storage_path)) === 'error') return { ok: false, status: 503, message: '파일을 지금 지우지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  try {
    if ((await io.remove(actor, space, id.toLowerCase())) === 0) return { ok: false, status: 404, message: LIBRARY_NOT_FOUND };
    return { ok: true };
  } catch {
    return { ok: false, status: 503, message: '파일을 지금 지우지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  }
}

/**
 * 다시 붙이기·내려받기용 원본 — 내 자료함의 내 행, 아니면 지금 내 부서의 부서 자료함 행. 없으면 null, DB 오류면 던진다
 */
export async function findLibraryOriginal(actor: LibraryActor, id: string, io: LibraryIo = libraryIo()): Promise<{ storage_path: string; file_name: string } | null> {
  if (!UUID.test(id)) return null;
  const key = id.toLowerCase();
  const row = (await io.findRow(actor, 'personal', key)) ?? (await io.findRow(actor, 'department', key));
  return row ? { storage_path: row.storage_path, file_name: row.file_name } : null;
}

// ── 탈퇴 처리 ────────────────────────────────────────────────────────────

/** 이 사람의 **내 자료함** 사본 경로 전부(부서 자료함에 담은 것은 부서에 남는다) — 못 읽으면 던진다 */
export async function listUserLibraryPaths(userId: string): Promise<string[]> {
  const paths: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin.from('my_library_files').select('storage_path').eq('user_id', userId).eq('space', 'personal').order('id').range(from, from + 999);
    if (error) throw new Error(`my_library_files: ${error.message}`);
    const rows = (data ?? []) as { storage_path: string }[];
    paths.push(...rows.map((r) => r.storage_path));
    if (rows.length < 1000) return paths;
  }
}

// ── 실제 저장소·DB ───────────────────────────────────────────────────────

function bucket() {
  return supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET);
}

export function libraryIo(): LibraryIo {
  /** 자리 조건 — 내 자료함은 담은 사람, 부서 자료함은 요청자의 지금 부서. 둘 다 기관을 함께 건다 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scoped = (q: any, actor: LibraryActor, space: LibrarySpace) => (space === 'department'
    ? q.eq('space', 'department').eq('department_id', actor.departmentId).eq('organization_id', actor.organizationId)
    : q.eq('space', 'personal').eq('user_id', actor.userId).eq('organization_id', actor.organizationId));
  const table = () => supabaseAdmin.from('my_library_files');
  return {
    async findSource(userId, kind, id) {
      const query = kind === 'attachment'
        ? supabaseAdmin.from('chat_attachments').select('storage_path, file_name, size_bytes').eq('id', id).eq('user_id', userId).eq('status', 'ready')
        : supabaseAdmin.from('generated_files').select('storage_path, file_name, size_bytes').eq('id', id).eq('user_id', userId);
      const { data, error } = await query.maybeSingle();
      if (error) throw new Error(`library source: ${error.message}`);
      const row = data as { storage_path?: unknown; file_name?: unknown; size_bytes?: unknown } | null;
      return row && typeof row.storage_path === 'string' && typeof row.file_name === 'string'
        ? { storage_path: row.storage_path, file_name: row.file_name, size_bytes: Number(row.size_bytes ?? 0) }
        : null;
    },
    async folderValues(actor, space) {
      const { data, error } = await scoped(table().select('folder'), actor, space).limit(libraryMaxFiles(space) + 50);
      if (error) throw new Error(`my_library_files: ${error.message}`);
      return ((data ?? []) as { folder: string | null }[]).map((r) => r.folder ?? '');
    },
    async page(actor, space, { folder, query, cursor }) {
      let q = scoped(table().select(COLUMNS), actor, space).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(LIBRARY_PAGE + 1);
      if (folder !== null) q = q.eq('folder', folder);
      if (query) q = q.ilike('file_name', fileNamePattern(query));
      if (cursor) q = q.or(`created_at.lt.${cursor.at},and(created_at.eq.${cursor.at},id.lt.${cursor.id})`);
      const { data, error } = await q;
      if (error) throw new Error(`my_library_files: ${error.message}`);
      return (data ?? []) as unknown as Record<string, unknown>[];
    },
    async findRow(actor, space, id) {
      const { data, error } = await scoped(table().select(`${COLUMNS}, storage_path`).eq('id', id), actor, space).maybeSingle();
      if (error) throw new Error(`my_library_files: ${error.message}`);
      const row = data as (Record<string, unknown> & { storage_path?: unknown; file_name?: unknown; user_id?: unknown }) | null;
      return row && typeof row.storage_path === 'string' && typeof row.file_name === 'string' && typeof row.user_id === 'string' ? (row as Row) : null;
    },
    async userNames(ids) {
      const names = new Map<string, string>();
      if (!ids.length) return names;
      const { data, error } = await supabaseAdmin.from('users').select('id, full_name').in('id', ids);
      if (error) return names;
      for (const u of (data ?? []) as { id: string; full_name: string | null }[]) if (u.full_name) names.set(u.id, u.full_name);
      return names;
    },
    async copyObject(from, to) {
      const { error } = await bucket().copy(from, to);
      if (!error) return 'ok';
      return isStorageNotFound(error) ? 'missing' : 'error';
    },
    async removeObject(path) {
      const { data, error } = await bucket().remove([path]);
      if (error) return isStorageNotFound(error) ? 'missing' : 'error';
      return Array.isArray(data) && data.length ? 'ok' : 'missing';
    },
    async insert(row) {
      const { data, error } = await table().insert(row).select(COLUMNS).single();
      if (error) throw new Error(`my_library_files: ${error.message}`);
      return data as unknown as Record<string, unknown>;
    },
    async update(actor, space, id, patch) {
      const { data, error } = await scoped(table().update(patch).eq('id', id), actor, space).select(COLUMNS).maybeSingle();
      if (error) throw new Error(`my_library_files: ${error.message}`);
      return (data as Record<string, unknown> | null) ?? null;
    },
    async remove(actor, space, id) {
      const { data, error } = await scoped(table().delete().eq('id', id), actor, space).select('id');
      if (error) throw new Error(`my_library_files: ${error.message}`);
      return ((data ?? []) as unknown[]).length;
    },
  };
}
