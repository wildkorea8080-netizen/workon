/**
 * 비밀번호 찾기의 화면·서버 공용 값(잎 파일 — 아무것도 import하지 않는다. 화면이 서버 모듈을 불러오지 않게).
 */

/** 재설정 링크가 살아 있는 시간(분) */
export const RESET_LINK_MINUTES = 30;

/** 링크 열쇠 꼴 — 32바이트 base64url(43자) */
export const RESET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** 요청 화면의 같은 안내(계정이 있든 없든) */
export const RESET_REQUESTED_MESSAGE =
  '입력한 주소가 쓸 수 있는 계정이면 비밀번호 재설정 링크를 메일로 보냈습니다. 메일이 오지 않으면 주소를 확인하거나 기관 관리자에게 문의해 주세요.';

/** 재설정 화면 주소의 `#token=…`에서 열쇠를 꺼낸다(꼴이 아니면 null) */
export function tokenFromHash(hash: string): string | null {
  const m = /(?:^#|&)token=([^&]+)/.exec(hash.startsWith('#') ? hash : `#${hash}`);
  if (!m) return null;
  const token = m[1];
  return RESET_TOKEN_PATTERN.test(token) ? token : null;
}
