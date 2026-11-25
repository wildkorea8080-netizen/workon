// src/lib/my-library-spec.ts
// 내 자료함(2026-11-24, 0103)·부서 자료함(0106) — 직원이 자주 쓰는 파일을 폴더로 모아 두고 대화·입력형 앱에 다시 붙인다.
// 꼴·상한·다듬기 규칙만 — 화면도 읽으므로 첨부 상한(잎 파일) 말고는 아무것도 가져오지 않는다.
import { attachmentExtension, MAX_ATTACHMENT_BYTES } from '@/lib/attachments/limits';

/** 한 사람이 담아 둘 수 있는 파일 수 */
export const LIBRARY_MAX_FILES = 300;
/** 한 부서의 부서 자료함 파일 수(0106) */
export const LIBRARY_MAX_DEPARTMENT_FILES = 500;
/** 한 기관의 기관 자료함 파일 수(0112) */
export const LIBRARY_MAX_ORGANIZATION_FILES = 1000;
/** 공유 자료함 하나의 파일 수(0116) */
export const LIBRARY_MAX_SHARE_FILES = 500;
/** 기관마다 공유 자료함 수·한 공유 자료함의 부서 수·이름 글자 수(0116) */
export const LIBRARY_MAX_SHARES = 50;
export const LIBRARY_SHARE_MAX_DEPARTMENTS = 50;
export const LIBRARY_SHARE_NAME_MAX = 40;

/**
 * 자리 — personal(내 자료함, 담은 사람만) · department(부서 자료함, 지금 부서 사람이 함께) ·
 * organization(기관 자료함, 같은 기관 직원 누구나 보고 기관 전체 관리자만 담고 고침 — 0112) ·
 * shared(공유 자료함, 기관 전체 관리자가 고른 부서들의 사람이 함께 — 0116, 어느 공유 자료함인지는 `share`로 따로)
 */
export type LibrarySpace = 'personal' | 'department' | 'organization' | 'shared';
/** 늘 있는 탭 셋 — 공유 자료함은 내가 든 것만 그 뒤에 */
export const LIBRARY_SPACES: readonly LibrarySpace[] = ['personal', 'department', 'organization'];
export const LIBRARY_SPACE_LABEL: Record<LibrarySpace, string> = { personal: '내 자료함', department: '부서 자료함', organization: '기관 자료함', shared: '공유 자료함' };

/** 내가 든 공유 자료함(0116) — 이름과 id만 */
export type LibraryShare = { id: string; name: string };
/** 자료함 한 곳 — 공유 자료함이면 어느 것인지 */
export type LibraryPlace = { space: LibrarySpace; share?: string | null };

/** 자리 읽기 — 없으면 내 자료함, 그 밖의 값은 null(거절) */
export function parseLibrarySpace(raw: unknown): LibrarySpace | null {
  if (raw === undefined || raw === null || raw === '' || raw === 'personal') return 'personal';
  return raw === 'department' || raw === 'organization' || raw === 'shared' ? raw : null;
}

/** 자료함 이름 — 공유 자료함은 그 이름(모르면 '공유 자료함') */
export function libraryPlaceLabel(place: LibraryPlace, shares?: LibraryShare[] | null): string {
  if (place.space !== 'shared') return LIBRARY_SPACE_LABEL[place.space];
  const name = shares?.find((s) => s.id === place.share)?.name;
  return name ? `공유 자료함 '${name}'` : LIBRARY_SPACE_LABEL.shared;
}

/** 같은 자료함인가 */
export function samePlace(a: LibraryPlace, b: LibraryPlace): boolean {
  return a.space === b.space && (a.space !== 'shared' || (a.share ?? '').toLowerCase() === (b.share ?? '').toLowerCase());
}

/**
 * 이 자료함에서 복사·옮겨 보낼 수 있는 다른 자료함(0296·0299) — 늘 있는 셋(목록 응답 canAddTo, 못 읽었으면 기관 자료함 빼고)과 내가 든 공유 자료함, 지금 자료함은 뺀다
 */
export function transferPlaces(current: LibraryPlace, canAddTo: Record<LibrarySpace, boolean> | undefined, shares: LibraryShare[] | null | undefined): LibraryPlace[] {
  const base: LibraryPlace[] = LIBRARY_SPACES.filter((s) => (canAddTo ? canAddTo[s] === true : s !== 'organization')).map((space) => ({ space }));
  const shared: LibraryPlace[] = (shares ?? []).map((s) => ({ space: 'shared' as const, share: s.id }));
  return [...base, ...shared].filter((p) => !samePlace(p, current));
}

/** 공유 자료함 이름 다듬기(0116) — NFC·제어/보이지 않는 글자 빼기·공백 하나로, 1~40자. 아니면 null */
export function cleanShareName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();
  return name && Array.from(name).length <= LIBRARY_SHARE_NAME_MAX ? name : null;
}

