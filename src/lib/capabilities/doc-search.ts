// src/lib/capabilities/doc-search.ts
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSystem } from '@/lib/logger';
import {
  noda,
  nodaTenant,
  stripNodaPrefixes,
  documentIdFromNodaFilename,
  NodaError,
  NODA_CONTEXT_BUDGET,
  CONTEXT_BUDGET_AGENT_SHARED,
  CONTEXT_BUDGET_COMMON_SHARED,
  type NodaContextResult,
  type NodaSource,
} from '@/lib/noda';
import type { NodaStatus, RetrievedChunk } from '@/lib/db';
import { commonTenant, isOrgType, ORG_TYPE_KEYS, type OrgType } from '@/lib/org-types';
import type { Capability, PreflightResult } from './types';
import {
  commonSourcesToChunks,
  citableCommonIds,
  keepContextBlocks,
  maxCitationNumber,
  shiftContext,
  type CommonSearchDoc,
} from './doc-search-common';

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
 * - **공통 자료실(S5, 설계 5절)** — 기관 유형(`organizations.type`)을 그 턴에 읽어, 그 유형의 공통 보관함도 함께 찾는다.
 *   두 보관함을 동시에 부르고(예산 3000 + 2000), 공통 번호를 비서 번호 뒤로 민다. 공통 근거는 그 유형의 행과 따로 맞춘다:
 *   다른 유형의 행이면 섞임(그 턴 근거 전체를 버림), 행이 없으면 고아(공통 근거만 버리고 사본을 지움)
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
  /** `budget`을 주지 않으면 `NODA_CONTEXT_BUDGET` */
  fetchContext(agentId: string, query: string, budget?: number): Promise<NodaContextResult>;
  /** 문서 id로 행을 찾는다(어느 비서든, 한 번의 조회) — 이 비서 행이 아닌 근거가 남의 것인지 지워진 것인지 가른다 */
  findDocuments(ids: string[]): Promise<{ id: string; agent_id: string | null }[]>;
  /** 이 비서 보관함의 NODA 고아 사본을 지운다. 던질 수 있다 — 부르는 쪽이 잡는다 */
  deleteOrphan(agentId: string, filename: string): Promise<void>;
  /** 기관 유형(`organizations.type`) — 그 턴에 읽는다(유형을 바꾸면 다음 질문부터 새 유형). 실패는 던진다 */
  orgTypeOf(organizationId: string): Promise<string | null>;
  /** 그 유형의 공통 문서 행 전부(지난 판 포함). 실패는 던진다 */
  commonDocumentsOf(orgType: OrgType): Promise<CommonSearchDoc[]>;
  /** 그 유형의 공통 보관함 `/context` — 보관함 이름은 서버가 유형으로만 만든다 */
  fetchCommonContext(orgType: OrgType, query: string, budget: number): Promise<NodaContextResult>;
  /** 공통 문서 id로 행을 찾는다(어느 유형이든, 한 번의 조회) — 다른 유형의 것인지 지워진 것인지 가른다 */
  findCommonDocuments(ids: string[]): Promise<{ id: string; org_type: string }[]>;
  /** 그 유형 공통 보관함의 NODA 고아 사본을 지운다. 던질 수 있다 — 부르는 쪽이 잡는다 */
  deleteCommonOrphan(orgType: OrgType, filename: string): Promise<void>;
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
  async fetchContext(agentId, query, budget) {
    // 보관함 이름은 서버가 비서 id로만 만든다
    return noda.getContext({ tenant: nodaTenant(agentId), query, budget });
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
  async orgTypeOf(organizationId) {
    const { data, error } = await supabaseAdmin.from('organizations').select('type').eq('id', organizationId).maybeSingle();
    if (error) throw new Error(error.message);
    const type = (data as { type: unknown } | null)?.type;
    return typeof type === 'string' ? type : null;
  },
  async commonDocumentsOf(orgType) {
    const { data, error } = await supabaseAdmin
      .from('common_documents')
      .select('id, title, edition_year, org_type, noda_status, retired_at, replaces_id')
      .eq('org_type', orgType);
    if (error) throw new Error(error.message);
    return (data ?? []) as CommonSearchDoc[];
  },
  async fetchCommonContext(orgType, query, budget) {
    return noda.getContext({ tenant: commonTenant(orgType), query, budget });
  },
  async findCommonDocuments(ids) {
    if (ids.length === 0) return [];
    const { data, error } = await supabaseAdmin.from('common_documents').select('id, org_type').in('id', ids);
    if (error) throw new Error(error.message);
    return (data ?? []) as { id: string; org_type: string }[];
  },
  async deleteCommonOrphan(orgType, filename) {
    // 보관함은 이 유형의 것만 — 근거를 돌려준 바로 그 보관함이다
    await noda.deleteDocument(commonTenant(orgType), filename);
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

/** 공통 문서는 근거가 될 수 있는 **현재 판**(`ready`, `retired_at` 없음, `ready` 새 판이 대신하지 않음)이 있어야 찾는다 */
function hasCurrentCommon(docs: CommonSearchDoc[]): boolean {
  return citableCommonIds(docs).size > 0;
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

/** 공통 기준 자료가 근거에 있을 때만 인용 규칙 끝에 더한다(설계 5.4 — 글자 그대로) */
const COMMON_CITATION_RULES = [
  '- 공통 기준 자료는 정부가 정한 기준 문서입니다. 인용할 때는 문서 이름과 기준 연도를 함께 밝히세요(예: 예산편성기준(2026)).',
  '- 이 기관 문서와 공통 기준이 서로 다르게 말하면 한쪽을 고르지 말고 둘 다 보여 주고, 어느 것을 따를지는 기관 규정과 담당자가 판단한다고 안내하세요.',
];

const AGENT_CONTEXT_HEAD = '참고 자료(이 기관 문서):';
const commonContextHead = (orgType: string) => `참고 자료(공통 기준 — ${orgType} 공통, 정부 기준 문서):`;

const NO_RESULT_AGENT_LINE = '이 비서에 연결된 문서에서 이번 질문과 관련된 내용을 찾지 못했습니다.';
/** 공통 보관함도 찾은 턴의 '근거 없음' 둘째 줄(설계 5.4) */
const NO_RESULT_COMMON_LINE = '이 비서의 문서와 공통 기준 자료에서 이번 질문과 관련된 내용을 찾지 못했습니다.';

const NO_RESULT = [
  '[문서 검색 결과 없음]',
  NO_RESULT_AGENT_LINE,
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
 * `context`·`commonContext`는 이미 `{문서 id}__`를 뗀 근거 묶음이어야 한다(공통 쪽은 번호를 민 뒤).
 * 두 묶음은 다른 머리 아래 두고, 조각이 있는 쪽만 싣는다(설계 5.2). 공통 조각이 있을 때만 공통 인용 두 줄을 더한다(5.4).
 */
export function docSearchAddendum(input: {
  context: string | null;
  chunks: RetrievedChunk[];
  hasDocuments: boolean;
  skipped: boolean;
  /** 공통 보관함의 근거 묶음(S5) */
  commonContext?: string | null;
  /** 공통 머리에 보일 기관 유형 */
  commonOrgType?: string | null;
  /** 이번 턴에 공통 보관함도 찾았다 — '근거 없음' 문구를 공통까지 넓힌다 */
  searchedCommon?: boolean;
}): string | undefined {
  if (input.skipped) return SKIPPED.join('\n');
  const context = input.context?.trim() ?? '';
  const commonContext = input.commonContext?.trim() ?? '';
  const withAgent = context !== '' && input.chunks.some((c) => c.scope !== 'common');
  const withCommon = commonContext !== '' && !!input.commonOrgType && input.chunks.some((c) => c.scope === 'common');
  if (withAgent || withCommon) {
    return [
      ...(withAgent ? [AGENT_CONTEXT_HEAD, context, ''] : []),
      ...(withCommon ? [commonContextHead(input.commonOrgType as string), commonContext, ''] : []),
      ...CITATION_RULES,
      ...(withCommon ? COMMON_CITATION_RULES : []),
    ].join('\n');
  }
  if (input.hasDocuments) {
    const lines = input.searchedCommon
      ? NO_RESULT.map((line) => (line === NO_RESULT_AGENT_LINE ? NO_RESULT_COMMON_LINE : line))
      : NO_RESULT;
    return lines.join('\n');
  }
  return undefined;
}

/** preflight가 찾은 공통 보관함 결과 — 유형·그 유형의 행·`/context` 결과 */
interface CommonCarry {
  orgType: OrgType;
  docs: CommonSearchDoc[];
  result: NodaContextResult;
}

type DocSearchCarry =
  | { skipped: true }
  | { skipped?: false; docs: AgentDocument[]; result?: NodaContextResult; common?: CommonCarry };

type MatchInput = { agentId: string; organizationId: string | null };

/**
 * 근거를 이 비서의 행과 맞춘다. 맞지 않은 조각이 하나라도 있으면 빈 근거로(판정 R5·H):
 * - 다른 비서의 행이 있는 조각 → 섞임. critical(security). NODA 사본은 건드리지 않는다(조사할 수 있게)
 * - 어디에도 행이 없는 조각·문서 id를 읽지 못한 조각 → 고아. NODA 사본을 지우고(짧게만 기다림) warning
 * - 형식이 깨진 원소 → 확인할 수 없음. warning
 * 운영 기록에는 파일 이름을 남기지 않는다(문서 id·개수만).
 * `mixed`면 부르는 쪽이 그 턴의 공통 근거까지 버린다 — 보관함 혼선이 의심되는 턴은 어느 근거로도 답하지 않는다.
 */
async function matchedChunks(
  deps: DocSearchDeps,
  input: MatchInput,
  result: NodaContextResult,
  docs: AgentDocument[]
): Promise<{ chunks: RetrievedChunk[]; mixed: boolean }> {
  const log = deps.log ?? logSystem;
  const match = sourcesToChunks(result.sources, docs, contextPassages(result.context));
  if (isCleanMatch(match)) return { chunks: match.chunks, mixed: false };

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
      return { chunks: [], mixed: false };
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
    return { chunks: [], mixed: true };
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
    await deleteOrphans(deps, input, orphanNames, (filename) => deps.deleteOrphan(input.agentId, filename));
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
  return { chunks: [], mixed: false };
}

/** 공통 근거를 맞춘 결과. `mixed`면 그 턴 근거 전체(비서 것까지)를 버린다 */
interface CommonMatchResult {
  chunks: RetrievedChunk[];
  mixed: boolean;
  /** 번호를 민 공통 결과 — 프롬프트에 실을 근거 묶음 */
  shifted: NodaContextResult;
}

/**
 * 공통 근거를 그 유형의 행과 맞춘다(설계 5.3). 번호는 `offset`만큼 밀고 조각 순번은 `startIndex`부터 잇는다.
 * 맞지 않은 조각이 있으면 공통 근거를 버리고 가른다:
 * - 다른 유형의 행이 있는 조각 → **섞임**. critical(security). 부르는 쪽이 그 턴 근거 전체를 버린다. 사본은 건드리지 않는다
 * - 어디에도 행이 없는 조각·문서 id를 읽지 못한 조각 → 고아. 그 유형 보관함의 사본을 지우고(짧게만 기다림) warning
 * - 형식이 깨진 원소 → warning. 문서 확인 조회가 실패하면 error(사본은 건드리지 않음)
 * 비서 근거는 섞임이 아니면 그대로 쓴다. 운영 기록에는 파일 이름을 남기지 않는다(문서 id·개수·유형 열쇠만).
 */
async function matchedCommonChunks(
  deps: DocSearchDeps,
  input: MatchInput,
  common: CommonCarry,
  offset: number,
  startIndex: number
): Promise<CommonMatchResult> {
  const log = deps.log ?? logSystem;
  const shifted = shiftContext(common.result, offset);
  // 이 유형의 행만 — 다른 유형의 행과 맞은 조각은 아래에서 섞임으로 가른다
  const typeDocs = common.docs.filter((d) => d.org_type === common.orgType);
  const match = commonSourcesToChunks(shifted.sources, typeDocs, contextPassages(shifted.context), startIndex);
  if (isCleanMatch(match)) return { chunks: match.chunks, mixed: false, shifted };

  // 같은 유형인데 preflight 목록에 없던 행(그 사이 새로 올린 문서)은 섞임도 고아도 아니다 —
  // 기록 없이 이번 턴의 공통 근거만 버린다(다음 질문부터는 목록에 있다). 비서 쪽과 같은 처리
  const dropped: CommonMatchResult = { chunks: [], mixed: false, shifted };
  const base = { agent_id: input.agentId, org_type_key: ORG_TYPE_KEYS[common.orgType] };

  let owners: { id: string; org_type: string }[] = [];
  if (match.unknown.length > 0) {
    try {
      owners = await deps.findCommonDocuments(Array.from(new Set(match.unknown.map((u) => u.documentId))));
    } catch (error) {
      // 다른 유형의 것인지 지워진 것인지 모른다 — 공통 근거 없이 답하고 사본은 건드리지 않는다
      await log({
        level: 'error',
        category: 'database',
        message: '공통 기준 근거의 문서를 확인하지 못해 공통 근거를 버림',
        details: { ...base, error: error instanceof Error ? error.message : String(error) },
        orgId: input.organizationId,
      });
      return dropped;
    }
  }

  const foreign = owners.filter((o) => o.org_type !== common.orgType);
  if (foreign.length > 0) {
    await log({
      level: 'critical',
      category: 'security',
      message: '공통 기준 근거에 다른 유형의 문서가 섞여 그 턴 근거를 모두 버림',
      details: { ...base, foreign_count: foreign.length },
      orgId: input.organizationId,
    });
    return { ...dropped, mixed: true };
  }

  const found = new Set(owners.map((o) => o.id.toLowerCase()));
  const orphanIds = match.unknown.filter((u) => !found.has(u.documentId));
  const orphanNames = Array.from(new Set([...orphanIds.map((u) => u.filename), ...match.unparsable]));
  if (orphanNames.length > 0) {
    await log({
      level: 'warning',
      category: 'api',
      message: '공통 기준 근거에 지워진 문서의 NODA 사본이 있어 공통 근거를 버리고 사본을 지움',
      details: {
        ...base,
        orphan_count: orphanNames.length,
        orphan_document_ids: Array.from(new Set(orphanIds.map((u) => u.documentId))),
      },
      orgId: input.organizationId,
    });
    await deleteOrphans(deps, input, orphanNames, (filename) => deps.deleteCommonOrphan(common.orgType, filename), {
      org_type_key: base.org_type_key,
    });
  }
  if (match.malformed > 0) {
    await log({
      level: 'warning',
      category: 'api',
      message: '공통 기준 근거에 형식이 깨진 조각이 있어 공통 근거를 버림',
      details: { ...base, malformed_count: match.malformed },
      orgId: input.organizationId,
    });
  }
  return dropped;
}

/**
 * 고아 사본을 지운다(`remove` — 비서 보관함이든 공통 보관함이든 근거를 돌려준 그 보관함).
 * 실패는 기록만 하고, 답이 늦어지지 않게 `ORPHAN_DELETE_WAIT_MS`까지만 기다린다
 */
async function deleteOrphans(
  deps: DocSearchDeps,
  input: MatchInput,
  filenames: string[],
  remove: (filename: string) => Promise<void>,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const log = deps.log ?? logSystem;
  const all = Promise.all(
    filenames.map((filename) =>
      Promise.resolve()
        .then(() => remove(filename))
        .catch((error: unknown) =>
          log({
            level: 'warning',
            category: 'api',
            message: '문서 찾기 근거의 NODA 고아 사본을 지우지 못함',
            details: {
              agent_id: input.agentId,
              ...extra,
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
  const { chunks } = await matchedChunks(deps, { agentId, organizationId }, result, docs);
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

      // 비서 문서 행과 (기관 유형 → 그 유형의 공통 문서 행)을 함께 읽는다. 유형은 그 턴에 읽는다(설계 5.1)
      let docs: AgentDocument[];
      let orgType: OrgType | null = null;
      let commonDocs: CommonSearchDoc[] = [];
      try {
        const [agentDocs, common] = await Promise.all([
          deps.documentsOf(agentId),
          (async () => {
            const type = await deps.orgTypeOf(organizationId);
            // 유형이 없거나 표 밖이면 공통 행을 조회하지도, 공통 보관함을 부르지도 않는다
            if (!isOrgType(type)) return null;
            return { type, docs: await deps.commonDocumentsOf(type) };
          })(),
        ]);
        docs = agentDocs;
        if (common) {
          orgType = common.type;
          commonDocs = common.docs;
        }
      } catch (error) {
        // 행을 모르면 근거를 맞춰 볼 수 없다 — 근거 없이 답하지 않고 닫는다.
        // 공통 행을 모르면 공통 문서에 답이 있는 질문에 '찾지 못했습니다'라고 단정할 수 있다(설계 5.1)
        await log({
          level: 'error',
          category: 'database',
          message: '참고 문서 목록을 읽지 못해 대화를 거절함',
          details: { agent_id: agentId, error: error instanceof Error ? error.message : String(error) },
          orgId: organizationId,
        });
        return unavailable;
      }

      const searchAgent = hasReady(docs);
      const commonType = orgType !== null && hasCurrentCommon(commonDocs) ? orgType : null;
      if (!searchAgent && !commonType) return { ok: true, carry: { docs: [] } satisfies DocSearchCarry };

      // 두 곳을 찾으면 예산을 나눈다 — 모델에 가는 발췌가 두 배로 늘지 않게(설계 5.1)
      const both = searchAgent && commonType !== null;
      const [agentCall, commonCall] = await Promise.allSettled([
        searchAgent
          ? Promise.resolve().then(() => deps.fetchContext(agentId, message, both ? CONTEXT_BUDGET_AGENT_SHARED : NODA_CONTEXT_BUDGET))
          : Promise.resolve(undefined),
        commonType
          ? Promise.resolve().then(() =>
              deps.fetchCommonContext(commonType, message, both ? CONTEXT_BUDGET_COMMON_SHARED : NODA_CONTEXT_BUDGET)
            )
          : Promise.resolve(undefined),
      ]);

      // 하나라도 실패하면 닫는다 — 한쪽 근거만으로 답하면 다른 쪽에 답이 있는 질문을 '찾지 못했다'고 할 수 있다.
      // 질문 원문은 남기지 않는다. NodaError 글에는 키가 실리지 않는다(noda.ts)
      const failures = [
        ...(agentCall.status === 'rejected' ? [{ error: agentCall.reason as unknown, extra: {} }] : []),
        ...(commonCall.status === 'rejected' && commonType
          ? [{ error: commonCall.reason as unknown, extra: { org_type_key: ORG_TYPE_KEYS[commonType] } }]
          : []),
      ];
      if (failures.length > 0) {
        for (const { error, extra } of failures) {
          await log({
            level: 'warning',
            category: 'api',
            message: '참고 문서(NODA)를 불러오지 못해 대화를 거절함',
            details: {
              agent_id: agentId,
              ...extra,
              code: error instanceof NodaError ? error.code : 'unknown',
              status: error instanceof NodaError ? error.status : null,
            },
            orgId: organizationId,
          });
        }
        return unavailable;
      }

      const result = agentCall.status === 'fulfilled' ? agentCall.value : undefined;
      const commonResult = commonCall.status === 'fulfilled' ? commonCall.value : undefined;
      return {
        ok: true,
        carry: {
          docs,
          ...(result ? { result } : {}),
          ...(commonType && commonResult ? { common: { orgType: commonType, docs: commonDocs, result: commonResult } } : {}),
        } satisfies DocSearchCarry,
      };
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
      if (!carry.result && !carry.common) return {};

      // 비서 근거는 S4 그대로(판정 R5·H)
      const agentMatch = carry.result ? await matchedChunks(deps, ctx, carry.result, carry.docs) : { chunks: [], mixed: false };
      const agentMatched = agentMatch.chunks;

      // 공통 근거 — 비서 조각이 하나라도 있으면 비서 묶음의 가장 큰 번호만큼 민다(설계 5.2).
      // 비서 조각이 모두 빠진 턴은 밀지 않는다 — 공통 보관함으로 검증할 때 [n]이 맞게(5.5)
      // 비서 근거에 남의 비서 문서가 섞였으면 공통 근거도 맞추지 않는다(사본 지우기도 하지 않는다) — 그 턴은 근거 없이
      let common: CommonMatchResult | null = null;
      if (carry.common && !agentMatch.mixed) {
        const offset = agentMatched.length > 0 && carry.result ? maxCitationNumber(carry.result) : 0;
        common = await matchedCommonChunks(deps, ctx, carry.common, offset, agentMatched.length);
      }

      // 어느 쪽이든 섞였으면 그 턴 근거 전체를 버린다(공통 쪽은 5.3)
      const mixed = agentMatch.mixed || common?.mixed === true;
      const agentChunks = mixed ? [] : agentMatched;
      const commonChunks = mixed ? [] : (common?.chunks ?? []);
      const chunks = [...agentChunks, ...commonChunks];

      // `/verify`는 보관함 하나만 받는다(5.5) — 둘 다 근거가 있으면 부르지 않는다
      let verifySources: { doc_id: string; chunk_id: string }[] = [];
      let verifyTenant: string | undefined;
      if (agentChunks.length > 0 && commonChunks.length === 0 && carry.result) {
        verifySources = verifySourcesOf(carry.result.sources);
      } else if (agentChunks.length === 0 && commonChunks.length > 0 && carry.common) {
        verifySources = verifySourcesOf(carry.common.result.sources);
        verifyTenant = commonTenant(carry.common.orgType);
      }

      return {
        chunks,
        dropped: (carry.result?.dropped ?? 0) + (carry.common?.result.dropped ?? 0),
        verifySources,
        ...(verifyTenant ? { verifyTenant } : {}),
        systemAddendum: docSearchAddendum({
          context: carry.result ? stripNodaPrefixes(carry.result.context) : null,
          chunks,
          hasDocuments: true,
          skipped: false,
          // 공통 쪽은 받아들인 조각의 블록만 싣는다 — 뺀 조각(지난 판 등)의 글이 모델에게 가지 않게(설계 실패 기준 2)
          commonContext: common
            ? stripNodaPrefixes(
                keepContextBlocks(
                  common.shifted.context,
                  new Set(commonChunks.map((c) => c.n).filter((n): n is number => typeof n === 'number'))
                )
              )
            : null,
          commonOrgType: carry.common?.orgType ?? null,
          searchedCommon: carry.common !== undefined,
        }),
      };
    },
  };
}

export const docSearch = createDocSearch();
