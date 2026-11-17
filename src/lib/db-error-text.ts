/**
 * DB·서버 오류를 응답에 보일 한국어로(2026-11-17) — 아무것도 import하지 않는다.
 *
 * 슈퍼관리자 라우트가 `error: err.message`로 Supabase·Postgres 원문(칸·제약 이름·힌트)을 그대로 돌려줬다. 원문은 서버 기록에만
 * 남기고, 응답에는 Postgres 오류 코드로 가른 짧은 안내만 보낸다 — 겹침(23505)·연결된 기록(23503)·허용 범위(23514)·빈 칸(23502)은
 * 무엇을 고칠지 알 수 있게, 그 밖은 `fallback`.
 */
export const DB_ERROR_FALLBACK = '처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';

export function dbErrorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

export function dbErrorText(err: unknown, fallback: string = DB_ERROR_FALLBACK): string {
  switch (dbErrorCode(err)) {
    case '23505': return '이미 있는 값과 겹칩니다(이름·주소·이메일 등을 확인하세요).';
    case '23503': return '연결된 기록이 있거나 없는 대상을 가리켜 처리하지 못했습니다.';
    case '23514': return '허용 범위 밖의 값이 있어 저장하지 못했습니다.';
    case '23502': return '꼭 필요한 값이 비어 저장하지 못했습니다.';
    case '22P02': return '값의 형식이 올바르지 않습니다.';
    default: return fallback;
  }
}
