// src/lib/work/workflows/regulations/evidence.ts
/**
 * 규정·지침 확인 — 근거 하나와 그 근거를 기준일·기관에 쓸 수 있는지(순수 함수, DB·NODA·모델을 모름).
 *
 * 지키는 것(카탈로그 validationRules: 기관·지역·효력일·별표·예외 / 충돌·근거 부족 유보 / 실제 확인한 원문 위치만)
 *  - 위치(쪽·절·조문)는 **찾은 자료의 정보에서만** 만든다. 모델은 근거 번호(E1…)만 고른다
 *  - 시행일이 기준일 뒤인 근거, 다른 기관(다른 지자체) 자료는 근거로 쓰지 않는다(목록에는 '제외'로 남긴다)
 *  - 시행일을 모르는 기관 문서는 쓰되 '시행일 확인 필요'를 붙인다 — 짐작으로 적용된다고 하지 않는다
 */
export type EvidenceKind = 'org_doc' | 'common' | 'law' | 'ordinance' | 'upload';

export type Applicability = 'applicable' | 'date_unknown' | 'after_basis' | 'other_org';

/** 제공자(기관 문서·공통 자료실·법령·추가 자료)가 찾은 근거 — 번호·적용 판정 전 */
export interface RawEvidence {
  kind: EvidenceKind;
  title: string;
  /** 자료가 알려 준 위치만(p.12 · 제3장 › 숙박비 / 제17조(숙박비)). 모르면 null */
  location: string | null;
  /** 'YYYY-MM-DD' — 자료가 알려 준 시행일만 */
  effectiveDate: string | null;
  /** 공통 자료실 기준 연도 */
  editionYear: number | null;
  /** 자치법규의 지자체 이름 등 — 다른 기관 판정에 쓴다 */
  issuer: string | null;
  text: string;
  url: string | null;
}

export interface RegulationEvidence extends RawEvidence {
  /** 'E1'… 이 판에서 매긴 번호 */
  id: string;
  applicability: Applicability;
  /** 판정 이유(화면·메모에 그대로) */
  note: string | null;
}

export const EVIDENCE_TEXT_MAX = 1_500;
export const MAX_EVIDENCE = 24;

export const KIND_LABEL: Record<EvidenceKind, string> = {
  org_doc: '기관 문서',
  common: '공통 기준',
  law: '법령',
  ordinance: '자치법규',
  upload: '추가 자료',
};

/** 근거로 쓸 수 있는 판정 — 시행일 모름은 쓰되 확인 필요를 붙인다 */
export function isUsable(a: Applicability): boolean {
  return a === 'applicable' || a === 'date_unknown';
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 'YYYY-MM-DD'·'YYYYMMDD'·'2026. 1. 1.'을 'YYYY-MM-DD'로. 못 읽으면 null(짐작하지 않음) */
export function normalizeDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(s) ?? /^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1948 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 법령 본문 머리의 '(시행 2026-01-01)'에서 시행일을 읽는다 */
export function parseEnforcedDate(text: string): string | null {
  const m = /\(시행\s*([0-9.\-\s]{8,12})\)/.exec(text);
  return m ? normalizeDate(m[1].trim()) : null;
}

/** 기관 이름 비교용 — 공백·'청' 끝을 떼어 '가나시청' ↔ '가나시'를 같게 본다 */
function orgStem(name: string): string {
  return name.replace(/\s+/g, '').replace(/\((?:시험|가칭)\)$/, '').replace(/청$/, '');
}

/** 자치법규의 지자체가 이 기관인가 — 모르면 false(다른 기관으로 본다: 섞여 들어오는 쪽을 막는다) */
export function sameLocalGovernment(organizationName: string | null, issuer: string | null): boolean {
  if (!organizationName || !issuer) return false;
  const a = orgStem(organizationName);
  const b = orgStem(issuer);
  return a.length >= 2 && b.length >= 2 && (a === b || a.startsWith(b) || b.startsWith(a));
}

const ORG_NAME = /([가-힣]{2,20}(?:특별자치시|특별자치도|광역시|특별시|시청|군청|구청|도청|공단|공사|재단|진흥원|연구원|센터|협회))/;

/**
 * 추가 자료가 다른 기관 규정으로 보이는가 — 머리(앞 300자)에 기관 이름이 있는데 이 기관 이름은 자료 어디에도 없을 때만.
 * 본문에 남의 기관 이름이 나오는 것(인용·협약 상대)만으로는 다른 기관으로 보지 않는다
 */
export function foreignIssuerOf(text: string, organizationName: string | null): string | null {
  if (!organizationName) return null;
  const head = text.slice(0, 300);
  const m = ORG_NAME.exec(head);
  if (!m) return null;
  const own = orgStem(organizationName);
  if (own.length >= 2 && text.replace(/\s+/g, '').includes(own)) return null;
  return m[1];
}

/** 근거 하나의 적용 판정 */
export function assessEvidence(e: RawEvidence, ctx: { basisDate: string; organizationName: string | null }): { applicability: Applicability; note: string | null } {
  const basis = normalizeDate(ctx.basisDate);
  if (e.kind === 'ordinance' && !sameLocalGovernment(ctx.organizationName, e.issuer)) {
    return { applicability: 'other_org', note: `다른 지자체의 자치법규입니다${e.issuer ? `(${e.issuer})` : ''}` };
  }
  if (e.kind === 'upload') {
    const foreign = foreignIssuerOf(e.text, ctx.organizationName);
    if (foreign) return { applicability: 'other_org', note: `다른 기관의 자료로 보입니다(${foreign}) — 이 기관 규정이면 근거로 다시 확인하세요` };
  }
  const eff = normalizeDate(e.effectiveDate);
  if (eff && basis && eff > basis) {
    return { applicability: 'after_basis', note: `시행일(${eff})이 적용 기준일(${basis}) 뒤입니다 — 기준일에 적용되던 판을 따로 확인해야 합니다` };
  }
  if (e.kind === 'common' && e.editionYear && basis && e.editionYear > Number(basis.slice(0, 4))) {
    return { applicability: 'after_basis', note: `${e.editionYear}년 판으로 적용 기준일(${basis})보다 뒤의 기준입니다` };
  }
  if (eff) return { applicability: 'applicable', note: null };
  if (e.kind === 'common' && e.editionYear) return { applicability: 'applicable', note: null };
  return { applicability: 'date_unknown', note: '시행일을 자료에서 확인하지 못했습니다 — 기준일에 적용되는 판인지 확인하세요' };
}

/** 번호를 매기고 판정을 붙인다(순서는 제공자 순서: 기관 문서 → 공통 기준 → 법령 → 자치법규 → 추가 자료) */
export function numberEvidence(raw: RawEvidence[], ctx: { basisDate: string; organizationName: string | null }): RegulationEvidence[] {
  return raw.slice(0, MAX_EVIDENCE).map((e, i) => ({
    ...e,
    text: e.text.slice(0, EVIDENCE_TEXT_MAX),
    id: `E${i + 1}`,
    ...assessEvidence(e, ctx),
  }));
}

/** 메모·화면에 쓰는 근거 한 줄 — 위치·시행일은 자료 정보에서만 */
export function evidenceLine(e: RegulationEvidence): string {
  const where = e.location ? ` · ${e.location}` : '';
  const when = e.effectiveDate ? `시행 ${e.effectiveDate}` : e.editionYear ? `${e.editionYear}년 판` : '시행일 확인 필요';
  return `[${e.id}] ${e.title}${where} (${KIND_LABEL[e.kind]}, ${when})`;
}
