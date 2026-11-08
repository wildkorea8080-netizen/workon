// src/lib/assistant/answer-revise-spec.ts
// 근거로 고쳐 쓰기(2026-11-08, '검증 후 자동 재검색'의 재작성 단계) — 순수 규칙. 화면과 서버가 함께 쓴다(서버 모듈을 가져오지 않는다).
//
// 숫자 확인이 '확인되지 않음'으로 남긴 숫자가 있는 문서 근거 답변에서, 직원이 단추를 누르면 같은 질문으로 다시 찾은 근거 + 그 숫자가 든
// 문장으로 더 찾은 근거를 모델에 주고 답변을 **한 번** 고쳐 쓴다. 원래 답변(`messages.content`)은 고치지 않고 고쳐 쓴 답은
// `source_references.revision`에 따로 둔다 — 감사에서 그때 무엇을 답했는지가 남아야 한다.
import type { RetrievedChunk } from '@/lib/db';
import { sourceLocationLabel, sourceTitleLabel } from '@/components/chat/source-label';

/** 답변 하나에 고쳐 쓰기 한 번 — 시도 상한. 다 된 것은 다시 부르지 않고 저장된 것을 돌려준다 */
export const REVISE_MAX_ATTEMPTS = 1;
/** 숫자가 든 문장으로 더 찾은 근거 중 프롬프트에 더 싣는 조각 수 상한 */
export const REVISE_EXTRA_MAX_CHUNKS = 6;
/** 고쳐 쓰는 중 표시가 이보다 오래되면(함수가 도중에 끊김) 다시 차지할 수 있다 */
export const REVISE_PENDING_STALE_MS = 5 * 60_000;
/** 화면이 읽는 고쳐 쓴 답의 길이 상한 */
export const REVISE_TEXT_MAX = 20_000;

export const REVISE_BUTTON_LABEL = '근거로 숫자 다시 확인해 고쳐 쓰기';
export const REVISE_BUTTON_HINT = '확인되지 않은 숫자를 문서에서 다시 찾아 답변을 한 번 고쳐 씁니다(AI 사용량이 듭니다). 원래 답변은 그대로 남습니다.';
export const REVISION_LABEL = '근거로 고쳐 쓴 답';

/** 저장 꼴 — 고쳐 쓰는 중(차지)이거나 다 됨 */
export type StoredRevision =
  | { status: 'pending'; started_at: string }
  | {
      status: 'done';
      started_at: string;
      created_at: string;
      text: string;
      chunks: Record<string, unknown>[];
      /** 고쳐 쓴 답에서도 확인되지 않은 숫자 */
      number_check: { unverified: string[] };
      /** 고쳐 쓰기를 부른 숫자(원래 답변의 확인되지 않은 숫자) */
      revised_numbers: string[];
      model: string;
    };

/** 화면이 보는 고쳐 쓴 답 */
export interface RevisionView {
  text: string;
  chunks: RetrievedChunk[];
  unverified: string[];
  revisedNumbers: string[];
  createdAt: string;
}

const strings = (raw: unknown, max: number) =>
  Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string').slice(0, max).map((v) => v.slice(0, 40)) : [];

/** 저장·응답의 값을 화면이 믿지 않고 다시 읽는다 — 다 된 것만, 꼴이 맞을 때만 */
export function readRevision(raw: unknown): RevisionView | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.status !== 'done' || typeof r.text !== 'string' || !r.text.trim()) return null;
  const chunks = Array.isArray(r.chunks)
    ? (r.chunks.filter((c) => c && typeof c === 'object' && typeof (c as RetrievedChunk).documentId === 'string') as RetrievedChunk[]).slice(0, 40)
    : [];
  const check = r.number_check && typeof r.number_check === 'object' ? (r.number_check as { unverified?: unknown }).unverified : undefined;
  return {
    text: r.text.slice(0, REVISE_TEXT_MAX),
    chunks,
    unverified: strings(check, 10),
    revisedNumbers: strings(r.revised_numbers, 10),
    createdAt: typeof r.created_at === 'string' ? r.created_at : '',
  };
}

/** 고쳐 쓰는 중인가(오래된 표시는 끊긴 것으로 본다) */
export function revisionPending(raw: unknown, now: number): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as { status?: unknown; started_at?: unknown };
  if (r.status !== 'pending' || typeof r.started_at !== 'string') return false;
  const at = Date.parse(r.started_at);
  return Number.isFinite(at) && now - at < REVISE_PENDING_STALE_MS;
}

type Refs = {
  chunks?: unknown;
  links?: unknown;
  number_check?: { unverified?: unknown };
  documents_skipped?: unknown;
  app_steps?: unknown;
  app_inputs?: unknown;
  revision?: unknown;
};

/**
 * 고쳐 쓸 수 있는 답변인가 — 문서 근거로 답했고(근거 조각이 있음, '문서 없이 답함' 아님), 숫자 확인이 확인되지 않은 숫자를 남겼고,
 * 근거가 문서뿐인 답(공공 데이터 도구 출처·첨부 파일·입력형 앱 실행이 아님 — 그 숫자는 다시 찾은 문서로 확인할 수 없어 지울 위험이 크다).
 * 화면은 단추를 보일지, 서버는 받을지를 이 하나로 정한다
 */
