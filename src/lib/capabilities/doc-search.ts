// src/lib/capabilities/doc-search.ts
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSystem } from '@/lib/logger';
import {
  noda,
  nodaTenant,
  stripNodaPrefixes,
  documentIdFromNodaFilename,
  NodaError,
  type NodaContextResult,
  type NodaSource,
} from '@/lib/noda';
import type { NodaStatus, RetrievedChunk } from '@/lib/db';
import type { Capability, PreflightResult } from './types';

/**
 * 참고 문서 찾기 — 질문마다 NODA `/context`로 근거를 먼저 찾아 프롬프트에 붙인다(S4-a, 설계 5절).
 *
 * - 하한(`min_similarity` 0.80)은 `noda.ts`가 보낸다. 다 빠지면 `sources`가 빈 채로 와 '근거 없음' 자리로 간다
 * - **NODA를 부르지 못하면 답하지 않는다**(preflight에서 거절 — 대화를 만들기 전). 근거 없는 답이
 *   근거 있는 답처럼 보이는 것이 공공기관에서 가장 위험하다. 직원은 '문서 없이 일반 답변 받기'로 다시 보낼 수 있다
 * - `ready` 문서가 없는 비서는 NODA를 부르지 않는다(판정 R6) — NODA 장애 중에도 평소처럼 답한다
 * - 근거는 **이 비서의 행**과 맞춰 본다(판정 R5). 이 비서 행이 없는 조각이 하나라도 섞이면 근거 전체를 버린다
 */

export const DOCUMENTS_UNAVAILABLE_MESSAGE = '참고 문서를 지금 불러오지 못했습니다 — 잠시 뒤 다시 물어 주세요';
export const DOCUMENTS_UNAVAILABLE_CODE = 'documents_unavailable';

/** 이 비서의 문서 행 — 상태와 상관없이 전부(옛 문서의 `NULL` 포함) */
export interface AgentDocument {
  id: string;
  title: string | null;
  file_name: string;
  noda_status: NodaStatus | null;
}

export interface DocSearchDeps {
  documentsOf(agentId: string): Promise<AgentDocument[]>;
  fetchContext(agentId: string, query: string): Promise<NodaContextResult>;
  /** 운영 기록(system_logs). 기본은 logSystem */
  log?: typeof logSystem;
}

const defaultDeps: DocSearchDeps = {
  async documentsOf(agentId) {
    const { data, error } = await supabaseAdmin
      .from('documents')
      .select('id, title, file_name, noda_status')
      .eq('agent_id', agentId);
    if (error) throw new Error(error.message);
    return (data ?? []) as AgentDocument[];
  },
  async fetchContext(agentId, query) {
    // 보관함 이름은 서버가 비서 id로만 만든다
    return noda.getContext({ tenant: nodaTenant(agentId), query });
  },
  log: logSystem,
};

/** NODA 근거가 조각이 되는 행 상태 — `deleting`은 지우는 중이라 아직 이 비서의 문서다 */
const CITABLE: ReadonlySet<NodaStatus | null> = new Set<NodaStatus | null>(['ready', 'deleting']);

function hasReady(docs: AgentDocument[]): boolean {
  return docs.some((d) => d.noda_status === 'ready');
}

function sectionOf(outline: NodaSource['outline']): string | null {
  if (Array.isArray(outline)) {
    const parts = outline.filter((p): p is string => typeof p === 'string' && p.trim() !== '');
    return parts.length ? stripNodaPrefixes(parts.join(' › ')) : null;
  }
  return typeof outline === 'string' && outline.trim() ? stripNodaPrefixes(outline) : null;
}

/**
 * NODA 근거(`sources`)를 화면 출처로. 이 비서의 행과 맞춰 본다:
 * - `ready`·`deleting` 행의 조각 → 조각
 * - 이 비서의 행이지만 다른 상태(읽는 중·실패·못 읽음·옛 문서) → 조용히 뺀다(실패한 행도 NODA 사본이 남아 있을 수 있다)
 * - 이 비서의 행이 없거나 문서 id를 읽지 못하는 조각이 **하나라도** 있으면 null — 근거 전체를 버린다(버그·보관함 혼선)
 * - 형식이 깨진 원소(객체가 아니거나 `filename`이 글이 아님)는 건너뛴다
 */
