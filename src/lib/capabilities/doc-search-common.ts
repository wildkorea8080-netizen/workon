// src/lib/capabilities/doc-search-common.ts
import { documentIdFromNodaFilename, type NodaContextResult, type NodaSource } from '@/lib/noda';
import type { CommonDocument } from '@/lib/db';
import { chunkFromSource, type SourceMatch } from './doc-search';

/**
 * 공통 자료실 근거 — 비서 보관함과 공통 보관함의 `/context` 결과를 한 번호 줄로 잇는 순수 함수들(S5 설계 5.2·5.3).
 *
 * 두 보관함은 각자 `[1]`부터 번호를 매긴다. 그대로 이으면 답변 속 `[n]`이 어느 쪽 근거를 가리키는지 모른다.
 * 그래서 공통 쪽을 비서 쪽 마지막 번호만큼 민다(`shiftContext`). 머리 줄(줄 첫머리의 `[n] `)만 고친다 —
 * 본문 속 `[2]`는 문서 내용이라 건드리면 안 된다.
 */

/** 근거 묶음의 머리 줄 — `doc-search.ts`의 `contextPassages`가 쓰는 꼴과 같다 */
const HEAD_LINE = /^\[(\d{1,3})\] /;

function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** 머리 줄 번호와 `sources[].n`에 `offset`을 더한 새 결과. 0이면 그대로 돌려준다(입력은 바꾸지 않는다) */
export function shiftContext(result: NodaContextResult, offset: number): NodaContextResult {
  if (offset === 0) return result;
  return {
    ...result,
    context: result.context
      .split('\n')
      .map((line) => {
        const head = HEAD_LINE.exec(line);
        return head ? `[${Number(head[1]) + offset}] ${line.slice(head[0].length)}` : line;
      })
      .join('\n'),
    sources: result.sources.map((s) => (s && typeof s === 'object' && isCount(s.n) ? { ...s, n: s.n + offset } : s)),
  };
}

/** 머리 줄 번호와 `sources[].n` 중 가장 큰 값 — 다음 보관함을 밀 만큼. 없으면 0 */
export function maxCitationNumber(result: NodaContextResult): number {
  let max = 0;
  for (const line of result.context.split('\n')) {
    const head = HEAD_LINE.exec(line);
    if (head) max = Math.max(max, Number(head[1]));
  }
  for (const s of result.sources) {
    if (s && typeof s === 'object' && isCount(s.n)) max = Math.max(max, s.n);
  }
  return max;
}

/** 공통 근거를 맞춰 볼 행에 필요한 칸 */
export type CommonSearchDoc = Pick<
  CommonDocument,
  'id' | 'title' | 'edition_year' | 'org_type' | 'noda_status' | 'retired_at' | 'replaces_id'
>;

/**
 * 근거가 될 수 있는 공통 문서 id — `ready`인 현재 판(`retired_at` 없음) 중에서
 * **`ready` 현재 판이 대신하는 옛 판(`replaces_id`의 대상)은 뺀다.**
 * 새 판이 읽힌 뒤 옛 판 내리기(`retireReplacedEdition`)가 실패하면 두 판이 모두 현재 판으로 남는다 —
 * 그 사이에도 지난 판 조각이 근거로 나오지 않게(설계 실패 기준 2). 내리기는 운영자 목록이 다시 건다
 */
export function citableCommonIds(docs: CommonSearchDoc[]): Set<string> {
  const current = docs.filter((d) => d.noda_status === 'ready' && !d.retired_at);
  const replaced = new Set(
    current.map((d) => d.replaces_id?.toLowerCase()).filter((v): v is string => typeof v === 'string' && v !== '')
  );
  return new Set(current.map((d) => d.id.toLowerCase()).filter((docId) => !replaced.has(docId)));
}

/**
 * 근거 묶음에서 `numbers`에 든 번호의 블록(머리 줄 `[n] ` + 그 아래 글)만 남긴다 — 공통 근거를 프롬프트에 실을 때 쓴다.
 * `commonSourcesToChunks`가 조용히 뺀 조각(지난 판·읽는 중·실패…)의 글이 '정부 기준 문서' 머리 아래로 모델에게 가지 않게.
 * 첫 머리 줄 앞의 글은 어느 근거의 것인지 모르므로 버린다. 번호는 바꾸지 않는다
 */
export function keepContextBlocks(context: string, numbers: ReadonlySet<number>): string {
  const out: string[] = [];
  let keep = false;
  for (const line of context.split('\n')) {
    const head = HEAD_LINE.exec(line);
    if (head) keep = numbers.has(Number(head[1]));
    if (keep) out.push(line);
  }
  return out.join('\n');
}

/**
 * 공통 보관함의 NODA 근거(`sources`)를 `common_documents` 행과 맞춘다.
 * - **현재 판**(`ready`이고 `retired_at` 없음)의 조각만 출처가 된다. 지난 판·읽는 중·실패·못 읽음은 조용히 뺀다.
 *   `ready` 새 판이 대신하는 옛 판도 뺀다(`citableCommonIds` — 옛 판 내리기가 아직 안 된 사이)
 * - 행이 없는 조각·문서 id를 읽지 못한 조각·깨진 원소는 따로 모은다(비서 쪽 `sourcesToChunks`와 같은 꼴)
 * - `chunkIndex`는 `startIndex`부터 — 비서 쪽 조각 수 뒤로 이어 붙이려는 것이다
 */
export function commonSourcesToChunks(
  sources: NodaSource[],
  docs: CommonSearchDoc[],
  passages: Map<number, string>,
  startIndex: number
): SourceMatch {
  const byId = new Map(docs.map((d) => [d.id.toLowerCase(), d]));
  const citable = citableCommonIds(docs);
  const match: SourceMatch = { chunks: [], unknown: [], unparsable: [], malformed: 0 };
  for (const source of sources) {
    if (!source || typeof source !== 'object' || typeof source.filename !== 'string') {
      match.malformed += 1;
      continue;
    }
    const docId = documentIdFromNodaFilename(source.filename);
    if (!docId) {
      match.unparsable.push(source.filename);
      continue;
    }
    const doc = byId.get(docId);
    if (!doc) {
      match.unknown.push({ documentId: docId, filename: source.filename });
      continue;
    }
    if (!citable.has(doc.id.toLowerCase())) continue;

    match.chunks.push({
      ...chunkFromSource(source, {
        documentId: doc.id,
        documentTitle: doc.title,
        chunkIndex: startIndex + match.chunks.length,
        passages,
      }),
      scope: 'common',
      editionYear: doc.edition_year,
    });
  }
  return match;
}
