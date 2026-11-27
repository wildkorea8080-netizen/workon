// src/lib/public-ask/spec.ts
// 시민용 민원 상담 창(2026-11-27, 0136) — 상한·설정 검사·안내 글·공개 꼴. 잎 파일(화면·라우트·엔진이 함께 쓴다, 아무것도 가져오지 않음).
// 설계 docs/superpowers/specs/2026-11-27-public-ask-design.md

export const PUBLIC_ASK_QUESTION_MAX = 500;
export const PUBLIC_ASK_NOTICE_MAX = 500;
export const PUBLIC_ASK_FAQ_MAX = 5;
export const PUBLIC_ASK_FAQ_LEN = 60;
export const PUBLIC_ASK_CONTACTS_MAX = 10;
export const PUBLIC_ASK_ORIGINS_MAX = 5;
export const PUBLIC_ASK_IP_CAP = { min: 1, max: 100, default: 20 } as const;
export const PUBLIC_ASK_ORG_CAP = { min: 1, max: 5000, default: 500 } as const;
export const PUBLIC_ASK_LOG_DAYS = 30;
export const PUBLIC_ASK_ANSWER_MAX_TOKENS = 1200;
export const PUBLIC_ASK_STORED_QUESTION_MAX = 1000;
export const PUBLIC_ASK_STORED_ANSWER_MAX = 8000;

export type PublicAskContact = { name: string; phone: string; note: string };
export type PublicAskResult = 'answering' | 'answered' | 'no_source' | 'rejected_pii' | 'capped_ip' | 'capped_org' | 'unavailable';

/** 시민 화면이 받는 공개 설정 — 비서 id·문서·상한 값은 싣지 않는다 */
export type PublicAskConfig = {
  orgName: string;
  logoUrl: string | null;
  themeColor: string | null;
  notice: string;
  faq: string[];
  contacts: PublicAskContact[];
};

/** 관리자 설정 — 저장 꼴 */
export type PublicAskSettingsInput = {
  enabled: boolean;
  reason: string | null;
  notice: string;
  faq: string[];
  contacts: PublicAskContact[];
  allowedOrigins: string[];
  ipDailyCap: number;
  orgDailyCap: number;
};

export const PUBLIC_ASK_MESSAGES = {
  badQuestion: `질문을 ${PUBLIC_ASK_QUESTION_MAX}자 이내로 적어 주세요.`,
  notFound: '상담 창을 찾을 수 없습니다.',
  closed: '지금은 이 기관의 AI 상담을 운영하지 않습니다.',
  notReady: '상담 준비 중입니다. 담당 부서로 문의해 주세요.',
  budget: '오늘은 AI 상담을 더 받을 수 없습니다. 담당 부서로 문의해 주세요.',
  cappedIp: '오늘 질문할 수 있는 횟수를 모두 쓰셨습니다. 내일 다시 이용하시거나 담당 부서로 문의해 주세요.',
  cappedOrg: '오늘 AI 상담이 마감되었습니다. 내일 다시 이용하시거나 담당 부서로 문의해 주세요.',
  rejected: '주민등록번호·전화번호 같은 개인정보나 쓸 수 없는 말이 들어 있어 답하지 않았습니다. 개인정보를 빼고 다시 물어 주세요.',
  unavailable: '지금 답하지 못했습니다. 잠시 뒤 다시 물어 주세요.',
  noSource: '공개된 안내 자료에서 찾지 못했습니다. 아래 담당 부서로 문의해 주세요.',
} as const;

/** 시민 상담 비서에게 붙이는 지시 — 지정한 지시문 뒤에 붙는다 */
export function publicAskGuide(orgName: string): string {
  return [
    `[시민 상담 창] 지금은 ${orgName}의 홈페이지·안내 주소로 들어온 시민(외부인)의 질문에 답합니다.`,
    '- 참고 자료(이 기관이 시민에게 공개한 문서)에 있는 내용만 답하세요. 자료에 없으면 지어내지 말고 "안내 자료에서 찾지 못했다 — 담당 부서로 문의해 달라"고 답하세요',
    '- 쉬운 말로 짧게(5~8문장) 답하고, 결론(가능·불가·절차)을 먼저 쓰세요',
    '- 주민등록번호·연락처 같은 개인정보를 묻거나 받지 마세요. 처리 결과·보상·처분을 약속하지 마세요',
    '- 기관 내부 사정·직원 개인에 관한 질문에는 답하지 마세요',
  ].join('\n');
}

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === '\n' ? '\n' : '')).trim();
  return s.length <= max ? s : null;
};
const oneLine = (v: unknown, max: number): string | null => {
  const s = clean(v, max);
  return s === null ? null : s.replace(/\s+/g, ' ');
};

