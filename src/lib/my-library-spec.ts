// src/lib/my-library-spec.ts
// 내 자료함(2026-11-24, 0103)·부서 자료함(0106) — 직원이 자주 쓰는 파일을 폴더로 모아 두고 대화·입력형 앱에 다시 붙인다.
// 꼴·상한·다듬기 규칙만 — 화면도 읽으므로 첨부 상한(잎 파일) 말고는 아무것도 가져오지 않는다.
import { attachmentExtension, MAX_ATTACHMENT_BYTES } from '@/lib/attachments/limits';

/** 한 사람이 담아 둘 수 있는 파일 수 */
export const LIBRARY_MAX_FILES = 300;
/** 한 부서의 부서 자료함 파일 수(0106) */
export const LIBRARY_MAX_DEPARTMENT_FILES = 500;

/** 자리 — personal(내 자료함, 담은 사람만) · department(부서 자료함, 지금 부서 사람이 함께) */
export type LibrarySpace = 'personal' | 'department';
export const LIBRARY_SPACE_LABEL: Record<LibrarySpace, string> = { personal: '내 자료함', department: '부서 자료함' };

/** 자리 읽기 — 없으면 내 자료함, 그 밖의 값은 null(거절) */
export function parseLibrarySpace(raw: unknown): LibrarySpace | null {
  if (raw === undefined || raw === null || raw === '' || raw === 'personal') return 'personal';
  return raw === 'department' ? 'department' : null;
}

/** 자리마다 담을 수 있는 수 */
export function libraryMaxFiles(space: LibrarySpace): number {
  return space === 'department' ? LIBRARY_MAX_DEPARTMENT_FILES : LIBRARY_MAX_FILES;
}
/** 한 사람의 폴더 수(미분류 제외) */
export const LIBRARY_MAX_FOLDERS = 30;
/** 폴더 이름 글자 수 */
export const LIBRARY_FOLDER_MAX = 30;
/** 파일 이름 글자 수 */
export const LIBRARY_NAME_MAX = 120;
/** 한 쪽 */
export const LIBRARY_PAGE = 50;
/** 파일 하나 — 대화 첨부와 같은 상한(다시 붙일 때 첨부가 되므로) */
export const LIBRARY_MAX_BYTES = MAX_ATTACHMENT_BYTES;

/** 담아 온 곳 — 대화 첨부(직접 올린 파일 포함)·비서가 만들어 준 파일 */
export type LibrarySource = 'attachment' | 'generated';

export interface LibraryFile {
  id: string;
  file_name: string;
  /** '' = 미분류 */
  folder: string;
  size_bytes: number;
  source: LibrarySource;
  created_at: string;
  /** 내가 담았는가(부서 자료함에서 바꾸기·지우기 단추) */
  mine: boolean;
  /** 담은 사람 이름 — 부서 자료함에서만(못 읽으면 null) */
  added_by?: string | null;
}

export interface LibraryFolder {
  /** '' = 미분류 */
  name: string;
  count: number;
}

export const LIBRARY_SOURCE_LABEL: Record<LibrarySource, string> = { attachment: '올린 파일', generated: '만든 파일' };
export const LIBRARY_UNFILED_LABEL = '미분류';

function tidy(raw: string): string {
  return raw.normalize('NFC').replace(/[\p{Cc}\p{Cf}[\]]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 폴더 이름 다듬기 — NFC·제어/보이지 않는 글자·`[ ]` 빼기·공백 하나로. 빈 글은 미분류('').
 * 글이 아니거나 30자를 넘거나 `/`가 들면 null(거절 — 한 단계 폴더만 둔다)
 */
export function cleanFolderName(raw: unknown): string | null {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') return null;
  const text = tidy(raw);
  if (Array.from(text).length > LIBRARY_FOLDER_MAX || /[/\\]/.test(text)) return null;
  return text;
}

/**
 * 파일 이름 바꾸기 — 다듬어 1~120자, **확장자는 그대로**여야 한다(다시 붙일 때 확장자로 읽는다).
 * 맞으면 다듬은 이름, 아니면 까닭
 */
export function cleanLibraryFileName(raw: unknown, current: string): { ok: true; name: string } | { ok: false; message: string } {
  if (typeof raw !== 'string') return { ok: false, message: '파일 이름을 적어 주세요.' };
  const name = tidy(raw);
  if (!name) return { ok: false, message: '파일 이름을 적어 주세요.' };
  if (Array.from(name).length > LIBRARY_NAME_MAX) return { ok: false, message: `파일 이름은 ${LIBRARY_NAME_MAX}자까지입니다.` };
  if (/[/\\]/.test(name)) return { ok: false, message: '파일 이름에 / 나 \\ 는 쓸 수 없습니다.' };
  const ext = attachmentExtension(current);
  if (!ext || attachmentExtension(name) !== ext) return { ok: false, message: `확장자(.${ext ?? ''})는 바꿀 수 없습니다.` };
  return { ok: true, name };
}

/** 폴더 목록 정렬 — 미분류 먼저, 그다음 이름 순(한국어) */
export function sortFolders(folders: LibraryFolder[]): LibraryFolder[] {
  return [...folders].sort((a, b) => (a.name === '' ? -1 : b.name === '' ? 1 : a.name.localeCompare(b.name, 'ko')));
}
