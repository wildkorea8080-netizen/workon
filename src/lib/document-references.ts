// src/lib/document-references.ts
// 문서 참조 관계(2026-11-08) — 관리자 문서 화면의 '참조 문서'. 문서 원본을 글로 읽어 「…」·『…』로 인용한 이름을 찾고,
// 기관 문서(요청자가 볼 수 있는 비서 문서)와 기관 유형의 공통 자료실에서 같은 이름의 문서를 맞춘다. **모델을 부르지 않는다.**
//
// 보는 것: 인용한 규정·지침이 문서함에 있는가, 지금 판이 있는가(지난 판만 있으면 '지난 판만'), 없으면 법령 꼴인가(법제처에서 확인).
// 이 문서를 인용하는 쪽(거꾸로)은 다른 문서를 모두 다시 읽어야 해 하지 않는다.
import type { ActorScope } from '@/lib/agent-permissions';
import { canReadDocument } from '@/lib/document-files';

/** 한 문서에서 보이는 인용 이름 수 상한 */
export const REFERENCE_MAX_CITATIONS = 100;
/** 인용 하나에 보이는 맞는 문서 수 상한 */
export const REFERENCE_MAX_MATCHES = 5;
/** 인용 이름 길이(글자) */
export const REFERENCE_NAME_MIN = 2;
export const REFERENCE_NAME_MAX = 60;
/** 부분 일치로 볼 이름 열쇠의 최소 길이 — 짧은 이름('규정')이 아무 문서에나 맞지 않게 */
const PARTIAL_MIN = 4;
const CONTEXT_CHARS = 30;

export interface Citation {
  /** 「」 안의 이름(다듬음) */
  name: string;
  count: number;
  /** 처음 나온 자리의 앞뒤 글(한 줄) */
  context: string;
}

export type CandidateStatus = 'current' | 'retired' | 'reading' | 'failed' | 'unreadable' | 'unknown';

export interface ReferenceCandidate {
  kind: 'agent' | 'common';
  id: string;
  /** 보이는 이름(제목 또는 파일 이름, 공통은 제목) */
  name: string;
  /** 맞출 열쇠(제목·파일 이름에서) */
  keys: string[];
  status: CandidateStatus;
  agentName?: string;
  editionYear?: number;
  effectiveFrom?: string | null;
}

export interface ReferenceMatch extends Omit<ReferenceCandidate, 'keys'> {
  exact: boolean;
}

export interface ReferenceRow extends Citation {
  matches: ReferenceMatch[];
  /** 맞는 문서가 지난 판뿐 */
  retiredOnly: boolean;
  /** 맞는 문서가 없고 이름이 법령·자치법규 꼴(…법·시행령·시행규칙·조례) — 법제처에서 확인 */
  lawLike: boolean;
}

export interface ReferenceSummary {
  cited: number;
  matched: number;
  retiredOnly: number;
  lawLike: number;
  unmatched: number;
}

const BRACKETS = /「([^「」\n]{1,200})」|『([^『』\n]{1,200})』/g;

const oneLine = (s: string) => s.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();

/** 원문에서 「…」·『…』 인용 이름 — 나온 순서, 같은 이름은 한 번(횟수만 셈), 상한까지 */
export function extractCitations(text: string): Citation[] {
  const byKey = new Map<string, Citation>();
  const out: Citation[] = [];
  for (const m of text.matchAll(BRACKETS)) {
    const name = oneLine((m[1] ?? m[2] ?? '').normalize('NFC'));
    const length = Array.from(name).length;
    if (length < REFERENCE_NAME_MIN || length > REFERENCE_NAME_MAX || !/[\p{L}]/u.test(name)) continue;
    const key = referenceKey(name);
    if (!key) continue;
    const seen = byKey.get(key);
    if (seen) { seen.count += 1; continue; }
    if (out.length >= REFERENCE_MAX_CITATIONS) continue;
    const at = m.index ?? 0;
    const before = oneLine(text.slice(Math.max(0, at - CONTEXT_CHARS), at));
    const after = oneLine(text.slice(at + m[0].length, at + m[0].length + CONTEXT_CHARS));
    const citation = { name, count: 1, context: `${before ? `…${before} ` : ''}${m[0]}${after ? ` ${after}…` : ''}` };
    byKey.set(key, citation);
    out.push(citation);
  }
  return out;
}

