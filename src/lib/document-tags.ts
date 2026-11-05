// src/lib/document-tags.ts
// 비서 문서의 태그(0060)와 문서 목록 거르기 — 아무것도 import하지 않는다(문서 화면도 읽는다).

export const MAX_DOCUMENT_TAGS = 10;
export const MAX_TAG_CHARS = 20;

/** 태그 하나 다듬기 — NFC, 제어·서식 글자와 쉼표·# 앞머리 제거, 공백 하나로 */
export function normalizeTag(raw: string): string {
  return raw.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/,/g, ' ').replace(/^#+/, '').replace(/\s+/g, ' ').trim();
}

/**
 * 저장할 태그 — 배열이나 쉼표로 이은 글을 받아 다듬고, 대소문자를 무시해 겹친 것은 처음 것만 남긴다.
 * 빈 태그는 버린다. 20자를 넘거나 10개를 넘으면 거절한다(조용히 자르지 않는다)
 */
export function normalizeDocumentTags(raw: unknown): { ok: true; tags: string[] } | { ok: false; message: string } {
  const items = typeof raw === 'string' ? raw.split(',') : Array.isArray(raw) && raw.every((t) => typeof t === 'string') ? (raw as string[]) : null;
  if (!items) return { ok: false, message: '태그를 확인해 주세요.' };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const tag = normalizeTag(item);
    if (!tag) continue;
    if (tag.length > MAX_TAG_CHARS) return { ok: false, message: `태그는 ${MAX_TAG_CHARS}자까지입니다(${tag.slice(0, MAX_TAG_CHARS)}…).` };
    const key = tag.toLocaleLowerCase('ko');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  if (out.length > MAX_DOCUMENT_TAGS) return { ok: false, message: `태그는 문서마다 ${MAX_DOCUMENT_TAGS}개까지입니다.` };
  return { ok: true, tags: out };
}

export type DocumentStatusFilter = '' | 'ready' | 'reading' | 'problem' | 'retired';

export interface DocumentFilter {
  /** 이름(제목·파일 이름)·태그에서 찾을 글 — 띄어 쓴 낱말은 모두 들어 있어야 한다 */
  q?: string;
  agentId?: string;
  status?: DocumentStatusFilter;
  tag?: string;
}

interface FilterableDocument {
  title?: string | null;
  file_name: string;
  agent_id?: string | null;
  noda_status: string | null;
  retired_at?: string | null;
  tags?: string[] | null;
}

function statusMatches(d: FilterableDocument, status: DocumentStatusFilter): boolean {
  switch (status) {
    case 'ready':
      return d.noda_status === 'ready' && !d.retired_at;
    case 'reading':
      return d.noda_status === 'reading';
    case 'problem':
      return d.noda_status === 'failed' || d.noda_status === 'unreadable' || d.noda_status === 'deleting';
    case 'retired':
      return d.noda_status === 'retired' || Boolean(d.retired_at);
    default:
      return true;
  }
}

