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
 * - 근거는 **이 비서의 행**과 맞춰 본다(판정 R5). 이 비서 행이 없는 조각이 하나라도 섞이면 근거 전체를 버린다.
 *   그 조각의 문서 id를 documents 전체에서 한 번 더 찾아 가른다(판정 H):
 *   - 다른 비서의 행이 있다 → **섞임**(버그·보관함 혼선). 운영 기록 critical(security)
 *   - 행이 어디에도 없다(또는 문서 id를 읽지 못함) → **고아**(지워진 문서의 NODA 사본). 이번 턴은 근거 없이,
 *     NODA 사본은 지운다(짧게만 기다리고 실패는 기록만). 운영 기록 warning
 *   - 형식이 깨진 원소 → 확인할 수 없으니 이번 턴은 근거 없이. 운영 기록 warning
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
  /** 문서 id로 행을 찾는다(어느 비서든, 한 번의 조회) — 이 비서 행이 아닌 근거가 남의 것인지 지워진 것인지 가른다 */
  findDocuments(ids: string[]): Promise<{ id: string; agent_id: string | null }[]>;
  /** 이 비서 보관함의 NODA 고아 사본을 지운다. 던질 수 있다 — 부르는 쪽이 잡는다 */
  deleteOrphan(agentId: string, filename: string): Promise<void>;
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
  async findDocuments(ids) {
    if (ids.length === 0) return [];
    const { data, error } = await supabaseAdmin.from('documents').select('id, agent_id').in('id', ids);
    if (error) throw new Error(error.message);
    return (data ?? []) as { id: string; agent_id: string | null }[];
  },
  async deleteOrphan(agentId, filename) {
    // 보관함은 이 비서의 것만 — 근거를 돌려준 바로 그 보관함이다
    await noda.deleteDocument(nodaTenant(agentId), filename);
  },
  log: logSystem,
};

/** 고아 사본 지우기를 기다리는 최대 시간 — 답이 이보다 늦어지지 않게. 넘기면 지우기는 뒤에서 이어 간다 */
export const ORPHAN_DELETE_WAIT_MS = 1_500;

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

/** 근거 원문 상한 — 메시지 기록(source_references)에 근거마다 실리므로 크기를 정해 둔다 */
export const PASSAGE_MAX_CHARS = 2_000;

/** 근거 묶음의 머리 줄: 줄 첫머리의 `[n] 파일 · 쪽 · 절` */
const PASSAGE_HEAD = /^\[(\d{1,3})\] /;

/**
 * NODA 근거 묶음(`context`)을 번호마다 원문으로 나눈다 — 오른쪽 근거 창이 보일 글이다.
 * 묶음은 `[n] 파일 · 43쪽 · 제목 > 사슬` 머리 줄 아래에 그 근거의 글이 이어지는 꼴이다(실측 2026-10-23).
 * 머리 줄은 빼고, `{문서 id}__`는 떼고, `PASSAGE_MAX_CHARS`에서 자른다(+`…`).
 */
export function contextPassages(context: string): Map<number, string> {
  const passages = new Map<number, string>();
  let current: number | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (current === null) return;
    const text = stripNodaPrefixes(lines.join('\n')).trim();
    passages.set(current, text.length > PASSAGE_MAX_CHARS ? `${text.slice(0, PASSAGE_MAX_CHARS)}…` : text);
  };
  for (const line of context.split('\n')) {
    const head = PASSAGE_HEAD.exec(line);
    if (head) {
      flush();
      current = Number(head[1]);
      lines = [];
    } else if (current !== null) {
      lines.push(line);
    }
  }
  flush();
  return passages;
}

/** 근거를 이 비서의 행과 맞춘 결과 */
export interface SourceMatch {
  /** 이 비서의 `ready`·`deleting` 행과 맞은 조각 */
  chunks: RetrievedChunk[];
  /** 문서 id는 읽었지만 이 비서의 행이 없는 근거 */
  unknown: { documentId: string; filename: string }[];
  /** 문서 id 앞부분이 없는 파일 이름 */
  unparsable: string[];
  /** 형식이 깨진 원소 수(객체가 아니거나 `filename`이 글이 아님) */
  malformed: number;
}

/** 맞지 않은 근거가 하나도 없으면 true */
export function isCleanMatch(m: SourceMatch): boolean {
  return m.unknown.length === 0 && m.unparsable.length === 0 && m.malformed === 0;
}

/**
 * NODA 근거(`sources`)를 화면 출처로. 이 비서의 행과 맞춰 본다:
 * - `ready`·`deleting` 행의 조각 → 조각
 * - 이 비서의 행이지만 다른 상태(읽는 중·실패·못 읽음·옛 문서) → 조용히 뺀다(실패한 행도 NODA 사본이 남아 있을 수 있다)
 * - 이 비서의 행이 없는 조각·문서 id를 읽지 못하는 조각·형식이 깨진 원소는 따로 모은다 —
 *   **하나라도** 있으면 근거 전체를 버린다(`matchedChunks`가 섞임·고아를 가른다)
 */
