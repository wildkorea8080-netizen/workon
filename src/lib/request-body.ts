// src/lib/request-body.ts
// API 라우트가 요청 몸을 읽는 한 곳 — 아무것도 import하지 않는다(잎 파일).
//
// 2026-11-23: 라우트 열셋이 `await request.json()`을 그대로 불러, 몸이 JSON이 아니거나(빈 몸·잘린 몸) `null`·배열이면
// 던지거나 `body.email`에서 TypeError가 나 바깥 catch의 500 '서버 오류'로 답했다(시스템 API 키 저장은 try도 없어 빈 500).
// 깨진 요청은 요청한 쪽의 잘못이라 400이어야 한다 — 500이면 운영 감시가 서버 장애로 센다.

export const BAD_BODY_MESSAGE = '요청 형식이 올바르지 않습니다.';

/**
 * 요청 몸이 JSON 객체일 때만 그 객체, 그 밖(JSON 아님·빈 몸·null·배열·글·숫자)은 null. 던지지 않는다.
 * 칸 값의 꼴은 `request.json()`처럼 any — 칸마다 꼴 검사는 부르는 쪽이 한다(바꾸기 전과 같게)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readJsonObject(request: Request): Promise<Record<string, any> | null> {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return body as Record<string, any>;
  } catch {
    return null;
  }
}
