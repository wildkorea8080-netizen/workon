/**
 * 비밀번호 규칙(2026-11-16) — 아무것도 import하지 않는다(비밀번호 바꾸기 화면도 읽는다).
 *
 * 공공기관 보안 점검의 흔한 기준(영문 대문자·소문자·숫자·특수문자 중 세 종류 이상이면 8자, 두 종류면 10자 이상)을 따른다.
 * bcrypt는 72바이트 뒤를 버리므로 그보다 긴 비밀번호는 받지 않는다(뒤가 달라도 같은 비밀번호로 통과하게 된다).
 */

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_BYTES = 72;

export const PASSWORD_RULE_TEXT = '영문 대문자·소문자·숫자·특수문자 중 세 종류 이상이면 8자, 두 종류면 10자 이상(72바이트까지)';

function kinds(pw: string): number {
  return [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9\s]/].filter((re) => re.test(pw)).length;
}

function utf8Bytes(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/** 규칙에 어긋나면 한국어 까닭, 맞으면 null */
export function passwordPolicyError(pw: unknown, opts: { email?: string | null } = {}): string | null {
  if (typeof pw !== 'string' || pw.length === 0) return '새 비밀번호를 입력해 주세요.';
  if (/\s/.test(pw)) return '비밀번호에 공백은 쓸 수 없습니다.';
  if (utf8Bytes(pw) > PASSWORD_MAX_BYTES) return `비밀번호가 너무 깁니다(${PASSWORD_MAX_BYTES}바이트까지).`;
  const k = kinds(pw);
  if (pw.length < PASSWORD_MIN_LENGTH || k < 2 || (k === 2 && pw.length < 10)) return `비밀번호는 ${PASSWORD_RULE_TEXT}이어야 합니다.`;
  if (/(.)\1{3,}/.test(pw)) return '같은 글자를 네 번 넘게 잇달아 쓸 수 없습니다.';
  const id = (opts.email ?? '').split('@')[0]?.toLowerCase() ?? '';
  if (id.length >= 4 && pw.toLowerCase().includes(id)) return '비밀번호에 이메일 아이디를 넣을 수 없습니다.';
  return null;
}