export function sourcesToChunks(sources: NodaSource[], docs: AgentDocument[]): RetrievedChunk[] | null {
  const byId = new Map(docs.map((d) => [d.id.toLowerCase(), d]));
  const chunks: RetrievedChunk[] = [];
  for (const source of sources) {
    if (!source || typeof source !== 'object' || typeof source.filename !== 'string') continue;
    const docId = documentIdFromNodaFilename(source.filename);
    const doc = docId ? byId.get(docId) : undefined;
    if (!doc) return null;
    if (!CITABLE.has(doc.noda_status)) continue;

    const anchors = Array.isArray(source.anchors) ? source.anchors.filter((a) => a && typeof a === 'object') : [];
    const pageAnchor = anchors.find((a) => typeof a.page === 'number' && Number.isFinite(a.page) && a.page > 0);
    const cellAnchor = anchors.find((a) => typeof a.cell_range === 'string' && a.cell_range.trim() !== '');
    const extractors = Array.isArray(source.extractors) ? source.extractors : [];
    chunks.push({
      documentId: doc.id,
      documentTitle: doc.title || doc.file_name,
      chunkIndex: chunks.length,
      text: '',
      similarity: typeof source.similarity === 'number' && Number.isFinite(source.similarity) ? source.similarity : 0,
      page: pageAnchor ? (pageAnchor.page as number) : null,
      cellRange: cellAnchor ? stripNodaPrefixes(cellAnchor.cell_range as string) : null,
      section: sectionOf(source.outline),
      ocr: extractors.some((e) => typeof e === 'string' && /ocr/i.test(e)),
    });
  }
  return chunks;
}

const CITATION_RULES = [
  '[자료 인용 규칙]',
  '- 수치·날짜·금액·비율은 자료에 적힌 그대로 옮기세요. 반올림하거나 환산하지 마세요.',
  '- 자료에 없는 단위(톤·원·명 등)를 임의로 붙이지 마세요. 단위가 없으면 없는 대로 두고,',
  '  필요하면 "자료에 단위 표기가 없습니다"라고 밝히세요.',
  '- 표의 값을 답할 때는 어느 행·열에서 가져왔는지 알 수 있게 항목명을 함께 쓰세요.',
  '- 자료에서 확인되지 않는 것은 추론해 채우지 말고 확인되지 않는다고 말하세요.',
  // 하한(0.80)을 넘은 근거도 질문의 답이 아닐 수 있다 — '관련 문서 없음'의 둘째 겹(설계 5절)
  '- 참고 자료에 질문의 답이 없으면 지어내지 말고 "문서에서 찾지 못했습니다"라고 답하세요.',
];

const NO_RESULT = [
  '[문서 검색 결과 없음]',
  '이 비서에 연결된 문서에서 이번 질문과 관련된 내용을 찾지 못했습니다.',
  '내부 자료에 근거가 없다는 사실을 먼저 밝히고 답하세요.',
  '일반적인 설명을 덧붙일 수는 있으나, 그것이 이 기관의 자료에서 나온 것처럼',
  '말해서는 안 됩니다. 구체적인 수치·자격요건·기한은 지어내지 말고',
  '어디서 확인해야 하는지 안내하세요.',
];

const SKIPPED = [
  '[참고 문서 없이 답함]',
  '직원이 참고 문서를 찾지 않고 일반 답변을 요청했습니다. 답의 첫머리에 이 답이 기관 자료에 근거하지 않는다고 밝히세요.',
  '구체적인 수치·자격요건·기한은 지어내지 말고 어디서 확인해야 하는지 안내하세요.',
];

/**
 * 네 경우를 가른다.
 *
 * 자료를 붙일 때 인용 규칙을 함께 넣는 이유: 이 실패는 특정 비서의 문제가
 * 아니라 문서를 근거로 답하는 모든 경로에서 생긴다. 실제로 단위가 없는
 * 물량 표를 읽고 "2,000톤"이라고 답했다 — 숫자는 맞았지만 '톤'은 문서에
 * 없는 값이다.
 *
 * 문서는 있는데 못 찾았을 때 알리지 않으면 모델이 일반 지식으로 그럴듯하게
 * 답한다. 공공기관에서는 근거 없는 답이 근거 있는 답처럼 보이는 것이 가장 위험하다.
 *
 * `context`는 이미 `{문서 id}__`를 뗀 근거 묶음이어야 한다.
 */
export function docSearchAddendum(input: {
  context: string | null;
  chunks: RetrievedChunk[];
  hasDocuments: boolean;
  skipped: boolean;
}): string | undefined {
  if (input.skipped) return SKIPPED.join('\n');
  const context = input.context?.trim() ?? '';
  if (input.chunks.length > 0 && context) {
    return ['참고 자료:', context, '', ...CITATION_RULES].join('\n');
  }
  if (input.hasDocuments) return NO_RESULT.join('\n');
  return undefined;
}

