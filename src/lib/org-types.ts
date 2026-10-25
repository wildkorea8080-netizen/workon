/**
 * 기관 유형 표와 공통 자료실(S5)의 NODA 보관함·파일 이름 규칙.
 *
 * 아무것도 import하지 않는다 — 서버 코드와 화면이 함께 읽는다(`attachments/limits.ts`와 같은 이유).
 * 유형은 기관(`organizations.type`)에 한글 그대로 저장되고, 공통 문서(`common_documents.org_type`)도 같은 글이다.
 */

export const ORG_TYPES = ['중앙행정기관', '지방자치단체', '공공기관', '교육기관', '협회단체', '일반기업'] as const;
export type OrgType = (typeof ORG_TYPES)[number];

/** 보관함 이름·저장소 경로에 쓰는 영문 열쇠 */
export const ORG_TYPE_KEYS: Record<OrgType, string> = {
  중앙행정기관: 'central',
  지방자치단체: 'local',
  공공기관: 'public',
  교육기관: 'edu',
  협회단체: 'assoc',
  일반기업: 'company',
};

export function isOrgType(v: unknown): v is OrgType {
  return typeof v === 'string' && (ORG_TYPES as readonly string[]).includes(v);
}

const COMMON_TENANT_PREFIX = 'workon-c-';

/** 유형의 공통 NODA 보관함 — `workon-c-{열쇠}`. 표 밖 값이면 던진다(요청값으로 보관함을 만들지 않는다) */
export function commonTenant(orgType: OrgType): string {
  if (!isOrgType(orgType)) throw new Error('알 수 없는 기관 유형입니다.');
  return `${COMMON_TENANT_PREFIX}${ORG_TYPE_KEYS[orgType]}`;
}

/** 공통 보관함 이름에서 유형을 거꾸로 찾는다. 비서 보관함이거나 모르는 이름이면 null */
export function orgTypeFromCommonTenant(tenant: string): OrgType | null {
  if (typeof tenant !== 'string' || !tenant.startsWith(COMMON_TENANT_PREFIX)) return null;
  const key = tenant.slice(COMMON_TENANT_PREFIX.length);
  for (const t of ORG_TYPES) {
    if (ORG_TYPE_KEYS[t] === key) return t;
  }
  return null;
}

/** 파일 이름에 못 쓰는 글자 — `/ \ : * ? " < > |`, 제어 문자, 서식 글자(방향 제어·폭 없는 글자 등) */
const FORBIDDEN_NAME_CHARS = /[\/\\:*?"<>|\p{Cc}\p{Cf}]/gu;
const TITLE_MAX_CHARS = 80;

/**
 * 공통 문서의 NODA 파일 이름 — `{id}__{다듬은 이름}({기준 연도}){원래 확장자}`.
 * 모델이 보는 근거 머리 줄에 이름과 연도가 그대로 실린다. 이름은 운영자가 쓴 글이라 못 쓰는 글자를 빼고 80자에서 자른다.
 * 확장자는 `fileName`의 마지막 `.` 뒤를 점까지 그대로 둔다(NODA가 확장자로 읽는다) — 없으면 붙이지 않는다.
 */
export function commonNodaFilename(input: { id: string; title: string; editionYear: number; fileName: string }): string {
  const cleaned = Array.from(input.title.replace(FORBIDDEN_NAME_CHARS, '').trim())
    .slice(0, TITLE_MAX_CHARS)
    .join('');
  const name = cleaned || '문서';
  const dot = input.fileName.lastIndexOf('.');
  const ext = dot >= 0 ? input.fileName.slice(dot) : '';
  return `${input.id}__${name}(${input.editionYear})${ext}`;
}
