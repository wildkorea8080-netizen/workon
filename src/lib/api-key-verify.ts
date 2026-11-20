/**
 * 슈퍼관리자 API 키 '검증'의 판정·입력 검사(2026-11-19).
 *
 * 예전: 응답 401·403이 아니면 모두 '유효한 키'(Anthropic 장애 500·529, 시간 초과는 500 원문)였고, 거절이면 Anthropic 영문 원문을
 * 그대로 보였다. 저장한 시스템 키의 '검증' 단추는 화면에 보이는 가린 키('sk-ant-…••••')를 보내 **늘 '유효하지 않은 키'** 였다.
 * 판정은 이 한 곳 — 맞음·틀림·확인 못 함(null) 셋. Anthropic 호출 자체는 예외 목록의 두 라우트에 둔다(`llm-boundary.test.ts`).
 *
 * 아무것도 import하지 않는다(화면도 문구를 읽는다).
 */
export const KEY_VERIFY_TIMEOUT_MS = 10_000;
export const MAX_KEY_LENGTH = 500;

export type KeyVerdict = { valid: boolean | null; message: string };

export const KEY_VALID_MESSAGE = '유효한 키입니다.';
export const KEY_INVALID_MESSAGE = '키가 맞지 않습니다(Anthropic이 인증을 거절했습니다).';
export const KEY_UNKNOWN_MESSAGE = '지금은 키를 확인하지 못했습니다(Anthropic 응답 없음·장애). 잠시 뒤 다시 확인해 주세요.';

/** Anthropic 응답 상태 → 판정. null = 연결 실패·시간 초과 */
export function anthropicKeyVerdict(status: number | null): KeyVerdict {
  if (status === 401 || status === 403) return { valid: false, message: KEY_INVALID_MESSAGE };
  // 2xx·400(요청 형식·크레딧)·404(모델)·429(요청 몰림)는 키가 받아들여진 것
  if (status !== null && ((status >= 200 && status < 300) || status === 400 || status === 404 || status === 429)) {
    return { valid: true, message: KEY_VALID_MESSAGE };
  }
  return { valid: null, message: KEY_UNKNOWN_MESSAGE };
}

/** 검증 요청 몸 — `{ keyType, keyValue | key }` 또는 저장한 키 `{ keyType, stored: true }` */
export type VerifyRequest = { keyType: 'anthropic'; key: string | null; stored: boolean };

export function parseVerifyRequest(body: unknown): { ok: true; value: VerifyRequest } | { ok: false; message: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, message: '요청을 읽지 못했습니다.' };
  const b = body as Record<string, unknown>;
  if (b.keyType !== 'anthropic') return { ok: false, message: '지원하지 않는 키 종류입니다.' };
  if (b.stored === true) return { ok: true, value: { keyType: 'anthropic', key: null, stored: true } };
  const raw = b.keyValue ?? b.key;
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key) return { ok: false, message: '확인할 키를 넣어 주세요.' };
  if (key.length > MAX_KEY_LENGTH || /\s/.test(key)) return { ok: false, message: '키 형식이 맞지 않습니다.' };
  // 화면의 가린 키를 보내면 늘 '틀림'이 된다 — 저장한 키는 `stored: true`로
  if (key.includes('•')) return { ok: false, message: '가린 키로는 확인할 수 없습니다. 새 키를 넣거나 저장한 키를 확인하세요.' };
  return { ok: true, value: { keyType: 'anthropic', key, stored: false } };
}