/**
 * 이름 맞추기 열쇠 — NFC·소문자, 확장자·괄호 안 글·꺾쇠, 앞뒤 연도(2026·2026년·2026년도), '개정'·'개정안' 꼬리('(안)'은 괄호로 빠진다), 공백·가운뎃점·붙임표를 뺀다.
 * '여비 규정(2026 개정).hwpx'와 「여비규정」이 같은 열쇠가 된다
 */
export function referenceKey(raw: string): string {
  let s = raw.normalize('NFC').toLowerCase();
  s = s.replace(/\.(hwpx?|docx?|pdf|txt|xlsx?|csv|pptx?|md)$/i, '');
  s = s.replace(/[「」『』《》〈〉<>[\]]/g, ' ');
  s = s.replace(/\([^()]*\)|（[^（）]*）/g, ' ');
  s = s.replace(/^\s*\d{4}\s*년?\s*도?\s*/, '').replace(/\s*\d{4}\s*년?\s*도?\s*$/, '');
  s = s.replace(/\s*(개정안|개정)\s*$/, '');
  return s.replace(/[\s·・\-_.]+/g, '');
}

/** 법령·자치법규 꼴의 이름 — 문서함에 없을 때 법제처에서 확인하라고 안내한다 */
export function isLawLike(name: string): boolean {
  // '…규칙'은 기관 내부 규칙도 흔해 넣지 않는다
  return /(법|법률|시행령|시행규칙|조례)$/.test(name.replace(/\s+/g, ''));
}

/** 후보의 열쇠 — 제목과 파일 이름(둘이 다르면 둘 다) */
export function candidateKeys(...names: (string | null | undefined)[]): string[] {
  const keys = new Set<string>();
  for (const n of names) {
    if (typeof n !== 'string' || !n.trim()) continue;
    const k = referenceKey(n);
    if (k) keys.add(k);
  }
  return [...keys];
}

function matchKind(citationKey: string, keys: string[]): 'exact' | 'partial' | null {
  if (keys.includes(citationKey)) return 'exact';
  if (citationKey.length < PARTIAL_MIN) return null;
  return keys.some((k) => k.length >= PARTIAL_MIN && (k.includes(citationKey) || citationKey.includes(k))) ? 'partial' : null;
}

const STATUS_RANK: Record<CandidateStatus, number> = { current: 0, reading: 1, failed: 2, unreadable: 3, unknown: 4, retired: 5 };

/** 인용마다 맞는 문서 — 정확히 같은 이름 먼저, 지금 판 먼저, 상한까지. 자기 자신은 뺀다 */
export function matchReferences(citations: Citation[], candidates: ReferenceCandidate[], selfId?: string): ReferenceRow[] {
  return citations.map((c) => {
    const key = referenceKey(c.name);
    const found: ReferenceMatch[] = [];
    for (const cand of candidates) {
      if (selfId && cand.kind === 'agent' && cand.id === selfId) continue;
      const kind = matchKind(key, cand.keys);
      if (!kind) continue;
      const { keys: _keys, ...rest } = cand;
      void _keys;
      found.push({ ...rest, exact: kind === 'exact' });
    }
    found.sort((a, b) => Number(b.exact) - Number(a.exact) || STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.name.localeCompare(b.name, 'ko'));
    const matches = found.slice(0, REFERENCE_MAX_MATCHES);
    return {
      ...c,
      matches,
      retiredOnly: matches.length > 0 && found.every((m) => m.status === 'retired'),
      lawLike: matches.length === 0 && isLawLike(c.name),
    };
  });
}

export function summarizeReferences(rows: ReferenceRow[]): ReferenceSummary {
  return {
    cited: rows.length,
    matched: rows.filter((r) => r.matches.length && !r.retiredOnly).length,
    retiredOnly: rows.filter((r) => r.retiredOnly).length,
    lawLike: rows.filter((r) => r.lawLike).length,
    unmatched: rows.filter((r) => !r.matches.length && !r.lawLike).length,
  };
}