/** 허용 홈페이지 — https 주소의 출처(`https://host[:port]`)로 다듬는다. 아니면 null */
export function normalizeOrigin(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

/** 붙인 창을 넣을 수 있는 곳 — 허용 홈페이지가 없으면 아무 곳에도 넣지 못한다 */
export function frameAncestors(origins: string[]): string {
  const list = origins.map(normalizeOrigin).filter((o): o is string => !!o);
  return list.length ? `frame-ancestors 'self' ${list.join(' ')}` : "frame-ancestors 'self'";
}

const int = (v: unknown, range: { min: number; max: number }): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= range.min && v <= range.max ? v : null;

/** 관리자 설정 검사 — 다듬은 값 또는 까닭 글 */
export function parsePublicAskSettings(raw: Record<string, unknown>): { ok: true; value: PublicAskSettingsInput } | { ok: false; message: string } {
  if (typeof raw.enabled !== 'boolean') return { ok: false, message: '켜기 여부를 확인해 주세요.' };
  const reason = raw.reason === undefined || raw.reason === null || raw.reason === '' ? null : oneLine(raw.reason, 300);
  if (raw.enabled && !reason) return { ok: false, message: '켜는 사유를 300자 이내로 적어 주세요.' };
  const notice = clean(raw.notice ?? '', PUBLIC_ASK_NOTICE_MAX);
  if (notice === null) return { ok: false, message: `안내 문구는 ${PUBLIC_ASK_NOTICE_MAX}자 이내로 적어 주세요.` };
  if (!Array.isArray(raw.faq ?? [])) return { ok: false, message: '자주 묻는 질문을 목록으로 보내 주세요.' };
  const faq: string[] = [];
  for (const q of (raw.faq ?? []) as unknown[]) {
    const s = oneLine(q, PUBLIC_ASK_FAQ_LEN);
    if (s === null) return { ok: false, message: `자주 묻는 질문은 하나에 ${PUBLIC_ASK_FAQ_LEN}자 이내로 적어 주세요.` };
    if (s && !faq.includes(s)) faq.push(s);
  }
  if (faq.length > PUBLIC_ASK_FAQ_MAX) return { ok: false, message: `자주 묻는 질문은 ${PUBLIC_ASK_FAQ_MAX}개까지입니다.` };
  if (!Array.isArray(raw.contacts ?? [])) return { ok: false, message: '담당 부서 연락처를 목록으로 보내 주세요.' };
  const contacts: PublicAskContact[] = [];
  for (const c of (raw.contacts ?? []) as unknown[]) {
    const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    const name = oneLine(o.name ?? '', 40);
    const phone = oneLine(o.phone ?? '', 30);
    const note = oneLine(o.note ?? '', 100);
    if (name === null || phone === null || note === null) return { ok: false, message: '연락처는 부서 이름 40자·전화 30자·안내 100자 이내로 적어 주세요.' };
    if (!name && !phone && !note) continue;
    if (!name) return { ok: false, message: '연락처마다 부서 이름을 적어 주세요.' };
    contacts.push({ name, phone, note });
  }
  if (contacts.length > PUBLIC_ASK_CONTACTS_MAX) return { ok: false, message: `연락처는 ${PUBLIC_ASK_CONTACTS_MAX}개까지입니다.` };
  if (!Array.isArray(raw.allowedOrigins ?? [])) return { ok: false, message: '허용 홈페이지를 목록으로 보내 주세요.' };
  const allowedOrigins: string[] = [];
  for (const o of (raw.allowedOrigins ?? []) as unknown[]) {
    if (typeof o === 'string' && !o.trim()) continue;
    const n = normalizeOrigin(o);
    if (!n) return { ok: false, message: `홈페이지 주소는 https://로 시작하는 주소로 적어 주세요: ${String(o).slice(0, 60)}` };
    if (!allowedOrigins.includes(n)) allowedOrigins.push(n);
  }
  if (allowedOrigins.length > PUBLIC_ASK_ORIGINS_MAX) return { ok: false, message: `허용 홈페이지는 ${PUBLIC_ASK_ORIGINS_MAX}개까지입니다.` };
  const ipDailyCap = int(raw.ipDailyCap ?? PUBLIC_ASK_IP_CAP.default, PUBLIC_ASK_IP_CAP);
  if (ipDailyCap === null) return { ok: false, message: `한 사람(인터넷 주소)의 하루 질문 수는 ${PUBLIC_ASK_IP_CAP.min}~${PUBLIC_ASK_IP_CAP.max} 사이로 정해 주세요.` };
  const orgDailyCap = int(raw.orgDailyCap ?? PUBLIC_ASK_ORG_CAP.default, PUBLIC_ASK_ORG_CAP);
  if (orgDailyCap === null) return { ok: false, message: `기관 전체 하루 질문 수는 ${PUBLIC_ASK_ORG_CAP.min}~${PUBLIC_ASK_ORG_CAP.max} 사이로 정해 주세요.` };
  return { ok: true, value: { enabled: raw.enabled, reason, notice, faq, contacts, allowedOrigins, ipDailyCap, orgDailyCap } };
}

/** 저장된 연락처 jsonb를 믿지 않고 다시 읽는다 */
export function readContacts(raw: unknown): PublicAskContact[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map((c) => ({ name: String(c.name ?? '').slice(0, 40), phone: String(c.phone ?? '').slice(0, 30), note: String(c.note ?? '').slice(0, 100) }))
    .filter((c) => c.name)
    .slice(0, PUBLIC_ASK_CONTACTS_MAX);
}

/** 붙일 코드 — 기관 홈페이지에 한 줄 */
export function embedSnippet(appUrl: string, slug: string): string {
  const base = appUrl.replace(/\/+$/, '');
  return `<script src="${base}/ask/embed.js?org=${encodeURIComponent(slug)}" async></script>`;
}