export function sourcesToChunks(
  sources: NodaSource[],
  docs: AgentDocument[],
  passages: Map<number, string> = new Map()
): SourceMatch {
  const byId = new Map(docs.map((d) => [d.id.toLowerCase(), d]));
  const match: SourceMatch = { chunks: [], unknown: [], unparsable: [], malformed: 0 };
  const chunks = match.chunks;
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
    if (!CITABLE.has(doc.noda_status)) continue;

    chunks.push(
      chunkFromSource(source, {
        documentId: doc.id,
        documentTitle: doc.title || doc.file_name,
        chunkIndex: chunks.length,
        passages,
      })
    );
  }
  return match;
}

/**
 * NODA 근거 하나 → 화면 출처 조각. 위치 칸(쪽·칸 주소·절·스캔 판독)과 근거 원문을 계산한다 —
 * 비서 문서(`sourcesToChunks`)와 공통 자료실(`commonSourcesToChunks`)이 같은 규칙으로 쓴다.
 * 어느 문서의 조각인지(제목·순번)는 부르는 쪽이 정한다.
 */
export function chunkFromSource(
  source: NodaSource,
  base: { documentId: string; documentTitle: string; chunkIndex: number; passages: Map<number, string> }
): RetrievedChunk {
  const anchors = Array.isArray(source.anchors) ? source.anchors.filter((a) => a && typeof a === 'object') : [];
  const pageAnchor = anchors.find((a) => typeof a.page === 'number' && Number.isFinite(a.page) && a.page > 0);
  const cellAnchor = anchors.find((a) => typeof a.cell_range === 'string' && a.cell_range.trim() !== '');
  const extractors = Array.isArray(source.extractors) ? source.extractors : [];
  return {
    documentId: base.documentId,
    documentTitle: base.documentTitle,
    chunkIndex: base.chunkIndex,
    ...(typeof source.n === 'number' && Number.isFinite(source.n) ? { n: source.n } : {}),
    text: (typeof source.n === 'number' && base.passages.get(source.n)) || '',
    similarity: typeof source.similarity === 'number' && Number.isFinite(source.similarity) ? source.similarity : 0,
    page: pageAnchor ? (pageAnchor.page as number) : null,
    cellRange: cellAnchor ? stripNodaPrefixes(cellAnchor.cell_range as string) : null,
    section: sectionOf(source.outline) ?? sectionOf(source.path),
    ocr: extractors.some((e) => typeof e === 'string' && /ocr/i.test(e)),
  };
}

/**
 * 답변 속 `[n]` — 화면이 이 번호를 눌러 오른쪽 근거 창을 연다(2026-10-23). 근거 묶음 머리의 번호를 그대로 쓰게 한다.
 * NODA 답변 검증(S4-b)의 인용 검사도 이 번호를 쓴다
 */
export const CITE_NUMBER_RULE =
  '- 참고 자료의 내용을 쓴 문장 끝에는 그 자료 머리의 번호를 [1]처럼 붙이세요. 여러 자료면 [1][3]처럼 이어 붙이고, 참고 자료에 없는 번호는 만들지 마세요.';