/** NODA 읽기 상태 → 후보 상태 */
export function candidateStatus(nodaStatus: string | null | undefined, retiredAt?: string | null): CandidateStatus {
  if (retiredAt || nodaStatus === 'retired') return 'retired';
  if (nodaStatus === 'ready') return 'current';
  if (nodaStatus === 'reading' || nodaStatus === 'failed' || nodaStatus === 'unreadable') return nodaStatus;
  return 'unknown';
}

// ── 서버 흐름(의존은 라우트가 넣는다) ──

export const REFERENCE_DOCUMENT_COLUMNS = 'id, agent_id, department_id, organization_id, visibility, storage_path, file_name, title, noda_status, retired_at, effective_from';

export interface ReferenceDocumentRow {
  id: string;
  agent_id: string | null;
  department_id: string;
  organization_id: string | null;
  visibility: string | null;
  storage_path: string | null;
  file_name: string;
  title: string | null;
  noda_status: string | null;
  retired_at: string | null;
  effective_from: string | null;
  agent?: { name?: string | null; deleted_at?: string | null } | { name?: string | null; deleted_at?: string | null }[] | null;
}

export interface CommonReferenceRow {
  id: string;
  title: string;
  file_name: string;
  edition_year: number;
  noda_status: string | null;
  retired_at: string | null;
}

// ── 참조 색인(2026-11-09) — 문서마다 인용한 이름의 열쇠를 `documents.metadata.references`에 둔다(마이그레이션 없음).
// 거꾸로('이 문서를 인용하는 문서')는 이 색인으로만 찾는다 — 다른 문서를 그때마다 다시 읽지 않는다.

export const REFERENCE_INDEX_VERSION = 1;
/** 거꾸로 목록 상한 */
export const CITED_BY_MAX = 50;
/** 색인 한 번에 읽는 문서 수·시간 예산 */
export const INDEX_BATCH = 5;
export const INDEX_BUDGET_MS = 40_000;

export type SkipReason = 'unreadable' | 'too_large' | 'deleting' | 'no_file';
export type ReferenceIndex =
  | { v: 1; status: 'ok'; keys: string[]; computed_at: string }
  | { v: 1; status: 'skipped'; reason: SkipReason; keys: string[]; computed_at: string };

export function buildIndex(citations: Citation[], now: Date): ReferenceIndex {
  const keys = [...new Set(citations.map((c) => referenceKey(c.name)).filter(Boolean))].slice(0, REFERENCE_MAX_CITATIONS);
  return { v: REFERENCE_INDEX_VERSION, status: 'ok', keys, computed_at: now.toISOString() };
}

export function skippedIndex(reason: SkipReason, now: Date): ReferenceIndex {
  return { v: REFERENCE_INDEX_VERSION, status: 'skipped', reason, keys: [], computed_at: now.toISOString() };
}

/** 원문을 못 읽은 이유 → 건너뛸 이유(다시 읽어도 같은 것만). 저장소가 잠깐 안 될 때(503 등)는 null — 다음에 다시 */
export function skipReasonFor(status: number): 'unreadable' | 'too_large' | null {
  if (status === 413) return 'too_large';
  if (status === 422) return 'unreadable';
  return null;
}

/** 거꾸로 목록 한 줄 */
export interface CitingDocument {
  id: string;
  name: string;
  agentName?: string;
  status: CandidateStatus;
  effectiveFrom?: string | null;
  /** 이름이 같지 않고 비슷하게(한쪽이 다른 쪽을 품음, 4자 이상) 인용 — 같은 문서인지 사람이 확인(2026-11-12) */
  similar?: true;
}

/**
 * 거꾸로 목록의 '이름 비슷'(2026-11-12) — 인용한 쪽 색인 열쇠와 이 문서 이름 열쇠가 같지는 않지만 한쪽이 다른 쪽을 품는가(둘 다 4자 이상).
 * 나가는 쪽 맞추기(`matchKind`의 부분 일치)와 같은 규칙. 「지방공기업 예산편성기준」이 '예산편성기준' 문서를 가리키는 꼴
 */
export function similarCitation(indexKeys: string[], selfKeys: string[]): boolean {
  return indexKeys.some((k) => k.length >= PARTIAL_MIN && selfKeys.some((s) => s.length >= PARTIAL_MIN && k !== s && (k.includes(s) || s.includes(k))));
}

