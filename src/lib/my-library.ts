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
import { logSystem } from '@/lib/logger';
import {
  cleanFolderName, cleanLibraryFileName, sortFolders, parseLibrarySpace, isSharedLibrarySpace, subtreeFolders, planFolderMove, transferFolderPath, LIBRARY_SPACE_LABEL,
  LIBRARY_MAX_BYTES, LIBRARY_MAX_FOLDERS, LIBRARY_PAGE, libraryMaxFiles,
  samePlace, libraryPlaceLabel, libraryContentText, librarySnippet,
  type LibraryFile, type LibraryFolder, type LibrarySource, type LibrarySpace, type LibraryShare,
} from '@/lib/my-library-spec';

export * from '@/lib/my-library-spec';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = 'id, file_name, folder, size_bytes, source, created_at, user_id';
/** 한 행을 다룰 때(보내기·원본) — 경로와 내용 글(0117, 보낼 때 함께 간다) */
const ROW_COLUMNS = `${COLUMNS}, storage_path, content_text, content_checked_at`;

/**
 * 요청자 — 부서 자료함은 이 부서, 관리자면 남이 담은 부서 파일도 고치고 지운다.
 * 기관 자료함(0112)은 기관 전체 관리자(`managesWholeOrganization`)만 담고 고친다 — 없으면 아닌 것으로
 */
export type LibraryActor = {
  userId: string; organizationId: string; departmentId: string; isAdmin: boolean; managesWholeOrganization?: boolean;
  /** (0116) 내가 든 공유 자료함 — 라우트가 `loadLibraryShares`로 채운다. 없으면 공유 자료함은 하나도 못 연다 */
  shares?: LibraryShare[];
  /** (0116) 이번 요청이 다루는 공유 자료함 — `placeActor`만 정한다(내가 든 것인지 본 뒤) */
  shareId?: string | null;
};
type Failure = { ok: false; status: number; message: string };
type Row = Record<string, unknown> & { storage_path: string; file_name: string; user_id: string };

export const LIBRARY_NOT_FOUND = '자료함에서 그 파일을 찾을 수 없습니다.';
export const LIBRARY_RETRY = '자료함을 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
export const LIBRARY_NOT_YOURS = '부서 자료함의 파일은 담은 사람이나 관리자만 바꾸거나 지울 수 있습니다.';
export const LIBRARY_FOLDER_RULE = '폴더는 / 로 나눠 3단계까지, 한 단계 30자까지입니다(\\ 와 " 는 쓸 수 없습니다).';
export const LIBRARY_ORG_ONLY = '기관 자료함은 기관 전체 관리자(최상위 부서 소속)만 담고 바꾸고 지웁니다.';
export const LIBRARY_SHARE_NOT_FOUND = '그 공유 자료함을 찾을 수 없습니다(지금 소속 부서가 든 공유 자료함만 열 수 있습니다).';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * (0116) 이 요청이 다룰 자료함의 요청자 — 공유 자료함이면 `share`가 내가 든 것일 때만(아니면 404), 그 밖의 자리는 공유 자료함 없음
 */
export function placeActor(actor: LibraryActor, space: LibrarySpace, share: unknown): { ok: true; actor: LibraryActor } | Failure {
  if (space !== 'shared') return { ok: true, actor: { ...actor, shareId: null } };
  const id = typeof share === 'string' && UUID.test(share) ? share.toLowerCase() : null;
  if (!id || !(actor.shares ?? []).some((s) => s.id.toLowerCase() === id)) return { ok: false, status: 404, message: LIBRARY_SHARE_NOT_FOUND };
  return { ok: true, actor: { ...actor, shareId: id } };
}
const SOURCE_NOT_FOUND = '담을 파일을 찾을 수 없습니다.';
const BAD_SPACE = 'space는 personal(내 자료함)·department(부서 자료함)·organization(기관 자료함)·shared(공유 자료함 — share와 함께) 중 하나로 적어 주세요.';
const BAD_TO = '보낼 자료함(to)은 personal·department·organization·shared(toShare와 함께) 중 하나로 적어 주세요.';

