import { DOCUMENT_CONFIRM_WINDOW_MS } from '@/lib/document-upload';
import { ORG_TYPE_KEYS, isOrgType, type OrgType } from '@/lib/org-types';

/**
 * 공통 자료실(S5) 운영자 올리기의 경로와 확인 검사 — 순수 함수.
 *
 * 올리는 길은 참고 문서와 같다(브라우저가 저장소에 직접 → 확인). 경로는 서버가 정하고
 * 확인이 유형 열쇠·발급 시각을 경로에서 다시 읽어 판정한다 — 화면이 보낸 값은 믿지 않는다.
 */

const SEGMENT = /^[A-Za-z0-9-]{1,64}$/;
const PATH_RE = /^common\/([a-z]{1,16})\/(\d{1,16})-([A-Za-z0-9-]{1,64})\.([a-z0-9]{1,8})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const COMMON_EDITION_YEAR_MIN = 2000;
export const COMMON_EDITION_YEAR_MAX = 2100;
const TITLE_MAX_CHARS = 200;
const USAGE_TERMS_MAX_CHARS = 1000;

/** `common/{유형 열쇠}/{발급시각}-{id}.{확장자}` — 파일 이름은 경로에 넣지 않는다(한글·특수문자) */
export function commonStoragePath(input: { orgType: OrgType; now: number; id: string; ext: string }): string {
  const { orgType, now, id, ext } = input;
  if (!isOrgType(orgType)) throw new Error('알 수 없는 기관 유형입니다.');
  if (!SEGMENT.test(id)) throw new Error('잘못된 경로 조각');
  if (!/^[a-z0-9]{1,8}$/.test(ext)) throw new Error('잘못된 확장자');
  if (!Number.isInteger(now) || now < 0) throw new Error('잘못된 발급 시각');
  return `common/${ORG_TYPE_KEYS[orgType]}/${now}-${id}.${ext}`;
}

/** 이 모양이 아니면(거슬러 올라가는 조각 포함) null */
export function parseCommonStoragePath(
  path: string,
): { key: string; issuedAt: number; id: string; ext: string } | null {
  if (typeof path !== 'string') return null;
  const m = PATH_RE.exec(path);
  if (!m) return null;
  const issuedAt = Number(m[2]);
  if (!Number.isSafeInteger(issuedAt)) return null;
  return { key: m[1], issuedAt, id: m[3], ext: m[4] };
}

export type CommonConfirmInput = {
  storage_path: string;
  file_name: string;
  file_type: string | null;
  org_type: OrgType;
  title: string;
  edition_year: number;
  usage_terms: string;
  replaces_id: string | null;
};

export type CommonConfirmCheck =
  | { ok: true; value: CommonConfirmInput }
  | { ok: false; status: 400 | 410; message: string };

const BAD_PATH = '올린 파일의 경로가 올바르지 않습니다. 다시 올려 주세요.';

function reject(message: string): { ok: false; status: 400; message: string } {
  return { ok: false, status: 400, message };
}

/**
 * 확인 요청 본문 검사 — 유형·이름·기준 연도·이용 조건·경로 모양·경로 열쇠와 유형 일치·발급 10분.
 * 이름·이용 조건은 앞뒤를 뗀 글로 돌려준다. 파일 형식·크기는 라우트가 `checkUploadFile`·저장소 크기로 따로 본다.
 */
export function checkCommonConfirm(input: unknown, now: number): CommonConfirmCheck {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return reject('요청 형식이 올바르지 않습니다.');
  const b = input as Record<string, unknown>;

  if (!isOrgType(b.org_type)) return reject('기관 유형을 골라 주세요.');
  const orgType = b.org_type;

  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (!title) return reject('문서 이름을 입력해 주세요.');
  if (Array.from(title).length > TITLE_MAX_CHARS) return reject(`문서 이름은 ${TITLE_MAX_CHARS}자까지 쓸 수 있습니다.`);

  const year = b.edition_year;
  if (
    typeof year !== 'number' ||
    !Number.isInteger(year) ||
    year < COMMON_EDITION_YEAR_MIN ||
    year > COMMON_EDITION_YEAR_MAX
  ) {
    return reject(`기준 연도는 ${COMMON_EDITION_YEAR_MIN}~${COMMON_EDITION_YEAR_MAX} 사이의 정수여야 합니다.`);
  }

  const usageTerms = typeof b.usage_terms === 'string' ? b.usage_terms.trim() : '';
  if (!usageTerms) return reject('이용 조건 확인 내용을 입력해 주세요.');
  if (Array.from(usageTerms).length > USAGE_TERMS_MAX_CHARS) {
    return reject(`이용 조건 확인 내용은 ${USAGE_TERMS_MAX_CHARS}자까지 쓸 수 있습니다.`);
  }

  const fileName = typeof b.file_name === 'string' ? b.file_name : '';
  if (!fileName) return reject('유효하지 않은 파일명입니다.');
  const fileType = typeof b.file_type === 'string' && b.file_type ? b.file_type : null;

  let replacesId: string | null = null;
  if (b.replaces_id !== undefined && b.replaces_id !== null && b.replaces_id !== '') {
    if (typeof b.replaces_id !== 'string' || !UUID.test(b.replaces_id)) return reject('바꿀 옛 판이 올바르지 않습니다.');
    replacesId = b.replaces_id;
  }

  const storagePath = typeof b.storage_path === 'string' ? b.storage_path : '';
  const parsed = parseCommonStoragePath(storagePath);
  if (!parsed) return reject(BAD_PATH);
  if (parsed.key !== ORG_TYPE_KEYS[orgType]) return reject('올린 파일의 기관 유형과 선택한 유형이 다릅니다. 다시 올려 주세요.');
  if (parsed.issuedAt > now + 60_000) return reject(BAD_PATH);
  if (now - parsed.issuedAt > DOCUMENT_CONFIRM_WINDOW_MS) {
    return { ok: false, status: 410, message: '업로드 후 확인 시간이 지났습니다. 다시 올려 주세요.' };
  }

  return {
    ok: true,
    value: {
      storage_path: storagePath,
      file_name: fileName,
      file_type: fileType,
      org_type: orgType,
      title,
      edition_year: year,
      usage_terms: usageTerms,
      replaces_id: replacesId,
    },
  };
}