/** 이 문서를 인용하는 문서 — 요청자가 볼 수 있는 것만(지운 비서·지우는 중 제외), 자기 문서 빼고, 같은 이름 먼저·지금 판 먼저, 상한까지. `similarIds`는 '이름 비슷' */
export function buildCitedBy(actor: ActorScope, rows: ReferenceDocumentRow[], selfId: string, similarIds: ReadonlySet<string> = new Set()): CitingDocument[] {
  const seen = new Set<string>();
  const out: CitingDocument[] = [];
  for (const d of rows) {
    if (d.id === selfId || seen.has(d.id) || d.noda_status === 'deleting' || !canReadDocument(d, actor)) continue;
    const agent = agentOf(d);
    if (!agent || agent.deleted_at) continue;
    seen.add(d.id);
    out.push({ id: d.id, name: d.title?.trim() || d.file_name, agentName: agent.name?.trim() || undefined, status: candidateStatus(d.noda_status, d.retired_at), effectiveFrom: d.effective_from, ...(similarIds.has(d.id) ? { similar: true as const } : {}) });
  }
  out.sort((a, b) => Number(Boolean(a.similar)) - Number(Boolean(b.similar)) || STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.name.localeCompare(b.name, 'ko'));
  return out.slice(0, CITED_BY_MAX);
}

export interface ReferenceDeps {
  loadDocument(id: string, organizationId: string): Promise<ReferenceDocumentRow | null>;
  readText(storagePath: string, fileName: string): Promise<{ ok: true; text: string; truncated: boolean } | { ok: false; status: number; message: string }>;
  /** 기관의 비서 문서(비서 이름 포함). 다 못 읽었으면 truncated */
  listDocuments(organizationId: string): Promise<{ rows: ReferenceDocumentRow[]; truncated: boolean }>;
  /** 기관 유형의 공통 문서(지난 판 포함). 유형이 없으면 빈 목록 */
  listCommon(organizationId: string): Promise<CommonReferenceRow[]>;
  /** 참조 색인 저장(그 문서의 metadata에 합침). 실패는 던지지 않고 false */
  saveIndex(id: string, organizationId: string, index: ReferenceIndex): Promise<boolean>;
  /** 색인에 그 열쇠 가운데 하나라도 든 기관 문서(비서 이름 포함) */
  listCiting(organizationId: string, keys: string[]): Promise<ReferenceDocumentRow[]>;
  /** 색인 열쇠가 그 열쇠와 '이름 비슷'(`similarCitation`)한 기관 문서(같은 이름은 빼도 되고 넣어도 됨). 없으면 같은 이름만 찾는다 */
  listSimilarCiting?(organizationId: string, keys: string[]): Promise<ReferenceDocumentRow[]>;
  /** 요청자가 볼 수 있는 기관 문서 중 색인된 수·전체 수. 못 세면 null */
  coverage(actor: ActorScope): Promise<{ indexed: number; total: number } | null>;
  now?(): Date;
}

export type ReferenceOutcome =
  | {
      ok: true;
      data: {
        document: { id: string; name: string };
        truncated: boolean;
        candidatesTruncated: boolean;
        rows: ReferenceRow[];
        summary: ReferenceSummary;
        /** 이 문서의 원문을 글로 못 읽어 인용을 찾지 못한 이유(스캔 PDF·너무 큼) — 거꾸로 목록은 그래도 보인다 */
        outgoingError?: string;
        /** 이 문서를 인용하는 문서(참조 색인으로 찾음 — 같은 이름 열쇠만) */
        citedBy: CitingDocument[];
        /** 요청자가 볼 수 있는 문서 중 색인된 수 — 덜 됐으면 거꾸로 목록이 빠질 수 있다 */
        coverage: { indexed: number; total: number } | null;
      };
    }
  | { ok: false; status: number; message: string };

const agentOf = (row: ReferenceDocumentRow) => (Array.isArray(row.agent) ? row.agent[0] : row.agent) ?? null;

