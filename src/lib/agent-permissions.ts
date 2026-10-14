/**
 * 비서 권한 판정 — 설계 3절.
 *
 * DB를 보지 않는 순수 함수만 둔다. 비서 정보와 요청자 범위를 받아 판정만
 * 돌려준다. 그래야 판정 표 전체를 단위 테스트로 고정할 수 있다
 * (tests/agent-permissions.test.ts).
 *
 * 예전에는 판정이 라우트마다 흩어져 있었다 — 대화는 chat/route.ts 안에서,
 * 수정은 'ADMIN이면 통과'로. 한 곳만 어긋나도 드러나지 않는 구조였다.
 * 비서를 바꾸는 라우트는 전부 이 모듈을 거친다
 * (tests/agent-route-permissions.test.ts가 원본으로 확인한다).
 */

export type AgentTier = 'personal' | 'department' | 'official';
export type AgentVisibility = 'organization' | 'department';

export interface AgentAccessInfo {
  id: string;
  tier: AgentTier;
  /** 부서 비서는 주인 부서, 공식 비서는 걸린 부서, 나만의 비서는 만든 당시 부서 */
  department_id: string;
  organization_id: string | null;
  visibility: AgentVisibility;
  owner_id: string | null;
  created_by: string | null;
  is_active: boolean;
  is_published: boolean;
  deleted_at: string | null;
  approval_status: string | null;
  version: number;
  approval_version: number | null;
}

/** loadAgentAccess가 select하는 칸. AgentAccessInfo와 함께 고친다. */
export const AGENT_ACCESS_COLUMNS =
  'id, tier, department_id, organization_id, visibility, owner_id, created_by, ' +
  'is_active, is_published, deleted_at, approval_status, version, approval_version';

export interface ActorScope {
  userId: string;
  isAdmin: boolean;
  departmentId: string;
  organizationId: string | null;
  /** 자기 부서 + 상위 부서 (getVisibleDepartmentIds) */
  visibleDepartmentIds: string[];
  /** 관리자만 채운다. 자기 부서 + 하위, 최상위면 기관 전체 (getManagedDepartmentIds) */
  managedDepartmentIds: string[];
  /** 최상위 부서 소속 관리자 */
  managesWholeOrganization: boolean;
}

/** 모든 판정의 전제. 기관을 모르면 무엇도 허용하지 않는다. */
function sameOrganization(agent: AgentAccessInfo, actor: ActorScope): boolean {
  return Boolean(actor.organizationId) && agent.organization_id === actor.organizationId;
}

function managesAgentDepartment(agent: AgentAccessInfo, actor: ActorScope): boolean {
  return actor.isAdmin && actor.managedDepartmentIds.includes(agent.department_id);
}

export function canEditAgent(agent: AgentAccessInfo, actor: ActorScope): boolean {
  if (agent.deleted_at) return false;
  if (!sameOrganization(agent, actor)) return false;

  switch (agent.tier) {
    case 'personal':
      return agent.owner_id === actor.userId;
    case 'department':
      // 주인 부서 소속만. 하위 부서 직원은 쓰기만 한다 — 상위 부서가 만든
      // 비서를 하위 부서 누구나 바꾸면 책임 소재가 흐려진다(결정 4).
      return actor.departmentId === agent.department_id || managesAgentDepartment(agent, actor);
    case 'official':
      return agent.visibility === 'organization'
        ? actor.isAdmin && actor.managesWholeOrganization
        : managesAgentDepartment(agent, actor);
  }
}

export function canUseAgent(agent: AgentAccessInfo, actor: ActorScope): boolean {
  if (agent.deleted_at || !agent.is_active) return false;
  if (!sameOrganization(agent, actor)) return false;

  switch (agent.tier) {
    case 'personal':
      return agent.owner_id === actor.userId;
    case 'department':
      // 주인 부서가 내 부서 계통(자기 + 상위)에 있으면 = 내가 주인 부서이거나 그 하위
      return actor.visibleDepartmentIds.includes(agent.department_id);
    case 'official':
      // 노출 대기 중은 공개 전에 관리자가 직접 써 보는 단계다
      if (!agent.is_published) return canEditAgent(agent, actor);
      return agent.visibility === 'organization'
        ? true
        : actor.visibleDepartmentIds.includes(agent.department_id);
  }
}

export function canDeleteAgent(agent: AgentAccessInfo, actor: ActorScope): boolean {
  if (agent.deleted_at) return false;
  if (!sameOrganization(agent, actor)) return false;

  switch (agent.tier) {
    case 'personal':
      return agent.owner_id === actor.userId;
    case 'department':
      // 지우기는 되돌릴 수 없다. 부서원 아무나 지우면 한 사람의 실수로
      // 부서 전체가 쓰던 비서가 사라진다(결정 4).
      return agent.created_by === actor.userId || managesAgentDepartment(agent, actor);
    case 'official':
      return canEditAgent(agent, actor);
  }
}

export function canPromoteToDepartment(agent: AgentAccessInfo, actor: ActorScope): boolean {
  return agent.tier === 'personal' && canEditAgent(agent, actor);
}

export function canRequestOfficial(agent: AgentAccessInfo, actor: ActorScope): boolean {
  if (agent.tier === 'official') return false;
  if (agent.approval_status === 'pending') return false;
  return canEditAgent(agent, actor);
}

/**
 * 승인할 수 있는 관리자 = 공식이 된 뒤 그 비서를 고칠 수 있는 관리자.
 * 기관 전체로 여는 승인은 기관 전체 관리자만 한다.
 */
export function canApproveOfficial(
  agent: AgentAccessInfo,
  actor: ActorScope,
  targetVisibility: AgentVisibility
): boolean {
  if (agent.deleted_at || !actor.isAdmin) return false;
  if (!sameOrganization(agent, actor)) return false;
  return targetVisibility === 'organization'
    ? actor.managesWholeOrganization
    : actor.managedDepartmentIds.includes(agent.department_id);
}
