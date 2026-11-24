// src/lib/org-sso-spec.ts
// 기관 SSO(OIDC, 2026-11-25, 0107) — 꼴·안내 글·설정 입력 검사. 화면도 읽으므로 아무것도 가져오지 않는다(잎 파일).

export const SSO_DEFAULT_LABEL = '기관 계정으로 로그인';
export const SSO_LABEL_MAX = 30;
export const SSO_MAX_DOMAINS = 10;

/** 로그인 화면으로 돌려보낼 때의 까닭(`?error=`) — 화면이 아래 글로 바꾼다 */
export type SsoErrorCode = 'sso_unavailable' | 'sso_denied' | 'sso_expired' | 'sso_no_account' | 'sso_domain' | 'sso_rejected' | 'sso_dormant' | 'sso_only';

export const SSO_ERROR_MESSAGES: Record<SsoErrorCode, string> = {
  sso_unavailable: '기관 계정 로그인을 지금 확인하지 못했습니다. 잠시 뒤 다시 시도하거나 이메일·비밀번호로 로그인해 주세요.',
  sso_denied: '기관 계정 로그인이 취소되었거나 거절되었습니다.',
  sso_expired: '기관 계정 로그인 시간이 지났습니다. 처음부터 다시 시도해 주세요.',
  sso_no_account: '이 기관 계정과 연결된 WORKON 계정이 없습니다. 기관 관리자에게 계정 등록을 요청하세요(같은 이메일로 등록돼 있어야 합니다).',
  sso_domain: '이 기관에서 허용하지 않은 이메일 도메인의 계정입니다.',
  sso_rejected: '사용 중지된 계정입니다. 기관 관리자에게 문의하세요.',
  sso_dormant: '오래 로그인하지 않아 계정이 잠겼습니다. 기관 관리자에게 다시 사용을 요청하세요.',
  // (0109) 비밀번호로 들어와 있던 직원의 로그인을 미들웨어가 끝냈을 때
  sso_only: '이 기관은 직원 로그인을 기관 계정(SSO)으로만 받습니다. 기관 전용 로그인 화면에서 기관 계정으로 로그인해 주세요.',
};

/**
 * SSO 전용(0109) — 기관이 '직원은 기관 계정으로만'을 켰는데 직원이 이메일·비밀번호로 로그인했을 때 서버가 던지는 까닭.
 * 비밀번호가 맞았을 때만 던진다(틀린 비밀번호는 지금처럼 '올바르지 않습니다')
 */
export const SSO_ONLY = 'SSO_ONLY';
export const SSO_ONLY_MESSAGE = '이 기관은 직원 로그인을 기관 계정(SSO)으로만 받습니다. 기관 전용 로그인 화면의 기관 계정 로그인 단추를 써 주세요(비밀번호 로그인은 기관 관리자만 됩니다).';

export function ssoErrorMessage(code: string | null | undefined): string | null {
  return code && code in SSO_ERROR_MESSAGES ? SSO_ERROR_MESSAGES[code as SsoErrorCode] : null;
}

/** 관리자 화면에 보이는 설정(비밀값 없음) */
export interface SsoConfigView {
  issuer: string;
  clientId: string;
  hasSecret: boolean;
  emailDomains: string[];
  enabled: boolean;
  /** 직원은 기관 계정으로만(0109) — 관리자는 비밀번호도 된다 */
  ssoOnly: boolean;
  buttonLabel: string;
  updatedAt: string | null;
}

export type SsoConfigInput = { issuer: string; clientId: string; clientSecret: string | null; emailDomains: string[]; enabled: boolean; ssoOnly: boolean; buttonLabel: string };

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** 발급자 주소 다듬기 — https만, 쿼리·조각 없음, 끝 '/'는 뗀다(발견 문서의 issuer와 맞댈 때도 같은 다듬기) */
export function normalizeIssuer(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  return url.toString().replace(/\/+$/, '');
}

/** 설정 저장 요청 검사 — 비밀값은 비우면 '그대로 둠'(null) */
export function parseSsoConfig(raw: unknown): { ok: true; value: SsoConfigInput } | { ok: false; message: string } {
  const b = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null) as Record<string, unknown> | null;
  if (!b) return { ok: false, message: '요청 형식이 올바르지 않습니다.' };
  const issuer = typeof b.issuer === 'string' ? normalizeIssuer(b.issuer) : null;
  if (!issuer) return { ok: false, message: '발급자(issuer) 주소를 https:// 주소로 적어 주세요(예: https://login.microsoftonline.com/{테넌트}/v2.0).' };
  const clientId = typeof b.clientId === 'string' ? b.clientId.trim() : '';
  if (!clientId || clientId.length > 200 || /\s/.test(clientId)) return { ok: false, message: '클라이언트 ID를 적어 주세요(공백 없이 200자까지).' };
  let clientSecret: string | null = null;
  if (b.clientSecret !== undefined && b.clientSecret !== null && b.clientSecret !== '') {
    if (typeof b.clientSecret !== 'string' || b.clientSecret.length > 500 || /[\r\n]/.test(b.clientSecret)) return { ok: false, message: '클라이언트 비밀값이 올바르지 않습니다(500자까지).' };
    clientSecret = b.clientSecret.trim();
  }
  let emailDomains: string[] = [];
  if (b.emailDomains !== undefined && b.emailDomains !== null) {
    const list = Array.isArray(b.emailDomains) ? b.emailDomains : typeof b.emailDomains === 'string' ? b.emailDomains.split(/[\s,]+/) : null;
    if (!list) return { ok: false, message: '허용 이메일 도메인은 목록으로 적어 주세요.' };
    emailDomains = [...new Set(list.filter((d) => typeof d === 'string' && d.trim()).map((d) => (d as string).trim().toLowerCase().replace(/^@/, '')))];
    if (emailDomains.length > SSO_MAX_DOMAINS) return { ok: false, message: `허용 이메일 도메인은 ${SSO_MAX_DOMAINS}개까지입니다.` };
    const bad = emailDomains.find((d) => !DOMAIN.test(d));
    if (bad) return { ok: false, message: `도메인 꼴이 아닙니다: ${bad.slice(0, 60)}` };
  }
  if (b.enabled !== undefined && typeof b.enabled !== 'boolean') return { ok: false, message: '켜기는 true 또는 false로 보내 주세요.' };
  if (b.ssoOnly !== undefined && typeof b.ssoOnly !== 'boolean') return { ok: false, message: 'SSO 전용은 true 또는 false로 보내 주세요.' };
  // 켜지 않은 SSO로 비밀번호 로그인을 끄면 직원이 아무도 못 들어온다
  if (b.ssoOnly === true && b.enabled !== true) return { ok: false, message: '직원 비밀번호 로그인 끄기는 기관 계정 로그인을 켤 때만 고를 수 있습니다.' };
  const label = typeof b.buttonLabel === 'string' ? b.buttonLabel.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').trim() : '';
  if (Array.from(label).length > SSO_LABEL_MAX) return { ok: false, message: `단추 글은 ${SSO_LABEL_MAX}자까지입니다.` };
  return { ok: true, value: { issuer, clientId, clientSecret, emailDomains, enabled: b.enabled === true, ssoOnly: b.ssoOnly === true, buttonLabel: label || SSO_DEFAULT_LABEL } };
}