/** 후보 — 요청자가 볼 수 있는 비서 문서(지운 비서·지우는 중 제외)와 공통 문서 */
export function buildCandidates(actor: ActorScope, documents: ReferenceDocumentRow[], common: CommonReferenceRow[]): ReferenceCandidate[] {
  const out: ReferenceCandidate[] = [];
  for (const d of documents) {
    if (d.noda_status === 'deleting' || !canReadDocument(d, actor)) continue;
    const agent = agentOf(d);
    if (!agent || agent.deleted_at) continue;
    out.push({
      kind: 'agent', id: d.id, name: d.title?.trim() || d.file_name, keys: candidateKeys(d.title, d.file_name),
      status: candidateStatus(d.noda_status, d.retired_at), agentName: agent.name?.trim() || undefined, effectiveFrom: d.effective_from,
    });
  }
  for (const c of common) {
    if (c.noda_status === 'deleting') continue;
    out.push({
      kind: 'common', id: c.id, name: c.title, keys: candidateKeys(c.title, c.file_name),
      status: candidateStatus(c.noda_status, c.retired_at), editionYear: c.edition_year,
    });
  }
  return out;
}

/**
 * 문서 하나의 참조 관계. 볼 수 없는 문서·없는 문서는 같은 404.
 * 나가는 쪽: 원문을 읽어 인용을 찾고 맞춘다(그 결과로 이 문서의 참조 색인을 새로 저장). 원문을 글로 못 읽으면(스캔 PDF·너무 큼) 그 이유만 싣고 이어 간다.
 * 들어오는 쪽: 이 문서 이름(제목·파일 이름)의 열쇠가 든 참조 색인을 가진 문서
 */
export async function documentReferences(id: string, actor: ActorScope, deps: ReferenceDeps): Promise<ReferenceOutcome> {
  if (!actor.organizationId) return { ok: false, status: 403, message: '소속 기관을 확인할 수 없습니다.' };
  const organizationId = actor.organizationId;
  const doc = await deps.loadDocument(id.toLowerCase(), organizationId);
  if (!doc || !doc.storage_path || doc.noda_status === 'deleting' || !canReadDocument(doc, actor)) return { ok: false, status: 404, message: '문서를 찾을 수 없습니다.' };
  const now = deps.now?.() ?? new Date();
  const read = await deps.readText(doc.storage_path, doc.file_name);
  const skip = read.ok ? null : skipReasonFor(read.status);
  if (!read.ok && !skip) return read;
  const citations = read.ok ? extractCitations(read.text) : [];
  const selfKeys = candidateKeys(doc.title, doc.file_name);
  const [documents, common, citing] = await Promise.all([
    read.ok ? deps.listDocuments(organizationId) : Promise.resolve({ rows: [] as ReferenceDocumentRow[], truncated: false }),
    read.ok ? deps.listCommon(organizationId) : Promise.resolve([] as CommonReferenceRow[]),
    collectCiting(organizationId, selfKeys, deps),
  ]);
  await deps.saveIndex(doc.id, organizationId, read.ok ? buildIndex(citations, now) : skippedIndex(skip!, now)).catch(() => false);
  const coverage = await deps.coverage(actor).catch(() => null);
  const rows = matchReferences(citations, buildCandidates(actor, documents.rows, common), doc.id);
  return {
    ok: true,
    data: {
      document: { id: doc.id, name: doc.title?.trim() || doc.file_name },
      truncated: read.ok ? read.truncated : false,
      candidatesTruncated: documents.truncated,
      rows,
      summary: summarizeReferences(rows),
      ...(read.ok ? {} : { outgoingError: read.message }),
      citedBy: buildCitedBy(actor, citing.rows, doc.id, citing.similarIds),
      coverage,
    },
  };
}

// ── 공통 기준 문서를 인용하는 기관 문서(2026-11-12) — 관리자 문서 화면 '공통 기준 문서'의 '인용하는 문서' ──
// 정부 기준이 바뀌면(새 판) 그 기준을 「」로 인용한 기관 문서를 한 번에 본다. 참조 색인으로만 찾는다(같은 이름 열쇠 — 문서를 다시 읽지 않음, 모델 없음).

export interface CommonCitedByRow {
  id: string;
  org_type: string;
  title: string;
  file_name: string;
  edition_year: number;
}

export interface CommonCitedByDeps {
  loadCommon(id: string): Promise<CommonCitedByRow | null>;
  /** 요청자 기관의 유형(공통 자료실 열쇠와 같은 표) — 없거나 표 밖이면 null */
  orgType(organizationId: string): Promise<string | null>;
  listCiting: ReferenceDeps['listCiting'];
  listSimilarCiting?: ReferenceDeps['listSimilarCiting'];
  coverage: ReferenceDeps['coverage'];
}

