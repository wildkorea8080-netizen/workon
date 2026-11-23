// src/lib/storage-error.ts
// 저장소(Supabase Storage) 내려받기 오류가 '그 파일이 없음'인지 가른다 — 아무것도 import하지 않는다.
//
// 내려받기 실패를 통째로 '파일이 없음'(404)으로 답하면 잠깐의 저장소 장애가 '다시 해도 소용없음'이 된다
// (일괄 실행의 파일 줄이 다시 해 보지도 않고 실패). 없음이 확실할 때만 없음으로 본다 — 모르면 '지금 못 받음'.
//
// 저장소는 없는 객체에 HTTP 404, 또는 HTTP 400 + 몸 `{ statusCode: '404', error: 'not_found', message: 'Object not found' }`를 준다
// (storage-js는 이를 `StorageApiError { status, statusCode }`로, 몸을 못 읽은 응답은 `originalError`로 싣는다).

export function isStorageNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { status?: unknown; statusCode?: unknown; message?: unknown; originalError?: { status?: unknown } | null };
  const codes = [e.status, e.statusCode, e.originalError?.status].map((v) => (v === undefined || v === null ? '' : String(v)));
  if (codes.includes('404') || codes.includes('NoSuchKey')) return true;
  return typeof e.message === 'string' && /object not found/i.test(e.message);
}