const CITATION_RULES = [
  '[자료 인용 규칙]',
  '- 수치·날짜·금액·비율은 자료에 적힌 그대로 옮기세요. 반올림하거나 환산하지 마세요.',
  '- 자료에 없는 단위(톤·원·명 등)를 임의로 붙이지 마세요. 단위가 없으면 없는 대로 두고,',
  '  필요하면 "자료에 단위 표기가 없습니다"라고 밝히세요.',
  '- 표의 값을 답할 때는 어느 행·열에서 가져왔는지 알 수 있게 항목명을 함께 쓰세요.',
  '- 자료에서 확인되지 않는 것은 추론해 채우지 말고 확인되지 않는다고 말하세요.',
  // 하한(0.80)을 넘은 근거도 질문의 답이 아닐 수 있다 — '관련 문서 없음'의 둘째 겹(설계 5절)
  '- 참고 자료에 질문의 답이 없으면 지어내지 말고 "문서에서 찾지 못했습니다"라고 답하세요.',
  CITE_NUMBER_RULE,
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

type MatchInput = { agentId: string; organizationId: string | null };

/**
 * 근거를 이 비서의 행과 맞춘다. 맞지 않은 조각이 하나라도 있으면 빈 근거로(판정 R5·H):
 * - 다른 비서의 행이 있는 조각 → 섞임. critical(security). NODA 사본은 건드리지 않는다(조사할 수 있게)
 * - 어디에도 행이 없는 조각·문서 id를 읽지 못한 조각 → 고아. NODA 사본을 지우고(짧게만 기다림) warning
 * - 형식이 깨진 원소 → 확인할 수 없음. warning
 * 운영 기록에는 파일 이름을 남기지 않는다(문서 id·개수만).
 */
async function matchedChunks(
  deps: DocSearchDeps,
  input: MatchInput,
  result: NodaContextResult,
  docs: AgentDocument[]
): Promise<RetrievedChunk[]> {
  const log = deps.log ?? logSystem;
  const match = sourcesToChunks(result.sources, docs, contextPassages(result.context));
  if (isCleanMatch(match)) return match.chunks;

  const base = { agent_id: input.agentId, source_count: result.sources.length };

  let owners: { id: string; agent_id: string | null }[] = [];
  if (match.unknown.length > 0) {
    try {
      owners = await deps.findDocuments(Array.from(new Set(match.unknown.map((u) => u.documentId))));
    } catch (error) {
      // 남의 것인지 지워진 것인지 모른다 — 근거 없이 답하고 사본은 건드리지 않는다
      await log({
        level: 'error',
        category: 'database',
        message: '문서 찾기 근거의 문서를 확인하지 못해 근거를 버림',
        details: { ...base, error: error instanceof Error ? error.message : String(error) },
        orgId: input.organizationId,
      });
      return [];
    }
  }

  const foreign = owners.filter((o) => o.agent_id !== input.agentId);
  if (foreign.length > 0) {
    await log({
      level: 'critical',
      category: 'security',
      message: '문서 찾기 근거에 이 비서의 문서가 아닌 조각이 섞여 근거를 버림',
      details: { ...base, foreign_count: foreign.length },
      orgId: input.organizationId,
    });
    return [];
  }

  const found = new Set(owners.map((o) => o.id.toLowerCase()));
  const orphanIds = match.unknown.filter((u) => !found.has(u.documentId));
  const orphanNames = Array.from(new Set([...orphanIds.map((u) => u.filename), ...match.unparsable]));
  if (orphanNames.length > 0) {
    await log({
      level: 'warning',
      category: 'api',
      message: '문서 찾기 근거에 지워진 문서의 NODA 사본이 있어 근거를 버리고 사본을 지움',
      details: {
        ...base,
        orphan_count: orphanNames.length,
        orphan_document_ids: Array.from(new Set(orphanIds.map((u) => u.documentId))),
      },
      orgId: input.organizationId,
    });
    await deleteOrphans(deps, input, orphanNames);
  }
  if (match.malformed > 0) {
    await log({
      level: 'warning',
      category: 'api',
      message: '문서 찾기 근거에 형식이 깨진 조각이 있어 근거를 버림',
      details: { ...base, malformed_count: match.malformed },
      orgId: input.organizationId,
    });
  }
  return [];
}

/** 고아 사본을 지운다. 실패는 기록만 하고, 답이 늦어지지 않게 `ORPHAN_DELETE_WAIT_MS`까지만 기다린다 */
async function deleteOrphans(deps: DocSearchDeps, input: MatchInput, filenames: string[]): Promise<void> {
  const log = deps.log ?? logSystem;
  const all = Promise.all(
    filenames.map((filename) =>
      Promise.resolve()
        .then(() => deps.deleteOrphan(input.agentId, filename))
        .catch((error: unknown) =>
          log({
            level: 'warning',
            category: 'api',
            message: '문서 찾기 근거의 NODA 고아 사본을 지우지 못함',
            details: {
              agent_id: input.agentId,
              code: error instanceof NodaError ? error.code : 'unknown',
              status: error instanceof NodaError ? error.status : null,
            },
            orgId: input.organizationId,
          }).catch(() => {})
        )
    )
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ORPHAN_DELETE_WAIT_MS);
  });
  try {
    await Promise.race([all, wait]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * NODA 답변 검증(`/verify`)에 보낼 근거 — `/context` `sources[]`를 받은 순서 그대로 `{doc_id, chunk_id}`만.
 * 답의 `[n]`이 `sources[n-1]`을 가리키므로 깨진 원소 하나만 빼도 번호가 어긋난다 — 하나라도 깨졌으면 빈 배열(검증하지 않음)
 */
export function verifySourcesOf(sources: NodaSource[]): { doc_id: string; chunk_id: string }[] {
  const out: { doc_id: string; chunk_id: string }[] = [];
  for (const s of sources) {
    if (!s || typeof s !== 'object' || typeof s.doc_id !== 'string' || !s.doc_id || typeof s.chunk_id !== 'string' || !s.chunk_id) {
      return [];
    }
    out.push({ doc_id: s.doc_id, chunk_id: s.chunk_id });
  }
  return out;
}

/** 관리자 검색 시험(rag-test)용 — 대화와 같은 규칙으로 찾는다. NODA 실패는 던진다 */
export async function searchAgentDocuments(
  input: { agentId: string; query: string; organizationId: string | null },
  deps: DocSearchDeps = defaultDeps
): Promise<{ chunks: RetrievedChunk[]; dropped: number }> {
  const { agentId, query, organizationId } = input;
  const docs = await deps.documentsOf(agentId);
  if (!hasReady(docs)) return { chunks: [], dropped: 0 };
  const result = await deps.fetchContext(agentId, query);
  const chunks = await matchedChunks(deps, { agentId, organizationId }, result, docs);
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
        verifySources: chunks.length > 0 ? verifySourcesOf(carry.result.sources) : [],
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
