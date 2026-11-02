// 작업실 '대조' 보기(CurrentizeView)가 쓰는 순수 함수 — 시험(tests/work-currentize-ui.test.ts)이 그리는 규칙을 고정한다.
// plan.ts는 순수 모듈(형식만 가져옴)이라 화면에서 가져와도 서버 코드가 섞이지 않는다.
import { CHANGE_KIND_LABEL, CHANGE_STATUS_LABEL, changeEditBlock, hasProposedAfter, isNoopChange } from '@/lib/work/workflows/currentize/plan';
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
export function editableChange(change: Pick<CurrentizeChangeDto, 'kind' | 'before' | 'after'>): { ok: true } | { ok: false; reason: string } {
  const reason = changeEditBlock(change);
  return reason ? { ok: false, reason } : { ok: true };
}

/**
 * 올해 글 입력칸의 처음 글. 확인 요청(수치·인용)은 올해 글이 없고 고칠 대상이 **문단 전체**라,
 * 빈칸으로 두면 '1,300'만 적어 문단이 그 글로 바뀌기 쉽다 — 같은 문단의 바꿈 글(연도를 민 글), 없으면 작년 글로 채운다.
 */
export function draftFor(change: CurrentizeChangeDto, changes: CurrentizeChangeDto[]): string {
  if (change.after !== null) return change.after;
  // '확인함'으로 닫은 행(올해 글 = 작년 글)은 밀린 글이 아니다
  const sibling = changes.find((c) => c.segmentId === change.segmentId && c.status === 'changed' && c.after !== null && !isNoopChange(c));
  return sibling?.after ?? change.before;
}

/**
 * '확인함' 단추 — 확인 필요만(서버 acknowledgeChange와 같은 판정). 글을 넣을 수 없는 빈 칸·여러 줄 칸·표 구조 확인도 이것으로 닫는다.
 * 확인 필요가 하나라도 남으면 검토 완료가 막힌다
 */
export function canAcknowledge(change: Pick<CurrentizeChangeDto, 'status'>): boolean {
  return change.status === 'needs_check';
}

/**
 * 단추 이름(N2). 올해 글이 있는 확인 요청(밀린 날짜·다른 연도 문장·확인 필요로 내린 고치기·단위 모르는 칸)에서는
 * '확인함'이 "이 올해 글이 맞다"로 읽혀 눌렀는데 파일에는 작년 글이 남았다 — 서버의 확인함은 언제나 작년 글 그대로 두기다.
 * 그래서 올해 글을 넣는 길(저장)은 '이 글로 확인', 작년 글을 두는 길(확인함)은 '작년 글 그대로 두기'로 가른다.
 * 제안은 '이 글로 받아들이기', 올해 글 없는 확인 요청·바꿈 고치기는 '올해 글 저장'·'확인함' 그대로
 */
export function saveLabel(change: Pick<CurrentizeChangeDto, 'status' | 'before' | 'after'>): string {
  if (change.status === 'proposed') return '이 글로 받아들이기';
  if (change.status === 'needs_check' && hasProposedAfter(change)) return '이 글로 확인';
  return '올해 글 저장';
}

/** 올해 글이 있고 그 글을 저장할 수도 있는 행 — 확인함과 저장이 갈리는 곳(글을 넣을 수 없는 빈 칸·여러 줄 칸은 확인함 한 길뿐) */
function hasSavableAfter(change: Pick<CurrentizeChangeDto, 'kind' | 'before' | 'after'>): boolean {
  return hasProposedAfter(change) && changeEditBlock(change) === null;
}

export function acknowledgeLabel(change: Pick<CurrentizeChangeDto, 'kind' | 'before' | 'after'>): string {
  return hasSavableAfter(change) ? '작년 글 그대로 두기' : '확인함';
}

/** 단추에 마우스를 올리면 보이는 설명 — 올해 글이 있는 행은 그 글이 파일에 들어가지 않는다는 것을 미리 말한다 */
export function acknowledgeHint(change: Pick<CurrentizeChangeDto, 'kind' | 'before' | 'after'>): string {
  if (hasSavableAfter(change)) return '올해 글을 넣지 않고 작년 글을 그대로 둡니다 — 파일은 바뀌지 않습니다. 올해 글을 넣으려면 "이 글로 확인"을 누르세요';
  if (hasProposedAfter(change)) return '보이는 올해 글은 파일에 들어가지 않습니다 — 한글에서 직접 고친 뒤 확인함으로 닫으세요';
  return '작년 글 그대로 두어도 된다고 확인했습니다 — 파일은 바뀌지 않습니다';
}

/** 저장 단추 — 빈 글은 안 되고, 이미 바꾼 변경에 같은 글이면 바뀐 것이 없다(확인 필요·제안은 같은 글이어도 '이대로 받아들임') */
export function canSave(change: CurrentizeChangeDto, draft: string): boolean {
  if (!draft.trim()) return false;
  return !(change.status === 'changed' && draft === change.after);
}
