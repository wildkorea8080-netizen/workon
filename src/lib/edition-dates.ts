// src/lib/edition-dates.ts
// 비서 문서 판(0055)의 시행일 규칙 — 아무것도 import하지 않는다(화면도 읽는다: 문서 화면의 새 판 안내).
// 서버 쪽 판 바꾸기는 document-editions.ts, 문서 찾기는 capabilities/doc-search.ts가 이 규칙을 쓴다.

/** 한국 시각 오늘 날짜(YYYY-MM-DD) — 시행일은 날짜라 KST 자정에 바뀐다 */
export function kstToday(nowMs: number = Date.now()): string {
  return new Date(nowMs + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 시행일이 없거나 오늘(KST)·그 전이면 시행 중 */
export function isInForce(effectiveFrom: string | null | undefined, today: string): boolean {
  if (typeof effectiveFrom !== 'string' || !effectiveFrom) return true;
  return effectiveFrom.slice(0, 10) <= today;
}

/**
 * 근거로 치지 않을 문서 id(소문자) — 판(0055)과 시행일로 가른다. 옛 판을 가리키는 `ready` 새 판마다:
 * - 시행 중이면 **옛 판**이 근거가 아니다(판 바꾸기가 끝나기 전에도)
 * - 시행일 전이면 **새 판**이 근거가 아니다(옛 판이 아직 시행 중인 규정) — 옛 판은 그대로 근거다
 * 옛 판 행을 지워 `replaces_id`가 NULL이 된 새 판은 홀로 선 문서라 시행일과 상관없이 근거다(시행일은 표시용)
 */
export function notCitableEditionIds(
  docs: Array<{ id: string; noda_status: string | null; replaces_id?: string | null; effective_from?: string | null }>,
  today: string
): Set<string> {
  const out = new Set<string>();
  for (const d of docs) {
    if (d.noda_status !== 'ready' || typeof d.replaces_id !== 'string' || !d.replaces_id) continue;
    out.add(isInForce(d.effective_from, today) ? d.replaces_id.toLowerCase() : d.id.toLowerCase());
  }
  return out;
}
