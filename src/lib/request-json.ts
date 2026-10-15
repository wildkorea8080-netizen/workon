/**
 * 화면에서 API를 부를 때 쓰는 fetch. 네트워크가 끊기거나 게이트웨이가 HTML을
 * 돌려줘도(예: 504) 던지지 않고 `{ ok: false, error }`로 바꾼다.
 * 던지게 두면 await 뒤의 코드가 멈춰 사용자는 아무 반응도 못 본다.
 */

export const NETWORK_ERROR_MESSAGE = '서버와 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface JsonResult {
  status: number;
  /** 서버 응답 규약 `{ ok, data }` / `{ ok: false, error: { message, details? } }` */
  r: any;
}

export async function requestJson(url: string, init?: RequestInit): Promise<JsonResult> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    return { status: 0, r: { ok: false, error: { message: NETWORK_ERROR_MESSAGE } } };
  }
  try {
    return { status: res.status, r: await res.json() };
  } catch {
    return { status: res.status, r: { ok: false, error: { message: NETWORK_ERROR_MESSAGE } } };
  }
}
