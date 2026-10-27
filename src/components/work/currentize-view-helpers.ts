// 작업실 '대조' 보기(CurrentizeView)가 쓰는 순수 함수 — 시험(tests/work-currentize-ui.test.ts)이 그리는 규칙을 고정한다.
// plan.ts는 순수 모듈(형식만 가져옴)이라 화면에서 가져와도 서버 코드가 섞이지 않는다.
import { CHANGE_KIND_LABEL, CHANGE_STATUS_LABEL, changeEditBlock } from '@/lib/work/workflows/currentize/plan';
import type { CurrentizeChangeDto, CurrentizeCitationDto, CurrentizeDto } from './types';

export type ChangeFilter = 'all' | 'needs_check' | 'proposed' | 'changed';

export const FILTERS: [ChangeFilter, string][] = [
  ['all', '전체'],
  ['needs_check', '확인 필요'],
  ['proposed', '제안'],
  ['changed', '바꿈'],
];

export function filterChanges(changes: CurrentizeChangeDto[], filter: ChangeFilter): CurrentizeChangeDto[] {
  return filter === 'all' ? changes : changes.filter((c) => c.status === filter);
}

export function countByStatus(changes: CurrentizeChangeDto[]): Record<ChangeFilter, number> {
  const out: Record<ChangeFilter, number> = { all: changes.length, needs_check: 0, proposed: 0, changed: 0 };
  for (const c of changes) out[c.status]++;
  return out;
}

export function kindLabel(kind: string): string {
  return (CHANGE_KIND_LABEL as Record<string, string>)[kind] ?? kind;
}

export function statusLabel(status: string): string {
  return (CHANGE_STATUS_LABEL as Record<string, string>)[status] ?? status;
}

/** 그 조각에서 읽은 인용들(한 문단에 인용이 여럿일 수 있다) — 순서 그대로 */
export function citationFor(content: CurrentizeDto, segmentId: string): CurrentizeCitationDto[] {
  return content.citations.filter((p) => p.segmentId === segmentId);
}

/** 직원이 올해 글을 넣을 수 있는가 — 판정은 서버(applyChangeEdit)와 같은 함수 */
export function editableChange(change: Pick<CurrentizeChangeDto, 'kind' | 'before'>): { ok: true } | { ok: false; reason: string } {
  const reason = changeEditBlock(change);
  return reason ? { ok: false, reason } : { ok: true };
}

/**
 * 올해 글 입력칸의 처음 글. 확인 요청(수치·인용)은 올해 글이 없고 고칠 대상이 **문단 전체**라,
 * 빈칸으로 두면 '1,300'만 적어 문단이 그 글로 바뀌기 쉽다 — 같은 문단의 바꿈 글(연도를 민 글), 없으면 작년 글로 채운다.
 */
export function draftFor(change: CurrentizeChangeDto, changes: CurrentizeChangeDto[]): string {
  if (change.after !== null) return change.after;
  const sibling = changes.find((c) => c.segmentId === change.segmentId && c.status === 'changed' && c.after !== null);
  return sibling?.after ?? change.before;
}

/** 저장 단추 — 빈 글은 안 되고, 이미 바꾼 변경에 같은 글이면 바뀐 것이 없다(확인 필요·제안은 같은 글이어도 '이대로 받아들임') */
export function canSave(change: CurrentizeChangeDto, draft: string): boolean {
  if (!draft.trim()) return false;
  return !(change.status === 'changed' && draft === change.after);
}