export type CommonCitedByOutcome =
  | { ok: true; data: { document: { id: string; name: string; editionYear: number }; citedBy: CitingDocument[]; coverage: { indexed: number; total: number } | null } }
  | { ok: false; status: number; message: string };

/** 이 기관 유형의 공통 문서만(다른 유형은 같은 404). 인용 문서는 요청자가 볼 수 있는 이 기관 문서만 — 대화·참조 창과 같은 `buildCitedBy` */
export async function commonDocumentCitedBy(id: string, actor: ActorScope, deps: CommonCitedByDeps): Promise<CommonCitedByOutcome> {
  if (!actor.organizationId) return { ok: false, status: 403, message: '소속 기관을 확인할 수 없습니다.' };
  const notFound = { ok: false as const, status: 404, message: '문서를 찾을 수 없습니다.' };
  const [doc, orgType] = await Promise.all([deps.loadCommon(id.toLowerCase()), deps.orgType(actor.organizationId)]);
  if (!doc || !orgType || doc.org_type !== orgType) return notFound;
  const keys = candidateKeys(doc.title, doc.file_name);
  const [citing, coverage] = await Promise.all([
    collectCiting(actor.organizationId, keys, deps),
    deps.coverage(actor).catch(() => null),
  ]);
  return { ok: true, data: { document: { id: doc.id, name: doc.title, editionYear: doc.edition_year }, citedBy: buildCitedBy(actor, citing.rows, '', citing.similarIds), coverage } };
}

/** 같은 이름으로 인용한 문서 + '이름 비슷'으로 인용한 문서(같은 이름에 이미 있으면 같은 이름으로). 비슷한 쪽을 못 읽으면 같은 이름만 */
async function collectCiting(organizationId: string, keys: string[], deps: Pick<ReferenceDeps, 'listCiting' | 'listSimilarCiting'>): Promise<{ rows: ReferenceDocumentRow[]; similarIds: Set<string> }> {
  if (!keys.length) return { rows: [], similarIds: new Set() };
  const [exact, similar] = await Promise.all([
    deps.listCiting(organizationId, keys),
    deps.listSimilarCiting ? deps.listSimilarCiting(organizationId, keys).catch(() => [] as ReferenceDocumentRow[]) : Promise.resolve([] as ReferenceDocumentRow[]),
  ]);
  const exactIds = new Set(exact.map((r) => r.id));
  const extra = similar.filter((r) => !exactIds.has(r.id));
  return { rows: [...exact, ...extra], similarIds: new Set(extra.map((r) => r.id)) };
}

// ── 색인 만들기(관리자 단추 — 한 번에 몇 개씩, 화면이 남은 것이 없을 때까지 다시 부른다) ──

export interface PendingIndexRow {
  id: string;
  department_id: string;
  organization_id: string | null;
  visibility: string | null;
  storage_path: string | null;
  file_name: string;
  noda_status: string | null;
}

export interface IndexDeps {
  /** 색인이 없는 기관 문서 몇 개(최근 것부터) */
  listPending(organizationId: string, limit: number): Promise<PendingIndexRow[]>;
  readText: ReferenceDeps['readText'];
  saveIndex: ReferenceDeps['saveIndex'];
  coverage: ReferenceDeps['coverage'];
  now(): number;
}

export interface IndexResult {
  indexed: number;
  skipped: number;
  /** 저장소가 잠깐 안 돼 다음으로 미룬 수 */
  deferred: number;
  coverage: { indexed: number; total: number } | null;
}

/** 요청자가 볼 수 있는 문서 중 색인 없는 것을 몇 개 읽어 색인을 남긴다. 시간 예산을 넘기면 멈춘다 */
export async function indexPendingDocuments(actor: ActorScope, deps: IndexDeps): Promise<IndexResult> {
  const result: IndexResult = { indexed: 0, skipped: 0, deferred: 0, coverage: null };
  if (!actor.organizationId) return result;
  const organizationId = actor.organizationId;
  const started = deps.now();
  // 볼 수 없는 문서가 섞여 넉넉히 받아 거른다
  const rows = (await deps.listPending(organizationId, INDEX_BATCH * 4)).filter((r) => canReadDocument(r, actor)).slice(0, INDEX_BATCH);
  for (const row of rows) {
    if (deps.now() - started > INDEX_BUDGET_MS) break;
    result[await indexOneDocument(row, organizationId, deps)] += 1;
  }
  result.coverage = await deps.coverage(actor).catch(() => null);
  return result;
}

