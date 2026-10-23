// 화면용 순수 함수 — config.ts·noda.ts를 가져오지 않는다(둘 다 서버 환경 변수를 읽는다).
// NODA 파일 이름 앞부분(`{uuid}__`)을 떼는 정규식은 noda.ts의 것과 같은 모양으로 여기에도 둔다.

const NODA_PREFIX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}__/gi;

/** 모델·사용자에게 `{document_id}__` 앞부분이 보이지 않게 한다(서버가 이미 떼지만 화면도 한 번 더) */
export function stripNodaPrefixes(text: string): string {
  return text.replace(NODA_PREFIX, '');
}

export interface SourceLocationInput {
  page?: number | null;
  cellRange?: string | null;
  section?: string | null;
  chunkIndex: number;
  similarity: number;
}

function clean(value: string | null | undefined): string {
  return typeof value === 'string' ? stripNodaPrefixes(value).trim() : '';
}

/**
 * 출처 위치 줄. 쪽이 있으면 `p.12 · 제3장 › 여비`, 칸 주소면 `표.csv!A3:D20`,
 * 절만 있으면 절, 셋 다 없으면(옛 메시지) 옛 표시 `청크 N • 유사도: X%`.
 */
export function sourceLocationLabel(c: SourceLocationInput): string {
  const section = clean(c.section);
  if (typeof c.page === 'number' && Number.isFinite(c.page)) {
    return section ? `p.${c.page} · ${section}` : `p.${c.page}`;
  }
  const cellRange = clean(c.cellRange);
  if (cellRange) return cellRange;
  if (section) return section;
  return `청크 ${c.chunkIndex + 1} • 유사도: ${(c.similarity * 100).toFixed(1)}%`;
}
