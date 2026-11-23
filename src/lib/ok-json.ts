// src/lib/ok-json.ts
// 화면이 목록을 읽을 때 '못 읽음'과 '빈 목록'을 가르게 하는 GET — 아무것도 import하지 않는다(화면 공용 잎 파일).
//
// 2026-11-20: 관리자 비서 화면·대화 목록이 응답이 `{ ok: false }`(503 등)이면 아무것도 하지 않아, 못 읽은 목록이
// '등록된 공식 비서가 없습니다'·'대화가 없습니다'로 보였다. 서버는 읽기 실패를 503으로 답하게 고쳐 왔는데 화면이 그 답을 버렸다.

type FetchLike = (input: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** 2xx이고 몸이 `{ ok: true, … }`일 때만 그 몸, 그 밖(4xx·5xx·몸을 못 읽음·연결 실패)은 null. 던지지 않는다 */
export async function fetchOkJson<T extends Record<string, unknown> = Record<string, unknown>>(
  url: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<(T & { ok: true }) | null> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const body = await res.json();
    if (!body || typeof body !== 'object' || (body as { ok?: unknown }).ok !== true) return null;
    return body as T & { ok: true };
  } catch {
    return null;
  }
}

/**
 * 기관 거르기 목록을 못 읽었을 때 드롭다운에 넣는 고를 수 없는 줄(2026-11-21). 예전엔 못 읽으면 '전체 기관'만 남아
 * 등록된 기관이 없는 것처럼 보였다(슈퍼관리자 사용량·로그·계정 관리)
 */
export const ORG_FILTER_UNREAD = '(기관 목록을 불러오지 못함 — 화면을 새로 고쳐 주세요)';

/** 직원 거르기 목록을 못 읽었을 때(2026-11-22) — 예전엔 감사 기록의 '직원' 고르기가 '전체'만 남아 관리 범위에 직원이 없는 것처럼 보였다 */
export const MEMBER_FILTER_UNREAD = '(직원 목록을 불러오지 못함 — 화면을 새로 고쳐 주세요)';

/** 빈 목록 자리에 보일 글 — 못 읽었으면 '없습니다'라고 하지 않는다 */
export function emptyListText(unread: boolean, emptyText: string, what: string): string {
  return unread ? `${what} 지금 불러오지 못했습니다. 화면을 새로 고쳐 주세요.` : emptyText;
}

/**
 * 조작이 실패했을 때 화면에 보일 글(2026-11-22). `throw new Error(result.error?.message)`는 서버가 안내 글 없이 실패하면
 * 빈 글의 오류가 되어 `{error && …}`가 아무것도 그리지 않았다. 응답 몸이 JSON이 아니면(SyntaxError) 영어 구문 오류 글이,
 * 연결이 끊기면(TypeError) 'Failed to fetch'가 그대로 보였다 — 그때는 정해 둔 글을 쓴다
 */
export function actionErrorText(err: unknown, fallback: string): string {
  if (err instanceof Error && err.name === 'Error' && err.message.trim()) return err.message;
  return fallback;
}

/** 조작 요청의 결과 — `ok`는 2xx이고 몸이 `{ ok: true }`일 때만, 연결이 끊기면 status 0 */
export interface JsonReply {
  ok: boolean;
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

type RequestLike = (input: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * 던지지 않는 요청(2026-11-22). 예전엔 `await res.json()`이 던지면(몸이 JSON이 아닌 500·연결 끊김) 진행 표시('삭제 중'·'저장 중')가
 * 풀리지 않고 아무것도 알리지 않았다(슈퍼관리자 계정 관리)
 */
export async function requestJson(url: string, init?: RequestInit, fetchImpl: RequestLike = fetch as unknown as RequestLike): Promise<JsonReply> {
  try {
    const res = await fetchImpl(url, init);
    const body = await res.json().catch(() => null);
    return { ok: res.ok && (body as { ok?: unknown } | null)?.ok === true, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

/** 서버 안내 글 — API마다 `error: '…'`·`error: { message }` 꼴이 달라 둘 다 읽는다. 없거나 빈 글이면 정해 둔 글 */
export function serverErrorText(body: unknown, fallback: string): string {
  const e = (body as { error?: unknown } | null)?.error;
  if (typeof e === 'string' && e.trim()) return e;
  const m = (e as { message?: unknown } | null | undefined)?.message;
  if (typeof m === 'string' && m.trim()) return m;
  return fallback;
}