/** 자리마다 담을 수 있는 수 */
/** 이 자리에서 복사·옮겨 보낼 수 있는 다른 자료함(0296) — 목록 응답의 canAddTo. 못 읽었으면 기관 자료함은 빼고(서버가 다시 본다) */
export function transferTargets(space: LibrarySpace, canAddTo: Record<LibrarySpace, boolean> | undefined): LibrarySpace[] {
  return LIBRARY_SPACES.filter((s) => s !== space && (canAddTo ? canAddTo[s] === true : s !== 'organization'));
}

export function libraryMaxFiles(space: LibrarySpace): number {
  return space === 'organization' ? LIBRARY_MAX_ORGANIZATION_FILES : space === 'department' ? LIBRARY_MAX_DEPARTMENT_FILES : space === 'shared' ? LIBRARY_MAX_SHARE_FILES : LIBRARY_MAX_FILES;
}

/** 함께 쓰는 자리인가(담은 사람 이름을 보인다) */
export function isSharedLibrarySpace(space: LibrarySpace): boolean {
  return space !== 'personal';
}
/** 한 사람의 폴더 수(미분류 제외) */
export const LIBRARY_MAX_FOLDERS = 30;
/** 폴더 이름(한 단계) 글자 수 */
export const LIBRARY_FOLDER_MAX = 30;
/** 폴더 단계 — `예산/2026/서식`처럼 `/`로 나눠 3단계까지(0113) */
export const LIBRARY_FOLDER_DEPTH = 3;
/** 폴더 경로 전체 글자 수(DB CHECK와 같음 — 0113) */
export const LIBRARY_FOLDER_PATH_MAX = 100;
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
  /** 담은 사람 이름 — 부서·기관 자료함에서만(못 읽으면 null) */
  added_by?: string | null;
  /** (0117) 찾기 글이 내용에서 맞은 자리 앞뒤 — 이름에서 맞았거나 찾지 않았으면 없음 */
  snippet?: LibrarySnippet | null;
}

/** (0117) 내용에서 맞은 자리 — 화면이 `hit`만 칠한다 */
export interface LibrarySnippet { before: string; hit: string; after: string }

/** (0117) 내용 찾기로 담아 두는 글 상한(글자) — DB CHECK와 같다 */
export const LIBRARY_CONTENT_MAX = 20_000;
/** 화면 안내 */
export const LIBRARY_CONTENT_SEARCH_NOTE = `이름과 담은 파일의 내용(앞 ${LIBRARY_CONTENT_MAX.toLocaleString('ko-KR')}자)에서 찾습니다. 스캔 PDF·읽지 못한 파일은 이름으로만 찾힙니다(내용을 아직 읽지 않은 파일은 몇 분 안에 채워집니다).`;

/**
 * (0117) 담을 때 읽은 글 → 찾기용 글. 제어·서식 글자를 빼고 공백을 하나로 접어 앞 20,000자(코드 포인트 — DB char_length와 같은 셈).
 * 남는 글이 없으면 null(이름으로만 찾힘)
 */
export function libraryContentText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const chars = Array.from(s);
  return chars.length > LIBRARY_CONTENT_MAX ? chars.slice(0, LIBRARY_CONTENT_MAX).join('').trim() : s;
}

/**
 * (0117) 내용에서 찾기 글이 처음 맞은 자리의 앞 30자·뒤 60자(대소문자 무시, NFC). 이름에서 맞았으면(이름이 품으면) null —
 * 이름이 이미 보인다. 맞은 자리가 없거나 찾기 글이 비면 null
 */
