// src/lib/work/workflows/regulations/past-editions.ts
// 과거 적용 기준일의 내린 옛 판(2026-11-26) — 업무 '규정·지침 확인'에서 적용 기준일이 오늘보다 앞이면, 그날 시행 중이던 판이
// 이미 지난 판(`retired` — 새 판이 시행되어 NODA 사본을 지웠다)일 수 있다. 그 판은 NODA로 다시 찾을 수 없어 예전에는
// 기준일 뒤에 시행된 새 판만 '기준일 뒤' 표시와 함께 나왔다(그날 적용되던 판은 '따로 확인하라'는 안내뿐).
//
// 지난 판의 행·원본은 감사용으로 남아 있다(문서 판 0055). 그날 시행 중이던 지난 판을 판 사슬로 골라 **원본을 다시 읽고**
// (첨부 읽개 — 스캔 PDF는 NODA로 보내지 않음) 질문 낱말이 든 문단을 근거로 더한다. 뜻 찾기가 아니라 낱말 맞추기이고 모델을 부르지 않는다.
// 새 판의 근거는 그대로 둔다(그 판의 '기준일 뒤' 판정도 그대로) — 이 근거는 더해질 뿐이다.
import type { RawEvidence } from './evidence';

/** 한 번에 다시 읽는 지난 판 수 — 원본 읽기가 무거워 적게 */
export const PAST_EDITION_DOCS = 3;
/** 지난 판 하나에서 근거로 쓸 문단 수 */
export const PAST_PASSAGES_PER_DOC = 2;
/** 근거 문단 하나의 길이 */
export const PAST_PASSAGE_MAX = 1500;
/** 질문 낱말 수 상한 */
const MAX_TERMS = 12;

export interface PastEditionDoc {
  id: string;
  title: string | null;
  file_name: string;
  storage_path: string | null;
  noda_status: string | null;
  replaces_id?: string | null;
  effective_from?: string | null;
}

const day = (v: string | null | undefined) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

/**
 * 그날(`basisDay`) 시행 중이던 **지난 판**과 그 다음 판의 시행일 — 지난 판 X는 (X의 시행일이 없거나 그날 이전) 이고
 * X를 바꾼 판(`replaces_id = X`)의 시행일이 **그날 뒤**일 때만. 다음 판의 시행일을 모르면 고르지 않는다(언제 내렸는지 모름)
 */
export function pastEditionsInForce(docs: PastEditionDoc[], basisDay: string): Array<{ doc: PastEditionDoc; until: string }> {
  const successor = new Map<string, PastEditionDoc>();
  for (const d of docs) if (typeof d.replaces_id === 'string' && d.replaces_id) successor.set(d.replaces_id.toLowerCase(), d);
  const out: Array<{ doc: PastEditionDoc; until: string }> = [];
  for (const d of docs) {
    if (d.noda_status !== 'retired' || !d.storage_path) continue;
    const own = day(d.effective_from);
    if (own && own > basisDay) continue;
    const next = successor.get(d.id.toLowerCase());
    const until = day(next?.effective_from);
    if (!until || until <= basisDay) continue;
    out.push({ doc: d, until });
  }
  return out.slice(0, PAST_EDITION_DOCS);
}

const PARTICLE = /(?:으로|에서|에게|까지|부터|이나|이며|이고|은|는|이|가|을|를|에|의|로|와|과|도|만)$/;
const squash = (s: string) => s.normalize('NFC').replace(/\s+/g, '').toLowerCase();

/** 질문 → 맞출 낱말(2자 이상, 조사 뗀 것, 같은 것 한 번, 12개까지) */
export function queryTerms(query: string): string[] {
  const words = query.normalize('NFC').split(/[\s,.·!?()[\]{}「」『』"'“”‘’:;/~\-]+/).filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    const stem = w.length > 2 && PARTICLE.test(w) ? w.replace(PARTICLE, '') : w;
    const t = stem.length >= 2 ? stem : '';
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

/** 원문 → 문단(빈 줄로 나누고, 긴 문단은 줄 단위로 1,500자 안에서 자른다) */
export function splitPassages(text: string): string[] {
  const out: string[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const b = block.trim();
    if (!b) continue;
    if (b.length <= PAST_PASSAGE_MAX) { out.push(b); continue; }
    let cur = '';
    for (const line of b.split('\n')) {
      if (cur && cur.length + line.length + 1 > PAST_PASSAGE_MAX) { out.push(cur); cur = ''; }
      cur = cur ? `${cur}\n${line}` : line.slice(0, PAST_PASSAGE_MAX);
    }
    if (cur) out.push(cur);
  }
  return out;
}

/** 질문 낱말이 가장 많이 든 문단 — 낱말이 셋 이상이면 둘 이상 맞아야(우연한 한 낱말로 엉뚱한 문단을 근거로 삼지 않게). 원문 순서로 */
export function pickPassages(text: string, terms: string[], max = PAST_PASSAGES_PER_DOC): string[] {
  if (!terms.length) return [];
  const need = terms.length >= 3 ? 2 : 1;
  const keys = terms.map(squash);
  const scored = splitPassages(text)
    .map((p, index) => ({ p, index, score: keys.filter((k) => squash(p).includes(k)).length }))
    .filter((x) => x.score >= need)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, max)
    .sort((a, b) => a.index - b.index);
  return scored.map((x) => x.p);
}

export type ReadOriginal = (storagePath: string, fileName: string) => Promise<{ ok: true; text: string } | { ok: false }>;

/**
 * 그날 시행 중이던 지난 판의 근거 — 원본을 다시 읽어 질문 낱말이 든 문단. 못 읽은 판은 건너뛴다(던지지 않는다).
 * 근거의 위치에 '지난 판 · 기준일에 시행 중(다음 판 시행 전까지)'을 적는다
 */
export async function pastEditionEvidence(docs: PastEditionDoc[], basisDay: string, query: string, read: ReadOriginal): Promise<RawEvidence[]> {
  const picks = pastEditionsInForce(docs, basisDay);
  if (!picks.length) return [];
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const items: RawEvidence[] = [];
  for (const { doc, until } of picks) {
    let out: Awaited<ReturnType<ReadOriginal>>;
    try { out = await read(doc.storage_path!, doc.file_name); } catch { continue; }
    if (!out.ok) continue;
    for (const passage of pickPassages(out.text, terms)) {
      items.push({
        kind: 'org_doc',
        documentId: doc.id,
        title: (doc.title?.trim() || doc.file_name).slice(0, 200),
        location: `지난 판 · ${basisDay}에 시행 중이던 판(${until} 새 판 시행 전까지) — 원문에서 찾음`,
        effectiveDate: day(doc.effective_from),
        editionYear: null,
        issuer: null,
        text: passage,
        url: null,
      });
    }
  }
  return items;
}
