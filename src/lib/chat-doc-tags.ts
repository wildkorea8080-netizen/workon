// src/lib/chat-doc-tags.ts
// 대화에서 '문서 좁히기' — 고른 태그가 붙은 이 비서의 문서만 근거로 찾는다(2026-11-23). 아무것도 import하지 않는다(화면·서버 공용 잎 파일).
//
// 문서 태그(0060)·기관 태그 분류표(0061)는 관리자가 붙여 왔지만 대화에서는 쓸 곳이 없었다 — NODA `/context`에 문서 거르기가 없어서다.
// 입력형 앱의 문서 찾기 단계는 찾은 뒤에 태그로 거른다(2026-11-09, filterChunksByTags). 대화도 같은 방식이다:
// - 고른 태그가 있으면 이 비서 보관함만 찾고(공통 자료실은 태그가 없어 뺀다), 거를 몫을 생각해 예산을 넉넉히 받는다
// - 찾은 근거 중 고른 태그가 하나라도 붙은 문서의 조각만 남기고, 모델에게도 그 조각의 글만 싣는다
// - 남는 것이 없으면 '고른 태그의 문서에서 찾지 못했다'로 답하게 한다(지어내지 않게)
// - 답변 행 `source_references.doc_tags`에 남겨 지난 대화에서도 무엇으로 좁혔는지 보인다

/** 이 비서의 문서에 붙은 태그 하나와 그 태그가 붙은 문서 수 — `GET /api/agents/[id]/document-tags` */
export interface AgentDocTag {
  tag: string;
  count: number;
}

/** 한 질문에 고를 수 있는 태그 수 — 입력형 앱의 태그 좁히기(APP_LOOKUP_TAGS_MAX)와 같다 */
export const CHAT_DOC_TAGS_MAX = 5;
/** 문서 태그 한 개 길이 — document-tags.ts MAX_TAG_CHARS와 같다(잎 파일이라 다시 적는다) */
const TAG_MAX_CHARS = 20;

/** 태그 하나 다듬기 — document-tags.ts normalizeTag와 같은 규칙 */
function normalizeOne(raw: string): string {
  return raw.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/,/g, ' ').replace(/^#+/, '').replace(/\s+/g, ' ').trim();
}

/**
 * 요청의 `doc_tags` — 없으면(undefined·null·빈 배열) 좁히지 않는다. 글 배열만 받고, 다듬어 겹친 것은 처음 것만,
 * 20자를 넘거나 5개를 넘으면 거절한다(조용히 자르지 않는다)
 */
export function parseChatDocTags(raw: unknown): { ok: true; tags: string[] } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, tags: [] };
  if (!Array.isArray(raw) || !raw.every((t) => typeof t === 'string')) return { ok: false, message: '문서 좁히기 태그를 확인해 주세요.' };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw as string[]) {
    const tag = normalizeOne(item);
    if (!tag) continue;
    if (tag.length > TAG_MAX_CHARS) return { ok: false, message: `태그는 ${TAG_MAX_CHARS}자까지입니다.` };
    const key = tag.toLocaleLowerCase('ko');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  if (out.length > CHAT_DOC_TAGS_MAX) return { ok: false, message: `문서 좁히기는 태그 ${CHAT_DOC_TAGS_MAX}개까지입니다.` };
  return { ok: true, tags: out };
}

/** 말풍선 위 표시 — 이 답이 무엇으로 좁혀 찾았는지 */
export function docTagsNote(tags: readonly string[]): string {
  return `문서 좁히기: ${tags.map((t) => `#${t}`).join(' ')} — 이 태그가 붙은 문서에서만 찾았습니다`;
}

/** 태그 목록을 못 읽었을 때 */
export const DOC_TAGS_UNREAD = '문서 태그 목록을 지금 불러오지 못했습니다 — 좁히지 않고 모든 문서에서 찾습니다.';
