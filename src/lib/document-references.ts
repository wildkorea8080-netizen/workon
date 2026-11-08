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

export interface ReferenceDeps {
  loadDocument(id: string, organizationId: string): Promise<ReferenceDocumentRow | null>;
  readText(storagePath: string, fileName: string): Promise<{ ok: true; text: string; truncated: boolean } | { ok: false; status: number; message: string }>;
  /** 기관의 비서 문서(비서 이름 포함). 다 못 읽었으면 truncated */
  listDocuments(organizationId: string): Promise<{ rows: ReferenceDocumentRow[]; truncated: boolean }>;
  /** 기관 유형의 공통 문서(지난 판 포함). 유형이 없으면 빈 목록 */
  listCommon(organizationId: string): Promise<CommonReferenceRow[]>;
}

export type ReferenceOutcome =
  | { ok: true; data: { document: { id: string; name: string }; truncated: boolean; candidatesTruncated: boolean; rows: ReferenceRow[]; summary: ReferenceSummary } }
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

/** 문서 하나의 참조 관계. 볼 수 없는 문서·없는 문서는 같은 404 */
export async function documentReferences(id: string, actor: ActorScope, deps: ReferenceDeps): Promise<ReferenceOutcome> {
  if (!actor.organizationId) return { ok: false, status: 403, message: '소속 기관을 확인할 수 없습니다.' };
  const doc = await deps.loadDocument(id.toLowerCase(), actor.organizationId);
  if (!doc || !doc.storage_path || doc.noda_status === 'deleting' || !canReadDocument(doc, actor)) return { ok: false, status: 404, message: '문서를 찾을 수 없습니다.' };
  const read = await deps.readText(doc.storage_path, doc.file_name);
  if (!read.ok) return read;
  const citations = extractCitations(read.text);
  const [documents, common] = await Promise.all([deps.listDocuments(actor.organizationId), deps.listCommon(actor.organizationId)]);
  const rows = matchReferences(citations, buildCandidates(actor, documents.rows, common), doc.id);
  return {
    ok: true,
    data: {
      document: { id: doc.id, name: doc.title?.trim() || doc.file_name },
      truncated: read.truncated,
      candidatesTruncated: documents.truncated,
      rows,
      summary: summarizeReferences(rows),
    },
  };
}