/** 문서 목록 거르기 — 조건을 모두 만족하는 것만(순서는 그대로) */
export function filterDocuments<T extends FilterableDocument>(docs: T[], f: DocumentFilter): T[] {
  const words = (f.q ?? '').normalize('NFC').toLocaleLowerCase('ko').split(/\s+/).filter(Boolean);
  const tag = f.tag ? f.tag.toLocaleLowerCase('ko') : '';
  return docs.filter((d) => {
    if (f.agentId && d.agent_id !== f.agentId) return false;
    if (f.status && !statusMatches(d, f.status)) return false;
    const tags = (d.tags ?? []).map((t) => t.toLocaleLowerCase('ko'));
    if (tag && !tags.includes(tag)) return false;
    if (words.length) {
      const hay = [d.title ?? '', d.file_name, ...tags].join(' ').normalize('NFC').toLocaleLowerCase('ko');
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

/** 목록에 쓰인 태그(많이 쓴 순, 같으면 가나다) — 거르기 고르는 칸 */
export function tagCounts(docs: FilterableDocument[]): { tag: string; count: number }[] {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const d of docs) {
    for (const t of d.tags ?? []) {
      const key = t.toLocaleLowerCase('ko');
      const c = counts.get(key) ?? { tag: t, count: 0 };
      c.count += 1;
      counts.set(key, c);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'ko'));
}

// ── 기관 태그 분류표(0061) ─────────────────────────────────────────────

/** 분류표에 둘 수 있는 태그 수 */
export const MAX_VOCABULARY_TAGS = 100;

export interface TagVocabulary {
  tags: string[];
  /** 켜면 분류표의 태그만 저장할 수 있다 */
  restricted: boolean;
}

/**
 * 분류표 다듬기 — 쉼표·줄바꿈으로 이은 글이나 배열. 한 태그 규칙은 문서 태그와 같다(20자, 겹친 것은 처음 것만).
 * 100개를 넘으면 거절. 비어 있으면 '분류표의 태그만'을 켤 수 없다(아무도 태그를 붙이지 못하게 된다)
 */
export function normalizeVocabulary(raw: unknown, restricted: unknown): { ok: true; vocabulary: TagVocabulary } | { ok: false; message: string } {
  const items = typeof raw === 'string' ? raw.split(/[,\n]/) : Array.isArray(raw) && raw.every((t) => typeof t === 'string') ? (raw as string[]) : null;
  if (!items) return { ok: false, message: '분류표를 확인해 주세요.' };
  if (typeof restricted !== 'boolean') return { ok: false, message: '분류표 사용 방식을 확인해 주세요.' };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const tag = normalizeTag(item);
    if (!tag) continue;
    if (tag.length > MAX_TAG_CHARS) return { ok: false, message: `태그는 ${MAX_TAG_CHARS}자까지입니다(${tag.slice(0, MAX_TAG_CHARS)}…).` };
    const key = tag.toLocaleLowerCase('ko');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  if (out.length > MAX_VOCABULARY_TAGS) return { ok: false, message: `분류표에는 태그를 ${MAX_VOCABULARY_TAGS}개까지 둡니다.` };
  if (restricted && out.length === 0) return { ok: false, message: "분류표가 비어 있으면 '분류표의 태그만 쓰기'를 켤 수 없습니다." };
  return { ok: true, vocabulary: { tags: out, restricted } };
}

/**
 * 다듬은 문서 태그를 분류표에 맞춘다 — 분류표에 있는 태그는(대소문자 무시) 분류표 표기로 바꾼다.
 * '분류표의 태그만'이 켜져 있으면 분류표에 없는 태그가 하나라도 있을 때 거절하고 그 태그를 알린다
 */
export function applyVocabulary(tags: string[], vocabulary: TagVocabulary): { ok: true; tags: string[] } | { ok: false; outside: string[]; message: string } {
  const known = new Map(vocabulary.tags.map((v) => [v.toLocaleLowerCase('ko'), v]));
  const outside = tags.filter((t) => !known.has(t.toLocaleLowerCase('ko')));
  if (vocabulary.restricted && outside.length) {
    return { ok: false, outside, message: `기관 분류표에 없는 태그입니다: ${outside.join(', ')} — 분류표의 태그만 쓸 수 있습니다.` };
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tags) {
    const v = known.get(t.toLocaleLowerCase('ko')) ?? t;
    const key = v.toLocaleLowerCase('ko');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return { ok: true, tags: out };
}

/** 문서에 쓰였지만 분류표에 없는 태그(많이 쓴 순) — 분류표를 다듬을 때 더할 후보 */
export function tagsOutsideVocabulary(docs: FilterableDocument[], vocabulary: string[]): { tag: string; count: number }[] {
  const known = new Set(vocabulary.map((v) => v.toLocaleLowerCase('ko')));
  return tagCounts(docs).filter((t) => !known.has(t.tag.toLocaleLowerCase('ko')));
}