type DocSearchCarry =
  | { skipped: true }
  | { skipped?: false; docs: AgentDocument[]; result?: NodaContextResult };

/** 근거를 이 비서의 행과 맞춘다. 섞였으면 운영 기록 critical을 남기고 빈 근거로 */
async function matchedChunks(
  deps: DocSearchDeps,
  input: { agentId: string; organizationId: string | null },
  result: NodaContextResult,
  docs: AgentDocument[]
): Promise<RetrievedChunk[]> {
  const chunks = sourcesToChunks(result.sources, docs);
  if (chunks) return chunks;
  await (deps.log ?? logSystem)({
    level: 'critical',
    category: 'security',
    message: '문서 찾기 근거에 이 비서의 문서가 아닌 조각이 섞여 근거를 버림',
    details: { agent_id: input.agentId, source_count: result.sources.length },
    orgId: input.organizationId,
  });
  return [];
}

/** 관리자 검색 시험(rag-test)용 — 대화와 같은 규칙으로 찾는다. NODA 실패는 던진다 */
export async function searchAgentDocuments(
  agentId: string,
  query: string,
  deps: DocSearchDeps = defaultDeps
): Promise<{ chunks: RetrievedChunk[]; dropped: number }> {
  const docs = await deps.documentsOf(agentId);
  if (!hasReady(docs)) return { chunks: [], dropped: 0 };
  const result = await deps.fetchContext(agentId, query);
  const chunks = await matchedChunks(deps, { agentId, organizationId: null }, result, docs);
  return { chunks, dropped: result.dropped };
}

export function createDocSearch(deps: DocSearchDeps = defaultDeps): Capability {
  const log = deps.log ?? logSystem;
  const unavailable: PreflightResult = {
    ok: false,
    status: 503,
    message: DOCUMENTS_UNAVAILABLE_MESSAGE,
    code: DOCUMENTS_UNAVAILABLE_CODE,
  };

  return {
    id: 'doc_search',
    label: '참고 문서 찾기',
    description: '이 비서에 연결한 문서에서 근거를 찾아 출처와 함께 답합니다.',
    isAvailable: () => true,

    async preflight({ organizationId, agentId, message, skipDocuments }) {
      if (skipDocuments) return { ok: true, carry: { skipped: true } satisfies DocSearchCarry };

      let docs: AgentDocument[];
      try {
        docs = await deps.documentsOf(agentId);
      } catch (error) {
        // 행을 모르면 근거를 맞춰 볼 수 없다 — 근거 없이 답하지 않고 닫는다
        await log({
          level: 'error',
          category: 'database',
          message: '참고 문서 목록을 읽지 못해 대화를 거절함',
          details: { agent_id: agentId, error: error instanceof Error ? error.message : String(error) },
          orgId: organizationId,
        });
        return unavailable;
      }
      if (!hasReady(docs)) return { ok: true, carry: { docs: [] } satisfies DocSearchCarry };

      try {
        const result = await deps.fetchContext(agentId, message);
        return { ok: true, carry: { docs, result } satisfies DocSearchCarry };
      } catch (error) {
        // 질문 원문은 남기지 않는다. NodaError 글에는 키가 실리지 않는다(noda.ts)
        await log({
          level: 'warning',
          category: 'api',
          message: '참고 문서(NODA)를 불러오지 못해 대화를 거절함',
          details: {
            agent_id: agentId,
            code: error instanceof NodaError ? error.code : 'unknown',
            status: error instanceof NodaError ? error.status : null,
          },
          orgId: organizationId,
        });
        return unavailable;
      }
    },

    async prepare(ctx) {
      const carry = ctx.preflight.doc_search as DocSearchCarry | undefined;
      if (!carry) {
        // 실행기는 prepare 전에 preflight를 부른다. 빠진 호출 경로가 생기면 찾을 수 있게 남긴다
        console.warn('[doc-search] preflight 없이 prepare가 불림 — 문서 찾기를 건너뜀');
        return {};
      }
      if (carry.skipped) {
        return { chunks: [], documentsSkipped: true, systemAddendum: docSearchAddendum({ context: null, chunks: [], hasDocuments: false, skipped: true }) };
      }
      if (!carry.result) return {};

      const chunks = await matchedChunks(deps, ctx, carry.result, carry.docs);
      return {
        chunks,
        dropped: carry.result.dropped,
        systemAddendum: docSearchAddendum({
          context: stripNodaPrefixes(carry.result.context),
          chunks,
          hasDocuments: true,
          skipped: false,
        }),
      };
    },
  };
}

export const docSearch = createDocSearch();
