// src/lib/work/access.ts
import type { WorkActor, WorkMemberRow, WorkTaskRow, MemberRole } from './types';

/**
 * 업무 작업 권한 — 판정은 이 파일 한 곳에서만 한다(개편 05 문서 3절).
 * DB를 모르는 순수 함수다. 라우트·작업자·미리보기·내려받기가 모두 이 판정을 거친다.
 *
 *  - 작업은 기본으로 **주인만** 본다. 기관 관리자라는 이유로 남의 작업 원문·파일을 열 수 없다
 *    (기존 생성 파일 정책 '관리자도 못 받는다'를 약화하지 않는다)
 *  - 명시적으로 공유된 같은 기관 구성원만 역할대로: viewer 읽기·내려받기, editor +수정·실행, reviewer +검토 확정
 *  - 기관이 다르면 아무것도 없다(구성원 행이 잘못 들어와도 — DB 트리거가 막지만 여기서도 본다)
 *  - 보관(archived)된 작업은 읽기·내려받기만
 */
export interface TaskAccess {
  read: boolean;
  edit: boolean;
  review: boolean;
  download: boolean;
  manageMembers: boolean;
  isOwner: boolean;
  role: 'owner' | MemberRole | null;
}

export const NO_ACCESS: TaskAccess = {
  read: false,
  edit: false,
  review: false,
  download: false,
  manageMembers: false,
  isOwner: false,
  role: null,
};

export function taskAccess(
  task: Pick<WorkTaskRow, 'organization_id' | 'owner_id' | 'status'>,
  actor: WorkActor | null,
  members: Pick<WorkMemberRow, 'user_id' | 'role'>[]
): TaskAccess {
  if (!actor || !actor.organizationId || task.organization_id !== actor.organizationId) return NO_ACCESS;
  const archived = task.status === 'archived';
  if (task.owner_id === actor.userId) {
    return { read: true, edit: !archived, review: !archived, download: true, manageMembers: !archived, isOwner: true, role: 'owner' };
  }
  const member = members.find((m) => m.user_id === actor.userId);
  if (!member) return NO_ACCESS;
  return {
    read: true,
    download: true,
    edit: !archived && member.role === 'editor',
    review: !archived && member.role === 'reviewer',
    manageMembers: false,
    isOwner: false,
    role: member.role,
  };
}

export const canReadTask = (...a: Parameters<typeof taskAccess>) => taskAccess(...a).read;
export const canEditTask = (...a: Parameters<typeof taskAccess>) => taskAccess(...a).edit;
export const canReviewTask = (...a: Parameters<typeof taskAccess>) => taskAccess(...a).review;
export const canDownloadArtifact = (...a: Parameters<typeof taskAccess>) => taskAccess(...a).download;