/** 문서 하나의 색인 — 원본을 읽어 인용 열쇠를 남기거나, 다시 읽어도 같은 이유면 '건너뜀'으로 남긴다. 저장소가 잠깐 안 되면 'deferred'(다음에 다시) */
async function indexOneDocument(row: PendingIndexRow, organizationId: string, deps: Pick<IndexDeps, 'readText' | 'saveIndex' | 'now'>): Promise<'indexed' | 'skipped' | 'deferred'> {
  const at = new Date(deps.now());
  if (row.noda_status === 'deleting' || !row.storage_path) {
    return (await deps.saveIndex(row.id, organizationId, skippedIndex(row.noda_status === 'deleting' ? 'deleting' : 'no_file', at))) ? 'skipped' : 'deferred';
  }
  const read = await deps.readText(row.storage_path, row.file_name).catch(() => ({ ok: false as const, status: 503, message: '' }));
  if (read.ok) return (await deps.saveIndex(row.id, organizationId, buildIndex(extractCitations(read.text), at))) ? 'indexed' : 'deferred';
  const skip = skipReasonFor(read.status);
  return skip && (await deps.saveIndex(row.id, organizationId, skippedIndex(skip, at))) ? 'skipped' : 'deferred';
}

// ── 색인 자동 채우기(2026-11-12) — 5분 실행기(pg_cron, /api/cron/app-schedules)가 부른다 ──
// 관리자가 '색인 만들기'를 누르기 전에도 새로 올린 문서의 거꾸로 목록('이 문서를 인용하는 문서')에 잡히게, 색인 없는 문서를 한 번에 몇 개씩 채운다.
// 사람의 권한 범위가 아니라 **기관마다 그 기관 문서의 metadata에만** 쓴다(색인은 그 문서 자신의 인용 이름 — 다른 기관·다른 문서로 아무것도 옮기지 않는다).
// 원본을 읽기만 하고 모델을 부르지 않는다. 지우는 중·원본 없음·다시 읽어도 같은 실패는 '건너뜀'으로 남겨 다시 집지 않는다.

export const AUTO_INDEX_BATCH = 2;
export const AUTO_INDEX_BUDGET_MS = 25_000;
/** 같은 문서가 잠깐 실패를 되풀이해 차례를 막지 않게 — 한 번에 받아 섞어 고르는 후보 수 */
export const AUTO_INDEX_CANDIDATES = 20;

export interface AutoIndexDeps {
  /** 색인이 없고 원본 경로가 있거나 지우는 중인 기관 문서(모든 기관, 최근 것부터) */
  listPendingAll(limit: number): Promise<PendingIndexRow[]>;
  readText: IndexDeps['readText'];
  saveIndex: IndexDeps['saveIndex'];
  now(): number;
  /** 0 이상 1 미만 — 시험에서 바꿔 끼운다 */
  random(): number;
}

export type AutoIndexTick = { indexed: number; skipped: number; deferred: number };

/** 색인 없는 문서 몇 개를 채운다. 던지지 않는다 */
export async function autoIndexReferences(deps: AutoIndexDeps): Promise<AutoIndexTick> {
  const tick: AutoIndexTick = { indexed: 0, skipped: 0, deferred: 0 };
  let rows: PendingIndexRow[];
  try { rows = await deps.listPendingAll(AUTO_INDEX_CANDIDATES); } catch { return tick; }
  // 최근 것부터 받아 섞는다 — 잠깐 실패(deferred)한 문서가 맨 앞에 남아 매번 같은 문서만 집지 않게
  const pool = rows.filter((r) => typeof r.organization_id === 'string' && r.organization_id);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(deps.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const started = deps.now();
  for (const row of pool.slice(0, AUTO_INDEX_BATCH)) {
    if (deps.now() - started > AUTO_INDEX_BUDGET_MS) break;
    try { tick[await indexOneDocument(row, row.organization_id!, deps)] += 1; } catch { tick.deferred += 1; }
  }
  return tick;
}
