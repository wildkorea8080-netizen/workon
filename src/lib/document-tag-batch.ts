// src/lib/document-tag-batch.ts
// 여러 문서에 한 번에 AI 태그 초안(2026-11-05) — 문서 화면이 문서마다 `POST /api/documents/[id]/tag-suggest`를 부르고(서버가 문서마다
// 권한·한도·사용 기록을 본다), 사람이 초안을 고쳐 고른 것만 `PATCH /api/documents/[id]`로 저장한다. 서버 쪽은 새로 없다.
// 화면도 읽으므로 DB·설정을 가져오지 않는다.
import { MAX_DOCUMENT_TAGS } from '@/lib/document-tags';
import { mergeSuggestedTags } from '@/lib/document-tag-suggest';

/** 한 번에 초안을 만드는 문서 수 — 문서마다 AI 사용량이 기록되므로 크게 두지 않는다 */
export const MAX_BATCH_DRAFTS = 20;
/** 동시에 부르는 수 — 기관 모델 호출을 한꺼번에 몰지 않게 */
export const BATCH_DRAFT_CONCURRENCY = 2;

interface BatchCandidate {
  id: string;
  noda_status: string | null;
  retired_at?: string | null;
  tags?: string[] | null;
}

/** 초안 대상 — 목록에 보이는 순서대로, 지난 판·삭제 대기 문서는 빼고, 기본은 태그가 없는 문서만, 20개까지 */
export function batchDraftTargets<T extends BatchCandidate>(docs: T[], opts: { onlyUntagged?: boolean } = {}): T[] {
  const onlyUntagged = opts.onlyUntagged ?? true;
  return docs
    .filter((d) => d.noda_status !== 'deleting' && d.noda_status !== 'retired' && !d.retired_at)
    .filter((d) => !onlyUntagged || (d.tags?.length ?? 0) === 0)
    .slice(0, MAX_BATCH_DRAFTS);
}

export type DraftResult =
  | { kind: 'ok'; suggestions: string[] }
  /** 이 문서만 실패(권한·읽기 실패 등) — 다른 문서는 계속 */
  | { kind: 'failed'; message: string }
  /** 더 부르면 안 됨(한도 429·로그인 끊김 401) — 남은 문서는 건너뛴다 */
  | { kind: 'stop'; message: string };

/** 응답 상태 → 결과 갈래. 한도·로그인 문제는 남은 문서를 부르지 않는다(같은 거절만 쌓인다) */
export function draftResultOf(status: number, body: { ok?: boolean; data?: { suggestions?: unknown }; error?: { message?: string } } | null): DraftResult {
  if (body?.ok && Array.isArray(body.data?.suggestions)) {
    return { kind: 'ok', suggestions: (body.data!.suggestions as unknown[]).filter((s): s is string => typeof s === 'string') };
  }
  const message = body?.error?.message || '태그 초안을 만들지 못했습니다.';
  if (status === 429 || status === 401) return { kind: 'stop', message };
  return { kind: 'failed', message };
}

/**
 * 차례대로 일을 돌린다(동시에 `concurrency`개). 일 하나가 'stop'을 내면 아직 시작하지 않은 일은 부르지 않고 'skipped'로 둔다.
 * 일이 던지면 그 일만 실패로 본다. 결과는 넣은 순서와 같은 자리
 */
export async function runDraftQueue(
  ids: string[],
  work: (id: string) => Promise<DraftResult>,
  opts: { concurrency?: number; onResult?: (id: string, result: DraftResult | { kind: 'skipped' }) => void; onStart?: (id: string) => void } = {}
): Promise<(DraftResult | { kind: 'skipped' })[]> {
  const results: (DraftResult | { kind: 'skipped' })[] = ids.map(() => ({ kind: 'skipped' as const }));
  let next = 0;
  let stopped = false;
  const lane = async () => {
    while (!stopped && next < ids.length) {
      const i = next++;
      opts.onStart?.(ids[i]);
      let result: DraftResult;
      try {
        result = await work(ids[i]);
      } catch {
        result = { kind: 'failed', message: '태그 초안을 만들지 못했습니다.' };
      }
      results[i] = result;
      if (result.kind === 'stop') stopped = true;
      opts.onResult?.(ids[i], result);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? BATCH_DRAFT_CONCURRENCY, ids.length)) }, lane));
  for (let i = 0; i < ids.length; i++) if (results[i].kind === 'skipped') opts.onResult?.(ids[i], results[i]);
  return results;
}

/** 검토 칸에 넣을 글 — 지금 태그 뒤에 제안(겹친 것 빼고 문서 상한까지) */
export function draftText(current: string[] | null | undefined, suggestions: string[]): string {
  return mergeSuggestedTags(current ?? [], suggestions, MAX_DOCUMENT_TAGS).join(', ');
}
