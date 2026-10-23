// 화면용 순수 함수 — config.ts·noda.ts를 가져오지 않는다(둘 다 서버 환경 변수를 읽는다).
// NODA 파일 이름 앞부분(`{uuid}__`)을 떼는 정규식은 noda.ts의 것과 같은 모양으로 여기에도 둔다.

const NODA_PREFIX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}__/gi;

/** 모델·사용자에게 `{document_id}__` 앞부분이 보이지 않게 한다(서버가 이미 떼지만 화면도 한 번 더) */
export function stripNodaPrefixes(text: string): string {
  return text.replace(NODA_PREFIX, '');
}

/** 답변 속 `[n]`을 근거 창 단추로 바꿀 때 쓰는 링크 주소 앞부분 — 화면 밖으로 나가는 주소가 아니다 */
export const CITE_HREF_PREFIX = '#cite-';

const CITE_MARK = /\[(\d{1,3})\](?!\()/g;

function linkPlain(text: string, valid: ReadonlySet<number>): string {
  return text.replace(CITE_MARK, (mark, n: string) => (valid.has(Number(n)) ? `[${n}](${CITE_HREF_PREFIX}${n})` : mark));
}

/**
 * 답변 마크다운의 `[n]`(출처에 있는 번호만)을 링크로 바꿔, 눌러서 그 근거 창을 열게 한다.
 * 이미 링크인 `[1](…)`과 코드(``` 블록·`인라인`) 안은 건드리지 않는다. 저장된 답변 글은 그대로다 — 그릴 때만 바꾼다.
 */
export function linkCitations(markdown: string, valid: ReadonlySet<number>): string {
  if (valid.size === 0) return markdown;
  return markdown
    .split(/(```[\s\S]*?```)/)
    .map((block, i) =>
      i % 2 === 1
        ? block
        : block
            .split(/(`[^`\n]*`)/)
            .map((part, j) => (j % 2 === 1 ? part : linkPlain(part, valid)))
            .join('')
    )
    .join('');
}

/** `linkCitations`가 만든 링크 주소에서 번호를 읽는다. 다른 주소면 null */
export function citationNumber(href: string | undefined): number | null {
  if (!href || !href.startsWith(CITE_HREF_PREFIX)) return null;
  const n = Number(href.slice(CITE_HREF_PREFIX.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** 출처 번호 — NODA 근거 묶음의 `[n]`(답변 속 번호와 같음). 옛 메시지는 받은 순서(chunkIndex + 1) */
export function sourceNumber(c: { n?: number; chunkIndex: number }): number {
  return typeof c.n === 'number' && Number.isFinite(c.n) ? c.n : c.chunkIndex + 1;
}

export interface SourceLocationInput {
  page?: number | null;
  cellRange?: string | null;
  section?: string | null;
  chunkIndex: number;
  /** NODA 조각은 유사도가 없을 수 있다(0·없음) */
  similarity?: number | null;
}

function clean(value: string | null | undefined): string {
  return typeof value === 'string' ? stripNodaPrefixes(value).trim() : '';
}

/**
 * 출처 위치 줄. 쪽이 있으면 `p.12 · 제3장 › 여비`, 칸 주소면 `표.csv!A3:D20`,
 * 절만 있으면 절, 셋 다 없으면(옛 메시지) 옛 표시 `청크 N • 유사도: X%`.
 * 유사도가 0이거나 없으면(위치 없는 NODA 조각) `청크 N`만 — '유사도: 0.0%'는 틀린 정보처럼 보인다.
 */
export function sourceLocationLabel(c: SourceLocationInput): string {
  const section = clean(c.section);
  if (typeof c.page === 'number' && Number.isFinite(c.page)) {
    return section ? `p.${c.page} · ${section}` : `p.${c.page}`;
  }
  const cellRange = clean(c.cellRange);
  if (cellRange) return cellRange;
  if (section) return section;
  const similarity = c.similarity;
  if (typeof similarity !== 'number' || !Number.isFinite(similarity) || similarity <= 0) {
    return `청크 ${c.chunkIndex + 1}`;
  }
  return `청크 ${c.chunkIndex + 1} • 유사도: ${(similarity * 100).toFixed(1)}%`;
}
