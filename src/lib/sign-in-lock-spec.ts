/**
 * 로그인 실패 잠금의 화면 공용 값(2026-11-13) — 아무것도 import하지 않는다(로그인 화면이 읽는다).
 * 서버 쪽 규칙은 `sign-in-throttle.ts`.
 */
export const ACCOUNT_LOCKED = 'ACCOUNT_LOCKED';
export const LOCKED_MESSAGE = '로그인을 여러 번 실패해 30분 동안 잠겼습니다. 잠시 뒤 다시 시도하거나 관리자에게 문의하세요.';

/**
 * IP 잠금(2026-11-17) — 같은 인터넷 주소에서 30분에 30번 틀려 그 주소의 로그인을 막았을 때. 기관 관리자도 같은 주소라 들어와 풀 수 없고,
 * 계정 잠금 풀기로도 풀리지 않는다 — 서비스 운영자(슈퍼관리자 '계정 관리'의 IP 로그인 잠금)만 푼다. 계정 이야기는 하지 않는다
 */
export const IP_LOCKED = 'IP_LOCKED';
export const IP_LOCKED_MESSAGE = '이 인터넷 주소(사무실 네트워크)에서 로그인 실패가 많아 30분 동안 로그인이 막혔습니다. 잠시 뒤 다시 시도하거나, 기관 담당자가 서비스 운영자에게 잠금 풀기를 요청해 주세요.';

/** 장기 미접속 잠금(0095) — 기관이 켰을 때 */
export const ACCOUNT_DORMANT = 'ACCOUNT_DORMANT';
export const DORMANT_MESSAGE = '오래 로그인하지 않아 계정이 사용 중지되었습니다. 기관 관리자에게 다시 사용을 요청해 주세요.';

/**
 * IP 잠금 확인·풀기(2026-11-17) — 관리자가 넣은 IP를 다듬는다. 로그인 기록은 받은 머리글 값 그대로를 해시하므로(`requestIp`)
 * 여기서도 같은 꼴(앞뒤 공백 없는 IPv4 점 네 칸 / IPv6 소문자)로만 맞춘다. 꼴이 아니면 null
 */
export function normalizeIp(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const ip = raw.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return ip.split('.').every((p) => Number(p) <= 255 && String(Number(p)) === p) ? ip : null;
  }
  if (ip.length <= 45 && ip.includes(':') && /^[0-9a-fA-F:.]+$/.test(ip)) return ip.toLowerCase();
  return null;
}

/** 기록·화면에 남길 꼴 — IPv4는 끝 칸, IPv6는 앞 세 칸 뒤를 가린다 */
export function maskIp(ip: string): string {
  if (ip.includes('.') && !ip.includes(':')) return ip.split('.').slice(0, 3).join('.') + '.x';
  return ip.split(':').slice(0, 3).join(':') + ':…';
}

/** 관리 화면의 '… 풀림' 글 — 한국 시간 시:분(오늘이 아니면 월/일도) */
export function lockUntilLabel(iso: string, nowMs = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '잠김';
  const kst = (ms: number) => new Date(ms + 9 * 3_600_000);
  const d = kst(t);
  const hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const sameDay = kst(nowMs).toISOString().slice(0, 10) === d.toISOString().slice(0, 10);
  return sameDay ? `${hm} 풀림` : `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hm} 풀림`;
}
