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
 * 판을 고를 날 — 업무 '규정 확인'처럼 적용 기준일이 있는 길에서 쓴다(2026-11-05).
 * 기준일이 **오늘(KST) 뒤**면 그날 시행될 판을 고른다(시행일을 예약한 새 판이 근거, 옛 판은 아님).
 * 기준일이 오늘이거나 그 전이면 오늘을 쓴다 — 시행일이 지나 내린 옛 판은 NODA 사본을 지워 다시 찾을 수 없다.
 * 그런 근거(기준일 뒤에 시행된 새 판)는 적용 판정이 '기준일 뒤'로 따로 알린다. 날짜를 읽지 못하면 오늘
 */
export function editionDayFor(basisDate: string | null | undefined, today: string = kstToday()): string {
  if (typeof basisDate !== 'string') return today;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(basisDate.trim());
  if (!m) return today;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1948 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return today;
  const day = basisDate.trim();
  return day > today ? day : today;
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