/** 저장소 경로 — 서버가 정한다 */
export function libraryPath(space: LibrarySpace, actor: Pick<LibraryActor, 'organizationId' | 'userId' | 'departmentId' | 'shareId'>, id: string, fileName: string): string {
  const ext = attachmentExtension(fileName) ?? 'bin';
  if (space === 'organization') return `my-library/${actor.organizationId}/o/${id}.${ext}`;
  if (space === 'shared') return `my-library/${actor.organizationId}/s/${actor.shareId ?? NIL_UUID}/${id}.${ext}`;
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

/** 바꾸거나 지울 수 있는가 — 내 자료함은 나, 부서 자료함은 담은 사람이나 관리자, 기관 자료함은 기관 전체 관리자 */
export function canChangeLibraryRow(space: LibrarySpace, row: { user_id: string }, actor: LibraryActor): boolean {
  if (space === 'organization') return actor.managesWholeOrganization === true;
  return space === 'personal' || row.user_id === actor.userId || actor.isAdmin;
}

/** 이 자리에 담을 수 있는가 — 기관 자료함만 기관 전체 관리자로 좁힌다 */
export function canAddToLibrary(space: LibrarySpace, actor: LibraryActor): boolean {
  return space !== 'organization' || actor.managesWholeOrganization === true;
}

function noChange(space: LibrarySpace): Failure {
  return {
    ok: false, status: 403,
    message: space === 'organization' ? LIBRARY_ORG_ONLY : space === 'shared' ? '공유 자료함의 파일은 담은 사람이나 관리자만 바꾸거나 지울 수 있습니다.' : LIBRARY_NOT_YOURS,
  };
}

/** 저장소·DB에 닿는 일 — 시험이 바꿔 끼운다 */
export interface LibraryIo {
  /** 담을 원본 — 요청자의 것만(첨부는 읽힌 것만). 없으면 null, DB 오류면 던진다 */
  findSource(userId: string, kind: LibrarySource, id: string): Promise<{ storage_path: string; file_name: string; size_bytes: number; extract_path?: string | null } | null>;
  /**
   * (0117) 담을 파일의 글 — 첨부는 읽어 둔 내용, 만든 파일은 원본을 다시 읽음(스캔 PDF는 NODA로 보내지 않음). 못 읽으면 null(던지지 않음 —
   * 내용 찾기만 빠지고 담기는 그대로)
   */
  readContent?(userId: string, kind: LibrarySource, id: string, source: { storage_path: string; file_name: string; extract_path?: string | null }): Promise<string | null>;
  /** 이 자리의 모든 행의 폴더 값 — DB 오류면 던진다 */
  folderValues(actor: LibraryActor, space: LibrarySpace): Promise<string[]>;
  /** 한 쪽 — DB 오류면 던진다. `folders`가 있으면 그 폴더들(고른 폴더와 그 아래 — 0113), 없으면 `folder` 하나(null = 전체) */
  page(actor: LibraryActor, space: LibrarySpace, opts: { folder: string | null; folders?: string[] | null; query: string | null; cursor: { at: string; id: string } | null }): Promise<Record<string, unknown>[]>;
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
  /** (0298) 이 자리에서 볼 수 있는 여러 행(경로 포함) — `ids` 또는 `folders`, `limit`개까지. DB 오류면 던진다 */
  findRows?(actor: LibraryActor, space: LibrarySpace, opts: { ids?: string[]; folders?: string[]; limit: number }): Promise<Row[]>;
  /** (0116) 지금 내 부서가 든 공유 자료함의 한 행(경로 포함) — 다시 붙이기·내려받기용. 없으면 null, DB 오류면 던진다 */
  findSharedRow?(actor: LibraryActor, id: string): Promise<Row | null>;
  /** 폴더 값이 `from`인 이 자리의 행을 모두 `to`로(0294) — 바꾼 수. 실패면 던진다 */
  setFolder?(actor: LibraryActor, space: LibrarySpace, from: string, to: string): Promise<number>;
}

function spaceOf(raw: unknown): LibrarySpace | null {
  return parseLibrarySpace(raw);
}

/** 자료함 목록 — 고른 자리·폴더(null = 전체)·이름 찾기·쪽 넘기기, 폴더 목록과 전체 수를 함께 */
export async function listLibrary(
  actor: LibraryActor,
  input: { space?: unknown; share?: unknown; folder?: unknown; q?: unknown; cursor?: unknown },
  io: LibraryIo = libraryIo(),
): Promise<{ ok: true; data: { space: LibrarySpace; share: string | null; shares: LibraryShare[]; files: LibraryFile[]; next: string | null; folders: LibraryFolder[]; total: number; limit: number; canManage: boolean; canAdd: boolean; canAddTo: Record<LibrarySpace, boolean> } } | Failure> {
  const space = spaceOf(input.space);
  if (!space) return { ok: false, status: 400, message: BAD_SPACE };
  const placed = placeActor(actor, space, input.share);
  if (!placed.ok) return placed;
  actor = placed.actor;
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
    // 고른 폴더와 그 아래 폴더의 파일을 함께(0113) — 아래 폴더 경로는 이 자리의 폴더 값에서 고른다
    const values = await io.folderValues(actor, space);
    const rows = await io.page(actor, space, { folder, folders: folder === null ? null : subtreeFolders(values, folder), query, cursor });
    const shown = rows.slice(0, LIBRARY_PAGE);
    const names = isSharedLibrarySpace(space)
      ? await io.userNames([...new Set(shown.map((r) => String(r.user_id ?? '')).filter(Boolean))])
      : undefined;
    const files = shown.map((r) => {
      const file = toLibraryFile(r, actor.userId, names);
      // 내용에서 맞았으면 그 자리 앞뒤(0117) — 내용 글 자체는 내보내지 않는다
      const snippet = query ? librarySnippet(r.content_text, file.file_name, query) : null;
      return snippet ? { ...file, snippet } : file;
    });
    const last = files[files.length - 1];
    return {
      ok: true,
      data: {
        space,
        share: actor.shareId ?? null,
        // 내가 든 공유 자료함(0116) — 화면이 탭과 보낼 곳을 만든다
        shares: actor.shares ?? [],
        files,
        next: rows.length > LIBRARY_PAGE && last ? encodeHistoryCursor(last.created_at, last.id) : null,
        folders: folderCounts(values),
        total: values.length,
        limit: libraryMaxFiles(space),
        // 남이 담은 파일도 고치고 지울 수 있는가 — 부서 자료함은 관리자, 기관 자료함은 기관 전체 관리자
        canManage: space === 'organization' ? actor.managesWholeOrganization === true : space === 'personal' || actor.isAdmin,
        // 이 자리에 담을 수 있는가(기관 자료함은 기관 전체 관리자만)
        canAdd: canAddToLibrary(space, actor),
        // 자리마다 담을 수 있는가 — 다른 자료함으로 복사·옮기기(0296)가 고를 곳을 보인다
        canAddTo: { personal: canAddToLibrary('personal', actor), department: canAddToLibrary('department', actor), organization: canAddToLibrary('organization', actor), shared: true },
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
  input: { kind?: unknown; id?: unknown; folder?: unknown; space?: unknown; share?: unknown },
  io: LibraryIo = libraryIo(),
  newId: () => string = randomUUID,
): Promise<{ ok: true; file: LibraryFile } | Failure> {
  if ((input.kind !== 'attachment' && input.kind !== 'generated') || typeof input.id !== 'string' || !UUID.test(input.id)) {
    return { ok: false, status: 404, message: SOURCE_NOT_FOUND };
  }
  const space = spaceOf(input.space);
  if (!space) return { ok: false, status: 400, message: BAD_SPACE };
  const placed = placeActor(actor, space, input.share);
  if (!placed.ok) return placed;
  actor = placed.actor;
  if (!canAddToLibrary(space, actor)) return { ok: false, status: 403, message: LIBRARY_ORG_ONLY };
  const folder = cleanFolderName(input.folder);
  if (folder === null) return { ok: false, status: 400, message: LIBRARY_FOLDER_RULE };

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
    return { ok: false, status: 409, message: `${libraryPlaceLabel({ space, share: actor.shareId }, actor.shares)}이 가득 찼습니다(${max}개). 쓰지 않는 파일을 지운 뒤 담아 주세요.` };
  }
  const folders = new Set(values.filter((v) => v !== ''));
  if (folder !== '' && !folders.has(folder) && folders.size >= LIBRARY_MAX_FOLDERS) {
    return { ok: false, status: 409, message: `폴더는 ${LIBRARY_MAX_FOLDERS}개까지입니다. 있는 폴더에 담아 주세요.` };
  }

  const id = newId();
  const path = libraryPath(space, actor, id, source.file_name);
  const kind: LibrarySource = input.kind;
  // 사본 만들기와 함께 글로 읽어 둔다(0117) — 못 읽으면 내용 찾기만 빠진다
  const [copied, content] = await Promise.all([
    io.copyObject(source.storage_path, path),
    io.readContent ? io.readContent(actor.userId, kind, (input.id as string).toLowerCase(), source).catch(() => null) : Promise.resolve(null),
  ]);
  if (copied === 'missing') return { ok: false, status: 404, message: '원본 파일이 더 남아 있지 않습니다.' };
  if (copied === 'error') return { ok: false, status: 503, message: '파일을 지금 담지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  try {
    const row = await io.insert({
      id,
      user_id: actor.userId,
      organization_id: actor.organizationId,
      space,
      department_id: space === 'department' ? actor.departmentId : null,
      share_id: space === 'shared' ? actor.shareId : null,
      folder,
      file_name: source.file_name,
      size_bytes: source.size_bytes,
      storage_path: path,
      source: input.kind,
      content_text: libraryContentText(content),
      // 읽었으면 확인한 때(0120) — 못 읽었으면 비워 두어 5분 실행기가 사본에서 다시 읽는다
      content_checked_at: libraryContentText(content) ? new Date().toISOString() : null,
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
  input: { file_name?: unknown; folder?: unknown; space?: unknown; share?: unknown },
  io: LibraryIo = libraryIo(),
): Promise<{ ok: true; file: LibraryFile } | Failure> {
  const space = spaceOf(input.space);
  if (!space) return { ok: false, status: 400, message: BAD_SPACE };
  const placed = placeActor(actor, space, input.share);
  if (!placed.ok) return placed;
  actor = placed.actor;
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
  if (!canChangeLibraryRow(space, row, actor)) return noChange(space);
  const patch: Record<string, unknown> = {};
  if (input.file_name !== undefined) {
    const named = cleanLibraryFileName(input.file_name, row.file_name);
    if (!named.ok) return { ok: false, status: 400, message: named.message };
    patch.file_name = named.name;
  }
  if (input.folder !== undefined) {
    const folder = cleanFolderName(input.folder);
    if (folder === null) return { ok: false, status: 400, message: LIBRARY_FOLDER_RULE };
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
export async function deleteLibraryFile(actor: LibraryActor, id: string, spaceInput: unknown, io: LibraryIo = libraryIo(), shareInput?: unknown): Promise<{ ok: true } | Failure> {
  const space = spaceOf(spaceInput);
  if (!space) return { ok: false, status: 400, message: BAD_SPACE };
  const placed = placeActor(actor, space, shareInput);
  if (!placed.ok) return placed;
  actor = placed.actor;
  if (!UUID.test(id)) return { ok: false, status: 404, message: LIBRARY_NOT_FOUND };
  let row: Row | null;
  try {
    row = await io.findRow(actor, space, id.toLowerCase());
  } catch {
    return { ok: false, status: 503, message: LIBRARY_RETRY };
  }
  if (!row) return { ok: false, status: 404, message: LIBRARY_NOT_FOUND };
  if (!canChangeLibraryRow(space, row, actor)) return noChange(space);
  if ((await io.removeObject(row.storage_path)) === 'error') return { ok: false, status: 503, message: '파일을 지금 지우지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  try {
    if ((await io.remove(actor, space, id.toLowerCase())) === 0) return { ok: false, status: 404, message: LIBRARY_NOT_FOUND };
    return { ok: true };
  } catch {
    return { ok: false, status: 503, message: '파일을 지금 지우지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  }
}

/**
 * 폴더째 이름 바꾸기·옮기기(0294) — `from` 폴더와 그 아래 폴더의 파일을 모두 `to` 아래로(`to`가 비면 미분류로 풀어 놓음).
 * 내 자료함은 나, 부서 자료함은 관리자(남이 담은 파일도 옮겨지므로), 기관 자료함은 기관 전체 관리자만. 3단계·30자·폴더 30개 규칙은 옮긴 뒤 기준.
 * 경로마다 조건부로 바꾼다 — 도중에 실패하면 바꾼 경로까지만 남고 503(다시 하면 남은 것만 옮겨진다)
 */
export async function moveLibraryFolder(
  actor: LibraryActor,
  input: { space?: unknown; share?: unknown; from?: unknown; to?: unknown },
  io: LibraryIo = libraryIo(),
): Promise<{ ok: true; moved: number; folders: number } | Failure> {
  const space = spaceOf(input.space);
  if (!space) return { ok: false, status: 400, message: BAD_SPACE };
  const placed = placeActor(actor, space, input.share);
  if (!placed.ok) return placed;
  actor = placed.actor;
  const allowed = space === 'personal' || (space === 'organization' ? actor.managesWholeOrganization === true : actor.isAdmin);
  if (!allowed) return { ok: false, status: 403, message: space === 'organization' ? LIBRARY_ORG_ONLY : `${LIBRARY_SPACE_LABEL[space]}의 폴더는 관리자만 폴더째 옮깁니다(남이 담은 파일도 함께 옮겨지므로).` };
  const from = cleanFolderName(input.from);
  const to = cleanFolderName(input.to);
  if (from === null || to === null) return { ok: false, status: 400, message: LIBRARY_FOLDER_RULE };
  if (!io.setFolder) return { ok: false, status: 503, message: LIBRARY_RETRY };
  let values: string[];
  try {
    values = await io.folderValues(actor, space);
  } catch {
    return { ok: false, status: 503, message: LIBRARY_RETRY };
  }
  const plan = planFolderMove(values, from, to);
  if (!plan.ok) return { ok: false, status: plan.message.startsWith('그 폴더에') ? 404 : 400, message: plan.message };
  // 옮긴 뒤의 폴더 수 — 서로 다른 경로 30개까지
  const moved = new Map(plan.moves);
  const after = new Set(values.map((v) => moved.get(v) ?? v).filter((v) => v !== ''));
  if (after.size > LIBRARY_MAX_FOLDERS) return { ok: false, status: 409, message: `옮기면 폴더가 ${LIBRARY_MAX_FOLDERS}개를 넘습니다.` };
  let count = 0;
  try {
    for (const [oldPath, newPath] of plan.moves) count += await io.setFolder(actor, space, oldPath, newPath);
  } catch {
    return { ok: false, status: 503, message: `폴더를 다 옮기지 못했습니다(${count}개 옮김). 잠시 뒤 다시 시도해 주세요.` };
  }
  return { ok: true, moved: count, folders: plan.moves.length };
}

export type LibraryTransferMode = 'copy' | 'move';

/**
 * 자료함 사이 복사·옮기기(0296, 마이그레이션 없음) — 내 자료함·부서 자료함·기관 자료함 사이에서 파일 하나를.
 * - 복사(`copy`): 볼 수 있는 파일이면 누구나(내려받아 다시 올리는 것과 같다). 원래 파일은 그대로.
 * - 옮기기(`move`): 원래 자리에서 바꾸거나 지울 수 있는 사람만(`canChangeLibraryRow` — 부서 자료함에서 남이 담은 파일은 관리자, 기관 자료함은 기관 전체 관리자).
 * 받는 자리는 담을 수 있어야 하고(기관 자료함은 기관 전체 관리자만) 개수·폴더 30개 규칙을 본다. 새 자리의 '담은 사람'은 요청자다.
 * 순서: 새 사본 → 새 행(못 넣으면 새 사본을 지움) → (옮기기면) 원래 행 → 원래 사본. 원래 행을 못 지우면 두 곳에 남기고 그렇다고 알린다,
 * 원래 사본을 못 지우면 운영 기록에만 남긴다(행이 없어 아무도 못 보는 사본)
 */
export async function transferLibraryFile(
  actor: LibraryActor,
  id: string,
  input: { space?: unknown; share?: unknown; to?: unknown; toShare?: unknown; folder?: unknown; mode?: unknown },
  io: LibraryIo = libraryIo(),
  newId: () => string = randomUUID,
): Promise<{ ok: true; file: LibraryFile; mode: LibraryTransferMode; to: LibrarySpace; warning?: string } | Failure> {
  const from = spaceOf(input.space);
  if (!from) return { ok: false, status: 400, message: BAD_SPACE };
  const to = spaceOf(input.to);
  if (!to) return { ok: false, status: 400, message: BAD_TO };
  if (samePlace({ space: from, share: typeof input.share === 'string' ? input.share : null }, { space: to, share: typeof input.toShare === 'string' ? input.toShare : null })) {
    return { ok: false, status: 400, message: '같은 자료함 안에서는 폴더 옮기기를 쓰세요.' };
  }
  const fromPlaced = placeActor(actor, from, input.share);
  if (!fromPlaced.ok) return fromPlaced;
  const toPlaced = placeActor(actor, to, input.toShare);
  if (!toPlaced.ok) return toPlaced;
  const fromActor = fromPlaced.actor;
  const toActor = toPlaced.actor;
  const mode = input.mode === 'copy' || input.mode === 'move' ? input.mode : null;
  if (!mode) return { ok: false, status: 400, message: 'mode는 copy(복사)나 move(옮기기)로 적어 주세요.' };
  if (!UUID.test(id)) return { ok: false, status: 404, message: LIBRARY_NOT_FOUND };
  if (!canAddToLibrary(to, actor)) return { ok: false, status: 403, message: LIBRARY_ORG_ONLY };
  const folder = cleanFolderName(input.folder);
  if (folder === null) return { ok: false, status: 400, message: LIBRARY_FOLDER_RULE };
  const key = id.toLowerCase();

  let row: Row | null;
  let values: string[];
  try {
    [row, values] = await Promise.all([io.findRow(fromActor, from, key), io.folderValues(toActor, to)]);
  } catch {
    return { ok: false, status: 503, message: LIBRARY_RETRY };
  }
  if (!row) return { ok: false, status: 404, message: LIBRARY_NOT_FOUND };
  if (mode === 'move' && !canChangeLibraryRow(from, row, fromActor)) return noChange(from);
  const max = libraryMaxFiles(to);
  const toLabel = libraryPlaceLabel({ space: to, share: toActor.shareId }, actor.shares);
  if (values.length >= max) {
    return { ok: false, status: 409, message: `${toLabel}이 가득 찼습니다(${max}개). 쓰지 않는 파일을 지운 뒤 다시 해 주세요.` };
  }
  const folders = new Set(values.filter((v) => v !== ''));
  if (folder !== '' && !folders.has(folder) && folders.size >= LIBRARY_MAX_FOLDERS) {
    return { ok: false, status: 409, message: `${toLabel}의 폴더는 ${LIBRARY_MAX_FOLDERS}개까지입니다. 있는 폴더를 고르세요.` };
  }

  const sent = await sendRow({ fromActor, toActor }, row, key, { from, to, mode, folder }, io, newId);
  return sent.ok ? { ok: true, file: sent.file, mode, to, ...(sent.warning ? { warning: sent.warning } : {}) } : sent;
}

/**
 * 한 행 보내기(0296·0298 공용) — 권한·자리 상한은 부른 쪽이 이미 봤다. 새 사본 → 새 행 → (옮기기면) 원래 행 → 원래 사본
 */
async function sendRow(
  { fromActor, toActor }: { fromActor: LibraryActor; toActor: LibraryActor },
  row: Row,
  key: string,
  { from, to, mode, folder }: { from: LibrarySpace; to: LibrarySpace; mode: LibraryTransferMode; folder: string },
  io: LibraryIo,
  newId: () => string,
): Promise<{ ok: true; file: LibraryFile; warning?: string } | Failure> {
  const actor = toActor;
  const newKey = newId();
  const path = libraryPath(to, actor, newKey, row.file_name);
  const copied = await io.copyObject(row.storage_path, path);
  if (copied === 'missing') return { ok: false, status: 404, message: '원본 파일이 더 남아 있지 않습니다.' };
  if (copied === 'error') return { ok: false, status: 503, message: '파일을 지금 보내지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  let inserted: Record<string, unknown>;
  try {
    inserted = await io.insert({
      id: newKey,
      user_id: actor.userId,
      organization_id: actor.organizationId,
      space: to,
      department_id: to === 'department' ? actor.departmentId : null,
      share_id: to === 'shared' ? actor.shareId : null,
      folder,
      file_name: row.file_name,
      size_bytes: Number(row.size_bytes ?? 0),
      storage_path: path,
      source: row.source === 'generated' ? 'generated' : 'attachment',
      // 내용 글도 함께 간다(0117) — 다시 읽지 않는다. 확인한 때(0120)도 그대로(원래 아직이면 새 사본도 실행기가 채운다)
      content_text: libraryContentText(row.content_text),
      content_checked_at: typeof row.content_checked_at === 'string' ? row.content_checked_at : null,
    });
  } catch {
    await io.removeObject(path);
    return { ok: false, status: 503, message: '파일을 지금 보내지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  }
  const file = toLibraryFile(inserted, actor.userId);
  if (mode === 'copy') return { ok: true, file };

  // 옮기기 — 원래 행을 지운 뒤 원래 사본
  let removed: number;
  try {
    removed = await io.remove(fromActor, from, key);
  } catch {
    return {
      ok: true, file,
      warning: `${libraryPlaceLabel({ space: to, share: toActor.shareId }, actor.shares)}에 담았지만 ${libraryPlaceLabel({ space: from, share: fromActor.shareId }, actor.shares)}에서는 지우지 못했습니다 — 두 곳에 있습니다. 원래 자리에서 지워 주세요.`,
    };
  }
  if (removed > 0 && (await io.removeObject(row.storage_path)) === 'error') {
    await logSystem({
      level: 'warning', category: 'database', message: '자료함에서 옮긴 파일의 원래 사본을 지우지 못했습니다',
      details: { library_file_id: key, from, to },
      orgId: actor.organizationId,
    });
  }
  return { ok: true, file };
}

/** 한 번에 보내는 파일 수(0298) */
export const LIBRARY_TRANSFER_MAX = 50;

export type LibraryBatchResult = {
  ok: true; mode: LibraryTransferMode; to: LibrarySpace; sent: number;
  /** 보내지 못한 파일(이름·까닭) — 앞의 것은 보냈다 */
  failed: { id: string; file_name: string; message: string }[];
  /** 두 곳에 남은 파일 등 */
  warnings: string[];
};

/**
 * 여러 파일·폴더째 다른 자료함으로 복사·옮기기(0298, 마이그레이션 없음) — `ids`(50개까지) 또는 `fromFolder`(그 폴더와 그 아래, 50개까지).
 * 모든 파일을 먼저 읽고 **보내기 전에** 권한(옮기기면 모두 바꿀 수 있어야)·받는 자리 개수·폴더 수를 한꺼번에 본다 — 하나라도 안 되면 아무것도 보내지 않는다.
 * 폴더째면 폴더 이름과 그 아래 구조를 받는 폴더 아래에 그대로 둔다(`예산/2026` → 받는 폴더 `공유` 아래 `공유/예산/2026`, 3단계 안에서).
 * 보내는 도중 실패한 파일은 건너뛰고 이어 간다(실패 목록으로 알림 — 보낸 것은 되돌리지 않는다)
 */
export async function transferLibraryFiles(
  actor: LibraryActor,
  input: { space?: unknown; share?: unknown; to?: unknown; toShare?: unknown; folder?: unknown; mode?: unknown; ids?: unknown; fromFolder?: unknown },
  io: LibraryIo = libraryIo(),
  newId: () => string = randomUUID,
): Promise<LibraryBatchResult | Failure> {
  const from = spaceOf(input.space);
  if (!from) return { ok: false, status: 400, message: BAD_SPACE };
  const to = spaceOf(input.to);
  if (!to) return { ok: false, status: 400, message: BAD_TO };
  if (samePlace({ space: from, share: typeof input.share === 'string' ? input.share : null }, { space: to, share: typeof input.toShare === 'string' ? input.toShare : null })) {
    return { ok: false, status: 400, message: '같은 자료함 안에서는 폴더 옮기기를 쓰세요.' };
  }
  const fromPlaced = placeActor(actor, from, input.share);
  if (!fromPlaced.ok) return fromPlaced;
  const toPlaced = placeActor(actor, to, input.toShare);
  if (!toPlaced.ok) return toPlaced;
  const fromActor = fromPlaced.actor;
  const toActor = toPlaced.actor;
  const mode = input.mode === 'copy' || input.mode === 'move' ? input.mode : null;
  if (!mode) return { ok: false, status: 400, message: 'mode는 copy(복사)나 move(옮기기)로 적어 주세요.' };
  const target = cleanFolderName(input.folder);
  if (target === null) return { ok: false, status: 400, message: LIBRARY_FOLDER_RULE };
  const byIds = input.ids !== undefined && input.ids !== null;
  const byFolder = input.fromFolder !== undefined && input.fromFolder !== null;
  if (byIds === byFolder) return { ok: false, status: 400, message: '보낼 파일(ids)이나 폴더(fromFolder) 가운데 하나만 보내 주세요.' };
  let ids: string[] = [];
  let fromFolder: string | null = null;
  if (byIds) {
    if (!Array.isArray(input.ids) || input.ids.length === 0) return { ok: false, status: 400, message: '보낼 파일을 하나 이상 골라 주세요.' };
    if (input.ids.length > LIBRARY_TRANSFER_MAX) return { ok: false, status: 400, message: `한 번에 ${LIBRARY_TRANSFER_MAX}개까지 보낼 수 있습니다.` };
    if (input.ids.some((v) => typeof v !== 'string' || !UUID.test(v))) return { ok: false, status: 404, message: LIBRARY_NOT_FOUND };
    ids = [...new Set((input.ids as string[]).map((v) => v.toLowerCase()))];
  } else {
    fromFolder = cleanFolderName(input.fromFolder);
    if (fromFolder === null || fromFolder === '') return { ok: false, status: 400, message: '보낼 폴더를 골라 주세요(미분류는 파일을 골라 보내세요).' };
  }
  if (!canAddToLibrary(to, actor)) return { ok: false, status: 403, message: LIBRARY_ORG_ONLY };
  if (!io.findRows) return { ok: false, status: 503, message: LIBRARY_RETRY };

  let rows: Row[];
  let values: string[];
  let sourceValues: string[] = [];
  try {
    if (fromFolder !== null) sourceValues = await io.folderValues(fromActor, from);
    const folders = fromFolder !== null ? subtreeFolders(sourceValues, fromFolder) : null;
    [rows, values] = await Promise.all([
      io.findRows(fromActor, from, folders ? { folders, limit: LIBRARY_TRANSFER_MAX + 1 } : { ids, limit: LIBRARY_TRANSFER_MAX + 1 }),
      io.folderValues(toActor, to),
    ]);
  } catch {
    return { ok: false, status: 503, message: LIBRARY_RETRY };
  }
  if (byIds && rows.length !== ids.length) return { ok: false, status: 404, message: `${LIBRARY_NOT_FOUND}(${ids.length - rows.length}개)` };
  if (!rows.length) return { ok: false, status: 404, message: '그 폴더에 담긴 파일이 없습니다.' };
  if (rows.length > LIBRARY_TRANSFER_MAX) return { ok: false, status: 400, message: `폴더 안 파일이 ${LIBRARY_TRANSFER_MAX}개를 넘습니다 — 아래 폴더로 나눠 보내 주세요.` };
  if (mode === 'move') {
    const locked = rows.filter((r) => !canChangeLibraryRow(from, r, fromActor));
    if (locked.length) {
      const denied = noChange(from);
      return { ...denied, message: `${denied.message} (옮길 수 없는 파일 ${locked.length}개 — 복사는 됩니다)` };
    }
  }
  // 파일마다 받는 폴더 — 폴더째면 구조를 그대로
  const plan: { row: Row; folder: string }[] = [];
  for (const row of rows) {
    const own = typeof row.folder === 'string' ? row.folder : '';
    const folder = fromFolder !== null ? transferFolderPath(fromFolder, own, target) : target;
    if (folder === null) return { ok: false, status: 400, message: `받는 폴더 아래에 두면 ${LIBRARY_FOLDER_RULE}` };
    plan.push({ row, folder });
  }
  const max = libraryMaxFiles(to);
  const toLabel = libraryPlaceLabel({ space: to, share: toActor.shareId }, actor.shares);
  if (values.length + plan.length > max) {
    return { ok: false, status: 409, message: `${toLabel}에 ${max - values.length}개만 더 담을 수 있습니다(${plan.length}개를 보내려 함).` };
  }
  const after = new Set([...values, ...plan.map((x) => x.folder)].filter((v) => v !== ''));
  if (after.size > LIBRARY_MAX_FOLDERS) return { ok: false, status: 409, message: `보내면 ${toLabel}의 폴더가 ${LIBRARY_MAX_FOLDERS}개를 넘습니다.` };

  const failed: LibraryBatchResult['failed'] = [];
  const warnings: string[] = [];
  let sent = 0;
  for (const { row, folder } of plan) {
    const key = String(row.id ?? '').toLowerCase();
    const r = await sendRow({ fromActor, toActor }, row, key, { from, to, mode, folder }, io, newId);
    if (!r.ok) { failed.push({ id: key, file_name: row.file_name, message: r.message }); continue; }
    sent += 1;
    if (r.warning) warnings.push(`'${row.file_name}': ${r.warning}`);
  }
  return { ok: true, mode, to, sent, failed, warnings };
}

/**
 * 다시 붙이기·내려받기용 원본 — 내 자료함의 내 행, 아니면 지금 내 부서의 부서 자료함 행, 아니면 내 기관의 기관 자료함 행.
 * 없으면 null, DB 오류면 던진다
 */
export async function findLibraryOriginal(actor: LibraryActor, id: string, io: LibraryIo = libraryIo()): Promise<{ storage_path: string; file_name: string } | null> {
  if (!UUID.test(id)) return null;
  const key = id.toLowerCase();
  const row = (await io.findRow(actor, 'personal', key)) ?? (await io.findRow(actor, 'department', key)) ?? (await io.findRow(actor, 'organization', key))
    // (0116) 지금 내 부서가 든 공유 자료함의 행
    ?? (io.findSharedRow ? await io.findSharedRow(actor, key) : null);
  return row ? { storage_path: row.storage_path, file_name: row.file_name } : null;
}

// ── 공유 자료함(0116) ─────────────────────────────────────────────────────

/** 지금 이 부서가 든 이 기관의 공유 자료함 — 이름 순. 부서가 없으면 빈 목록, 못 읽으면 던진다 */
export async function loadLibraryShares(organizationId: string, departmentId: string | null | undefined): Promise<LibraryShare[]> {
  if (!departmentId) return [];
  const { data: links, error } = await supabaseAdmin.from('library_share_departments').select('share_id').eq('department_id', departmentId);
  if (error) throw new Error(`library_share_departments: ${error.message}`);
  const ids = [...new Set(((links ?? []) as { share_id: string }[]).map((l) => l.share_id))];
  if (!ids.length) return [];
  const { data, error: shareError } = await supabaseAdmin.from('library_shares').select('id, name').in('id', ids).eq('organization_id', organizationId);
  if (shareError) throw new Error(`library_shares: ${shareError.message}`);
  return ((data ?? []) as { id: string; name: string }[])
    .map((s) => ({ id: s.id, name: s.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
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
  /** 자리 조건 — 내 자료함은 담은 사람, 부서 자료함은 요청자의 지금 부서, 기관 자료함은 요청자의 기관. 모두 기관을 함께 건다 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scoped = (q: any, actor: LibraryActor, space: LibrarySpace) => (space === 'organization'
    ? q.eq('space', 'organization').eq('organization_id', actor.organizationId)
    : space === 'shared'
      // (0116) 고른 공유 자료함 — placeActor가 내가 든 것인지 본 id만, 없으면 아무 행도 안 맞는 id
      ? q.eq('space', 'shared').eq('share_id', actor.shareId ?? NIL_UUID).eq('organization_id', actor.organizationId)
    : space === 'department'
      ? q.eq('space', 'department').eq('department_id', actor.departmentId).eq('organization_id', actor.organizationId)
      : q.eq('space', 'personal').eq('user_id', actor.userId).eq('organization_id', actor.organizationId));
  const table = () => supabaseAdmin.from('my_library_files');
  return {
    async findSource(userId, kind, id) {
      const query = kind === 'attachment'
        ? supabaseAdmin.from('chat_attachments').select('storage_path, file_name, size_bytes, extract_path').eq('id', id).eq('user_id', userId).eq('status', 'ready')
        : supabaseAdmin.from('generated_files').select('storage_path, file_name, size_bytes').eq('id', id).eq('user_id', userId);
      const { data, error } = await query.maybeSingle();
      if (error) throw new Error(`library source: ${error.message}`);
      const row = data as { storage_path?: unknown; file_name?: unknown; size_bytes?: unknown; extract_path?: unknown } | null;
      return row && typeof row.storage_path === 'string' && typeof row.file_name === 'string'
        ? { storage_path: row.storage_path, file_name: row.file_name, size_bytes: Number(row.size_bytes ?? 0), extract_path: typeof row.extract_path === 'string' ? row.extract_path : null }
        : null;
    },
    async readContent(userId, kind, id, source) {
      try {
        if (kind === 'attachment') {
          // 첨부는 확인 때 읽어 둔 내용(주인 자리 경로인지 loadExtract가 다시 본다)
          const { loadExtract } = await import('@/lib/attachments/store');
          const extract = await loadExtract({ id, user_id: userId, storage_path: source.storage_path, extract_path: source.extract_path ?? null });
          return extract?.text ?? null;
        }
        const { readOriginalText } = await import('@/lib/source-original');
        const read = await readOriginalText(source.storage_path, source.file_name);
        return read.ok ? read.text : null;
      } catch {
        return null;
      }
    },
    async folderValues(actor, space) {
      const { data, error } = await scoped(table().select('folder'), actor, space).limit(libraryMaxFiles(space) + 50);
      if (error) throw new Error(`my_library_files: ${error.message}`);
      return ((data ?? []) as { folder: string | null }[]).map((r) => r.folder ?? '');
    },
    async page(actor, space, { folder, folders, query, cursor }) {
      // 찾을 때만 내용 글을 읽어 맞은 자리를 뽑는다(0117) — 찾기는 이름 + 내용을 이은 search_text(생성 칸)
      let q = scoped(table().select(query ? `${COLUMNS}, content_text` : COLUMNS), actor, space).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(LIBRARY_PAGE + 1);
      if (folders?.length) q = q.in('folder', folders);
      else if (folder !== null) q = q.eq('folder', folder);
      if (query) q = q.ilike('search_text', fileNamePattern(query));
      if (cursor) q = q.or(`created_at.lt.${cursor.at},and(created_at.eq.${cursor.at},id.lt.${cursor.id})`);
      const { data, error } = await q;
      if (error) throw new Error(`my_library_files: ${error.message}`);
      return (data ?? []) as unknown as Record<string, unknown>[];
    },
    async findRow(actor, space, id) {
      const { data, error } = await scoped(table().select(ROW_COLUMNS).eq('id', id), actor, space).maybeSingle();
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
    async findRows(actor, space, { ids, folders, limit }) {
      let q = scoped(table().select(ROW_COLUMNS), actor, space).order('created_at', { ascending: true }).order('id', { ascending: true }).limit(limit);
      if (ids) q = q.in('id', ids);
      if (folders) q = q.in('folder', folders);
      const { data, error } = await q;
      if (error) throw new Error(`my_library_files: ${error.message}`);
      return ((data ?? []) as (Record<string, unknown> & { storage_path?: unknown; file_name?: unknown; user_id?: unknown })[])
        .filter((r) => typeof r.storage_path === 'string' && typeof r.file_name === 'string' && typeof r.user_id === 'string') as Row[];
    },
    async findSharedRow(actor, id) {
      const shares = await loadLibraryShares(actor.organizationId, actor.departmentId);
      if (!shares.length) return null;
      const { data, error } = await table().select(ROW_COLUMNS).eq('id', id).eq('space', 'shared')
        .in('share_id', shares.map((s) => s.id)).eq('organization_id', actor.organizationId).maybeSingle();
      if (error) throw new Error(`my_library_files: ${error.message}`);
      const row = data as (Record<string, unknown> & { storage_path?: unknown; file_name?: unknown; user_id?: unknown }) | null;
      return row && typeof row.storage_path === 'string' && typeof row.file_name === 'string' && typeof row.user_id === 'string' ? (row as Row) : null;
    },
    async setFolder(actor, space, from, to) {
      const { data, error } = await scoped(table().update({ folder: to, updated_at: new Date().toISOString() }).eq('folder', from), actor, space).select('id');
      if (error) throw new Error(`my_library_files: ${error.message}`);
      return ((data ?? []) as unknown[]).length;
    },
  };
}
