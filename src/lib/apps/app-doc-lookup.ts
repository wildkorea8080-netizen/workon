// src/lib/apps/app-doc-lookup.ts
// 입력형 앱의 '문서 찾기' 조회 단계(2026-11-09) — 조회어로 **대화와 같은 찾기**(`searchLikeChat` — 이 앱 비서의 문서 + 기관 유형의 공통 자료실,
// 판·시행일 규칙·유사도 하한 0.80까지 같다)를 한 번 하고, 근거 글을 다음 단계의 자료로 넘긴다. 모델을 부르지 않는다(사용량 없음).
//
// - 근거를 찾으면 `[n] 문서 이름 · 위치` 머리 줄 + 근거 글(조각마다 대화 근거 창과 같은 2,000자까지 — 전체는 단계 결과 상한 6,000자).
//   출처는 문서마다 하나, 문서 원본 주소(`/api/documents/{id}/original` — 열 때 권한을 서버가 다시 본다).
// - 근거가 없으면 **멈추지 않고** '근거 없음' 안내와 `gap`으로 넘긴다 — 다음 단계가 결과에 '정보 공백(확인 필요)'으로 밝힌다(조사 앱의 공백 확인).
// - 문서를 지금 불러오지 못하면(NODA 장애) 실패 — 근거 없는 답을 근거 있는 답처럼 내지 않는다(대화의 503과 같은 판단).
import type { RetrievedChunk } from '@/lib/db';
import { searchLikeChat } from '@/lib/capabilities/doc-search';
import { sourceLocationLabel, sourceOriginalHref, sourceTitleLabel } from '@/components/chat/source-label';
import { APP_LOOKUP_SOURCES_MAX, type AppDocSearchRunner, type AppStepSource } from './pipeline';

export const APP_DOC_LOOKUP_GAP = '이 조회어로 문서함(이 비서의 문서·기관 유형의 공통 기준)에서 근거를 찾지 못했습니다 — 정보 공백입니다.';
export const APP_DOC_LOOKUP_UNAVAILABLE = '참고 문서를 지금 불러오지 못했습니다 — 잠시 뒤 다시 실행해 주세요.';

/** 근거 조각 → 다음 단계에 넘길 글과 출처(문서마다 하나, 처음 나온 쪽으로) */
export function docLookupResult(chunks: RetrievedChunk[]): { content: string; sources: AppStepSource[]; gap?: boolean } {
  if (!chunks.length) return { content: APP_DOC_LOOKUP_GAP, sources: [], gap: true };
  const blocks: string[] = [];
  const sources: AppStepSource[] = [];
  const seen = new Set<string>();
  chunks.forEach((c, i) => {
    const n = typeof c.n === 'number' ? c.n : i + 1;
    const title = sourceTitleLabel(c);
    blocks.push(`[${n}] ${title} · ${sourceLocationLabel({ ...c, similarity: null })}\n${(c.text ?? '').trim() || '(근거 글 없음)'}`);
    const key = `${c.scope ?? 'agent'}:${c.documentId}`;
    const url = sourceOriginalHref(c);
    if (!seen.has(key) && url && sources.length < APP_LOOKUP_SOURCES_MAX) { seen.add(key); sources.push({ title, url }); }
  });
  return { content: blocks.join('\n\n'), sources };
}

/** 이번 턴의 비서·기관으로 찾는 실행기 — 비서·기관은 서버가 채운 턴 정보에서만(조회어 말고는 입력을 받지 않는다) */
export function appDocSearchRunner(
  ctx: { agentId: string; organizationId: string },
  search: (input: { agentId: string; organizationId: string; query: string }) => Promise<RetrievedChunk[] | null> = searchLikeChat,
): AppDocSearchRunner {
  return async (query) => {
    try {
      const chunks = await search({ agentId: ctx.agentId, organizationId: ctx.organizationId, query });
      if (!chunks) return { content: APP_DOC_LOOKUP_UNAVAILABLE, sources: [], isError: true };
      return docLookupResult(chunks);
    } catch {
      return { content: APP_DOC_LOOKUP_UNAVAILABLE, sources: [], isError: true };
    }
  };
}
