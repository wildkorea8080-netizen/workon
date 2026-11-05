// src/lib/rag-eval-sets.ts
// 문서 찾기 일괄 평가의 이름 붙인 세트(0059) — 검사·권한 판정(순수 함수). 저장은 /api/admin/rag-eval/sets.
import type { ActorScope } from '@/lib/agent-permissions';
import { parseRagEvalSet, ragEvalSetText } from '@/lib/rag-eval';

export const RAG_EVAL_SET_NAME_MAX = 60;
/** 기관 하나가 보관하는 세트 수 상한 — 목록이 화면 하나에 들어오게 */
export const RAG_EVAL_SETS_MAX = 100;

export interface RagEvalSetRow {
  id: string;
  name: string;
  question_count: number;
  created_by: string | null;
  updated_at: string;
}

/** 이름 다듬기 — NFC, 보이지 않는 서식 글자·제어 글자 제거, 공백 하나로 */
export function normalizeSetName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 저장할 세트 — 이름(1~60자)과 세트 글을 검사하고, 세트는 서버가 다시 읽어 다듬은 꼴(머리 줄 + 탭 세 칸)로 바꾼다.
 * 화면이 보낸 글을 그대로 저장하지 않는다(다시 읽으면 같은 세트가 되도록)
 */
export function prepareRagEvalSet(input: { name?: unknown; set?: unknown }):
  | { ok: true; name: string; text: string; count: number }
  | { ok: false; message: string } {
  const name = normalizeSetName(input.name);
  if (!name) return { ok: false, message: '세트 이름을 적어 주세요.' };
  if (name.length > RAG_EVAL_SET_NAME_MAX) return { ok: false, message: `세트 이름은 ${RAG_EVAL_SET_NAME_MAX}자까지입니다.` };
  const parsed = parseRagEvalSet(typeof input.set === 'string' ? input.set : '');
  if (!parsed.ok) return { ok: false, message: parsed.errors[0] };
  return { ok: true, name, text: ragEvalSetText(parsed.rows), count: parsed.rows.length };
}

/** 고치거나 지울 수 있는가 — 만든 사람이거나 기관 전체를 관리하는 관리자(최상위 부서 소속) */
export function canChangeRagEvalSet(row: Pick<RagEvalSetRow, 'created_by'>, actor: ActorScope): boolean {
  if (!actor.isAdmin) return false;
  return row.created_by === actor.userId || actor.managesWholeOrganization;
}