export function revisionEligibility(answerRefs: unknown, questionRefs?: unknown): { ok: true; unverified: string[] } | { ok: false; message: string } {
  const a = (answerRefs && typeof answerRefs === 'object' ? answerRefs : {}) as Refs;
  const q = (questionRefs && typeof questionRefs === 'object' ? questionRefs : {}) as { attachments?: unknown };
  const unverified = strings(a.number_check?.unverified, 10);
  if (!unverified.length) return { ok: false, message: '확인되지 않은 숫자가 없는 답변입니다.' };
  if (a.documents_skipped === true || !Array.isArray(a.chunks) || !a.chunks.length) return { ok: false, message: '문서 근거로 답한 답변만 고쳐 쓸 수 있습니다.' };
  if (a.app_steps !== undefined || a.app_inputs !== undefined) return { ok: false, message: '입력형 앱 결과는 고쳐 쓰지 않습니다 — 앱을 다시 실행해 주세요.' };
  if (Array.isArray(a.links) && a.links.length) return { ok: false, message: '공공 데이터 조회 결과가 든 답변은 고쳐 쓰지 않습니다.' };
  if (Array.isArray(q.attachments) && q.attachments.length) return { ok: false, message: '첨부 파일을 읽은 답변은 고쳐 쓰지 않습니다.' };
  return { ok: true, unverified };
}

/** 저장된 사용자 메시지에서 질문 글만 — 첨부 표시 줄(`[첨부 파일: …]`·`[첨부 이미지 N장]`)을 뗀다 */
export function questionText(content: string): string {
  return content
    .split('\n')
    .filter((line) => !/^\s*\[첨부 /.test(line))
    .join('\n')
    .trim();
}

const chunkNumber = (c: RetrievedChunk, i: number) => (typeof c.n === 'number' ? c.n : typeof c.chunkIndex === 'number' ? c.chunkIndex + 1 : i + 1);
const chunkKey = (c: RetrievedChunk) => `${c.documentId}|${(c.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)}`;

/**
 * 숫자가 든 문장으로 더 찾은 근거 — 같은 질문으로 다시 찾은 근거(`base`)에 이미 있는 조각과 서로 겹치는 조각을 빼고, 글이 없는 조각을 빼고,
 * 상한까지. 번호는 `base`의 가장 큰 번호 뒤로 잇는다(모델이 보는 번호·화면 칩 번호가 같다)
 */
export function extraEvidence(base: RetrievedChunk[], found: (RetrievedChunk[] | null | 'timeout')[], max = REVISE_EXTRA_MAX_CHUNKS): RetrievedChunk[] {
  const seen = new Set(base.map(chunkKey));
  let next = base.reduce((m, c, i) => Math.max(m, chunkNumber(c, i)), 0);
  const out: RetrievedChunk[] = [];
  for (const list of found) {
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      if (out.length >= max) return out;
      if (!c || typeof c.text !== 'string' || !c.text.trim()) continue;
      const key = chunkKey(c);
      if (seen.has(key)) continue;
      seen.add(key);
      next += 1;
      out.push({ ...c, n: next, chunkIndex: base.length + out.length });
    }
  }
  return out;
}

/** 더 찾은 근거를 시스템 프롬프트에 싣는 글 — 대화 근거 묶음처럼 `[n] 제목 위치` 머리 줄 + 원문 */
export function extraEvidenceBlock(extras: RetrievedChunk[]): string | undefined {
  if (!extras.length) return undefined;
  const blocks = extras.map((c) => {
    const location = typeof c.page === 'number' || c.cellRange || c.section ? ` ${sourceLocationLabel(c)}` : '';
    return `[${c.n}] ${sourceTitleLabel(c)}${location}\n${c.text.trim()}`;
  });
  return ['참고 자료(숫자를 다시 확인하려고 더 찾은 근거 — 번호는 위 참고 자료에 이어집니다):', ...blocks].join('\n\n');
}

/** 고쳐 쓰기 지시 — 시스템 프롬프트 끝에 붙는다 */
export const REVISE_RULES = [
  '[답변 고쳐 쓰기]',
  '- 직원이 앞 답변의 숫자를 참고 자료로 다시 확인해 고쳐 써 달라고 했습니다. 앞 답변을 참고 자료(더 찾은 근거 포함)와 맞춰 다시 쓰세요.',
  '- 숫자는 참고 자료에 적힌 값만 쓰고, 그 숫자를 쓴 문장 끝에 근거 번호를 [n]처럼 붙이세요.',
  '- 참고 자료에서 확인되지 않는 숫자는 쓰지 말고, 필요하면 "문서에서 확인되지 않음"이라고 밝히세요. 직접 계산한 값이면 계산한 값이라고 밝히세요.',
  '- 숫자가 아닌 내용·순서·형식은 앞 답변을 따르세요. 고쳐 쓴 답변만 쓰고, 무엇을 고쳤는지 따로 설명하지 마세요.',
].join('\n');

/** 고쳐 쓰기를 요청하는 사용자 메시지 — 이 글의 숫자는 '본 숫자'에 넣지 않는다(그 숫자를 확인해 달라는 것이므로) */
export function reviseRequest(unverified: string[]): string {
  return `앞 답변에서 다음 숫자는 참고 자료에서 확인되지 않았습니다: ${unverified.join(', ')}. 참고 자료로 다시 확인해 답변을 고쳐 써 주세요.`;
}