export function librarySnippet(content: unknown, fileName: string, query: string | null): LibrarySnippet | null {
  if (typeof content !== 'string' || !content || !query) return null;
  const needle = query.normalize('NFC').toLowerCase();
  if (!needle || fileName.normalize('NFC').toLowerCase().includes(needle)) return null;
  const text = content.normalize('NFC');
  const lower = text.toLowerCase();
  // 소문자로 바꿔 길이가 달라지는 글자(드묾)가 있으면 자리를 믿지 못한다 — 앞에서부터 맞대 본다
  const at = lower.length === text.length ? lower.indexOf(needle) : -1;
  if (at < 0) return null;
  const start = Math.max(0, at - 30);
  const end = Math.min(text.length, at + needle.length + 60);
  return {
    before: (start > 0 ? '…' : '') + text.slice(start, at),
    hit: text.slice(at, at + needle.length),
    after: text.slice(at + needle.length, end) + (end < text.length ? '…' : ''),
  };
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
 * 폴더 경로 다듬기(0113) — `/`로 나눈 단계마다 NFC·제어/보이지 않는 글자·`[ ]` 빼기·공백 하나로, 빈 단계는 버리고 다시 `/`로 잇는다.
 * 빈 글은 미분류(''). 글이 아니거나, 3단계를 넘거나, 한 단계가 30자를 넘거나, `\`·`"`가 들면 null(거절)
 */
export function cleanFolderName(raw: unknown): string | null {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') return null;
  if (/[\\"]/.test(raw)) return null;
  const parts = raw.split('/').map(tidy).filter(Boolean);
  if (parts.length > LIBRARY_FOLDER_DEPTH) return null;
  if (parts.some((p) => Array.from(p).length > LIBRARY_FOLDER_MAX)) return null;
  const path = parts.join('/');
  return Array.from(path).length > LIBRARY_FOLDER_PATH_MAX ? null : path;
}

/** 폴더 경로를 화면에 — `예산 › 2026` */
export function folderLabel(path: string): string {
  return path ? path.split('/').join(' › ') : LIBRARY_UNFILED_LABEL;
}

/** 이 폴더와 그 아래 폴더의 경로들(있는 값 중에서) — 폴더를 고르면 아래 폴더의 파일도 함께 보인다 */
export function subtreeFolders(values: string[], folder: string): string[] {
  if (folder === '') return [''];
  const prefix = `${folder}/`;
  const out = new Set([folder]);
  for (const v of values) if (v.startsWith(prefix)) out.add(v);
  return [...out];
}

/**
 * 폴더째 다른 자료함으로(0298) — `fromFolder` 아래 `folder`에 있던 파일을 받는 폴더 `target` 아래 어디에 둘지.
 * 보낸 폴더의 이름(마지막 단계)과 그 아래 구조를 그대로: `예산`·`예산/2026` → `공유/예산`·`공유/예산/2026`. 3단계·30자를 넘으면 null
 */
export function transferFolderPath(fromFolder: string, folder: string, target: string): string | null {
  if (folder !== fromFolder && !folder.startsWith(`${fromFolder}/`)) return null;
  const leaf = fromFolder.split('/').pop() ?? fromFolder;
  const rest = folder.slice(fromFolder.length);
  return cleanFolderName(target ? `${target}/${leaf}${rest}` : `${leaf}${rest}`);
}

/**
 * 폴더째 옮기기(0294) — `from`과 그 아래 경로를 `to` 아래로 바꾼 새 경로. 고른 폴더 값들(values) 가운데 바뀌는 것만 [옛, 새]로.
 * 자기 아래로 옮기기·3단계 넘김·한 단계 30자 넘김이면 까닭(거절)
 */
export function planFolderMove(values: string[], from: string, to: string): { ok: true; moves: [string, string][] } | { ok: false; message: string } {
  if (!from) return { ok: false, message: '옮길 폴더를 골라 주세요(미분류는 폴더째 옮길 수 없습니다).' };
  if (from === to) return { ok: false, message: '같은 폴더입니다.' };
  if (to === from || to.startsWith(`${from}/`)) return { ok: false, message: '폴더를 자기 아래 폴더로 옮길 수 없습니다.' };
  const prefix = `${from}/`;
  const moves: [string, string][] = [];
  for (const v of new Set(values)) {
    if (v !== from && !v.startsWith(prefix)) continue;
    const rest = v === from ? '' : v.slice(prefix.length);
    const next = [to, rest].filter(Boolean).join('/');
    const parts = next ? next.split('/') : [];
    if (parts.length > LIBRARY_FOLDER_DEPTH) return { ok: false, message: `옮기면 ${LIBRARY_FOLDER_DEPTH}단계를 넘는 폴더가 생깁니다: ${next.slice(0, 60)}` };
    moves.push([v, next]);
  }
  if (!moves.length) return { ok: false, message: '그 폴더에 담긴 파일이 없습니다.' };
  // 얕은 경로부터 — 윗단계로 옮길 때('가/나' → '가') 새 경로가 아직 안 옮긴 옛 경로와 같아질 수 있어, 먼저 옮긴 파일이 또 옮겨지지 않게
  moves.sort((a, b) => a[0].length - b[0].length);
  return { ok: true, moves };
}

/** 폴더 나무 한 줄 — 단계(0부터)·마지막 이름·그 아래까지 합친 파일 수 */
export interface LibraryFolderNode { path: string; name: string; depth: number; count: number }

/**
 * 폴더 목록 → 나무(0113) — 파일이 없는 윗단계 폴더도 넣고, 수는 그 아래까지 합친다. 미분류 먼저, 그다음 이름 순으로 깊이 우선
 */
export function folderTree(folders: LibraryFolder[]): LibraryFolderNode[] {
  const totals = new Map<string, number>();
  for (const f of folders) {
    if (f.name === '') { totals.set('', (totals.get('') ?? 0) + f.count); continue; }
    const parts = f.name.split('/');
    for (let i = 1; i <= parts.length; i += 1) {
      const path = parts.slice(0, i).join('/');
      totals.set(path, (totals.get(path) ?? 0) + f.count);
    }
  }
  const nodes = Array.from(totals, ([path, count]) => ({ path, name: path ? path.slice(path.lastIndexOf('/') + 1) : LIBRARY_UNFILED_LABEL, depth: path ? path.split('/').length - 1 : 0, count }));
  // 깊이 우선 정렬 — 경로를 단계별로 견준다(미분류는 맨 앞)
  return nodes.sort((a, b) => {
    if (a.path === '') return -1;
    if (b.path === '') return 1;
    const x = a.path.split('/');
    const y = b.path.split('/');
    for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
      const c = x[i].localeCompare(y[i], 'ko');
      if (c !== 0) return c;
    }
    return x.length - y.length;
  });
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
