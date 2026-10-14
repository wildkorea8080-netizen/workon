// src/lib/capabilities/doc-search.ts
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { retrieveRelevantChunks } from '@/lib/rag';
import type { RetrievedChunk } from '@/lib/db';
import type { Capability } from './types';

/**
 * 참고 문서 찾기 — 질문마다 먼저 찾아 프롬프트에 붙인다.
 *
 * 동작은 S1 이전의 /api/chat과 같다. NODA로 바꾸는 일은 S4가 한다.
 */
export interface DocSearchDeps {
  retrieve(agentId: string, query: string): Promise<RetrievedChunk[]>;
  hasDocuments(agentId: string): Promise<boolean>;
}

const defaultDeps: DocSearchDeps = {
  async retrieve(agentId, query) {
    return (await retrieveRelevantChunks(agentId, query)).chunks;
  },
  async hasDocuments(agentId) {
    const { count } = await supabaseAdmin
      .from('documents')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agentId);
    return (count ?? 0) > 0;
  },
};

/**
 * 세 경우를 가른다.
 *
 * 자료를 붙일 때 인용 규칙을 함께 넣는 이유: 이 실패는 특정 비서의 문제가
 * 아니라 문서를 근거로 답하는 모든 경로에서 생긴다. 실제로 단위가 없는
 * 물량 표를 읽고 "2,000톤"이라고 답했다 — 숫자는 맞았지만 '톤'은 문서에
 * 없는 값이다.
 *
 * 문서는 있는데 못 찾았을 때 알리지 않으면 모델이 일반 지식으로 그럴듯하게
 * 답한다. 공공기관에서는 근거 없는 답이 근거 있는 답처럼 보이는 것이 가장 위험하다.
 */
export function docSearchAddendum(chunks: RetrievedChunk[], hasDocuments: boolean): string | undefined {
  if (chunks.length > 0) {
    const contextText = chunks
      .map((chunk) => `[참고 자료: ${chunk.documentTitle || '문서'}]\n${chunk.text}`)
      .join('\n\n');
    return [
      '참고 자료:',
      contextText,
      '',
      '[자료 인용 규칙]',
      '- 수치·날짜·금액·비율은 자료에 적힌 그대로 옮기세요. 반올림하거나 환산하지 마세요.',
      '- 자료에 없는 단위(톤·원·명 등)를 임의로 붙이지 마세요. 단위가 없으면 없는 대로 두고,',
      '  필요하면 "자료에 단위 표기가 없습니다"라고 밝히세요.',
      '- 표의 값을 답할 때는 어느 행·열에서 가져왔는지 알 수 있게 항목명을 함께 쓰세요.',
      '- 자료에서 확인되지 않는 것은 추론해 채우지 말고 확인되지 않는다고 말하세요.',
    ].join('\n');
  }

  if (hasDocuments) {
    return [
      '[문서 검색 결과 없음]',
      '이 비서에 연결된 문서에서 이번 질문과 관련된 내용을 찾지 못했습니다.',
      '내부 자료에 근거가 없다는 사실을 먼저 밝히고 답하세요.',
      '일반적인 설명을 덧붙일 수는 있으나, 그것이 이 기관의 자료에서 나온 것처럼',
      '말해서는 안 됩니다. 구체적인 수치·자격요건·기한은 지어내지 말고',
      '어디서 확인해야 하는지 안내하세요.',
    ].join('\n');
  }

  return undefined;
}

export function createDocSearch(deps: DocSearchDeps = defaultDeps): Capability {
  return {
    id: 'doc_search',
    label: '참고 문서 찾기',
    description: '이 비서에 연결한 문서에서 근거를 찾아 출처와 함께 답합니다.',
    isAvailable: () => true,
    async prepare(ctx) {
      let chunks: RetrievedChunk[] = [];
      try {
        chunks = await deps.retrieve(ctx.agentId, ctx.message);
      } catch (error) {
        // 검색이 실패해도 대화는 이어진다. 다만 '문서는 있다'는 사실은 알려
        // 모델이 근거 없이 단정하지 않게 한다.
        console.error('[doc-search] 검색 실패', error);
      }
      const hasDocuments = chunks.length > 0 ? true : await deps.hasDocuments(ctx.agentId).catch(() => false);
      return { chunks, systemAddendum: docSearchAddendum(chunks, hasDocuments) };
    },
  };
}

export const docSearch = createDocSearch();
