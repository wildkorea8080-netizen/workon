// tests/agent-permissions.test.ts
import { describe, it, expect } from 'vitest';
import {
  canUseAgent,
  canEditAgent,
  canDeleteAgent,
  canPromoteToDepartment,
  canRequestOfficial,
  canApproveOfficial,
  type AgentAccessInfo,
  type ActorScope,
} from '@/lib/agent-permissions';

/**
 * 설계 3.2 판정 표.
 *
 * 부서 구조 (기관 ORG):
 *   TOP(최상위) ─ PLAN(기획예산실) ─ BUDGET(예산팀)
 *               └ HR(인사팀)
 * 다른 기관 OTHER의 부서 X.
 */
const ORG = 'org-1';

function agent(over: Partial<AgentAccessInfo>): AgentAccessInfo {
  return {
    id: 'a1', tier: 'official', department_id: 'PLAN', organization_id: ORG,
    visibility: 'organization', owner_id: null, created_by: 'creator',
    is_active: true, is_published: true, deleted_at: null, approval_status: null,
    version: 1, approval_version: null,
    ...over,
  };
}

function employee(dept: string, visible: string[], over: Partial<ActorScope> = {}): ActorScope {
  return {
    userId: `u-${dept}`, isAdmin: false, departmentId: dept, organizationId: ORG,
    visibleDepartmentIds: visible, managedDepartmentIds: [], managesWholeOrganization: false,
    ...over,
  };
}

const planMember = employee('PLAN', ['PLAN', 'TOP']);
const budgetMember = employee('BUDGET', ['BUDGET', 'PLAN', 'TOP']);
const hrMember = employee('HR', ['HR', 'TOP']);
const planAdmin = employee('PLAN', ['PLAN', 'TOP'], {
  userId: 'admin-plan', isAdmin: true, managedDepartmentIds: ['PLAN', 'BUDGET'],
});
const topAdmin = employee('TOP', ['TOP'], {
  userId: 'admin-top', isAdmin: true, managedDepartmentIds: ['TOP', 'PLAN', 'BUDGET', 'HR'],
  managesWholeOrganization: true,
});
const otherOrgAdmin = employee('X', ['X'], {
  userId: 'admin-x', organizationId: 'org-2', isAdmin: true,
  managedDepartmentIds: ['X'], managesWholeOrganization: true,
});

describe('나만의 비서', () => {
  const mine = agent({ tier: 'personal', owner_id: planMember.userId, visibility: 'organization' });

  it('본인만 쓰고 고치고 지운다', () => {
    expect(canUseAgent(mine, planMember)).toBe(true);
    expect(canEditAgent(mine, planMember)).toBe(true);
    expect(canDeleteAgent(mine, planMember)).toBe(true);
  });

  it('관리자도 남의 나만의 비서는 못 건드린다', () => {
    expect(canUseAgent(mine, topAdmin)).toBe(false);
    expect(canEditAgent(mine, topAdmin)).toBe(false);
    expect(canDeleteAgent(mine, topAdmin)).toBe(false);
  });
});

describe('부서 비서 (주인 부서 PLAN)', () => {
  const dept = agent({ tier: 'department', department_id: 'PLAN', visibility: 'department', created_by: planMember.userId });

  it('주인 부서와 하위 부서가 쓴다', () => {
    expect(canUseAgent(dept, planMember)).toBe(true);
    expect(canUseAgent(dept, budgetMember)).toBe(true);
    expect(canUseAgent(dept, hrMember)).toBe(false);
  });

  it('고치기는 주인 부서 소속과 관리 범위 관리자만', () => {
    expect(canEditAgent(dept, planMember)).toBe(true);
    // 하위 부서 직원은 쓰기만 한다
    expect(canEditAgent(dept, budgetMember)).toBe(false);
    expect(canEditAgent(dept, planAdmin)).toBe(true);
    expect(canEditAgent(dept, topAdmin)).toBe(true);
  });

  it('지우기는 처음 만든 사람과 관리자만', () => {
    const coworker = employee('PLAN', ['PLAN', 'TOP'], { userId: 'coworker' });
    expect(canEditAgent(dept, coworker)).toBe(true);
    expect(canDeleteAgent(dept, coworker)).toBe(false);
    expect(canDeleteAgent(dept, planMember)).toBe(true);
    expect(canDeleteAgent(dept, planAdmin)).toBe(true);
  });

  it('인사이동한 만든 사람은 권한을 잃는다', () => {
    const moved = employee('HR', ['HR', 'TOP'], { userId: planMember.userId });
    expect(canEditAgent(dept, moved)).toBe(false);
    // 지우기 권한은 '처음 만든 사람'이라 남는다 — 같은 기관 안에서만
    expect(canDeleteAgent(dept, moved)).toBe(true);
  });
});

describe('공식 비서', () => {
  const orgWide = agent({ tier: 'official', visibility: 'organization', department_id: 'TOP' });
  const narrowed = agent({ tier: 'official', visibility: 'department', department_id: 'PLAN' });

  it('기관 전체 비서는 같은 기관 전원이 쓴다', () => {
    expect(canUseAgent(orgWide, hrMember)).toBe(true);
    expect(canUseAgent(orgWide, otherOrgAdmin)).toBe(false);
  });

  it('기관 전체 비서는 기관 전체 관리자만 고친다', () => {
    expect(canEditAgent(orgWide, topAdmin)).toBe(true);
    expect(canEditAgent(orgWide, planAdmin)).toBe(false);
    expect(canEditAgent(orgWide, planMember)).toBe(false);
  });

  it('부서로 좁힌 비서는 그 부서를 관리하는 관리자가 고친다', () => {
    expect(canUseAgent(narrowed, budgetMember)).toBe(true);
    expect(canUseAgent(narrowed, hrMember)).toBe(false);
    expect(canEditAgent(narrowed, planAdmin)).toBe(true);
    expect(canEditAgent(narrowed, planMember)).toBe(false);
    expect(canDeleteAgent(narrowed, planAdmin)).toBe(true);
  });

  it('노출 대기 중이면 고칠 수 있는 관리자만 쓴다', () => {
    const hidden = { ...orgWide, is_published: false };
    expect(canUseAgent(hidden, hrMember)).toBe(false);
    expect(canUseAgent(hidden, topAdmin)).toBe(true);
  });
});

describe('공통 차단', () => {
  it('다른 기관은 무엇도 못 한다', () => {
    const narrowed = agent({ tier: 'official', visibility: 'department', department_id: 'X', organization_id: ORG });
    expect(canEditAgent(narrowed, otherOrgAdmin)).toBe(false);
    expect(canUseAgent(narrowed, otherOrgAdmin)).toBe(false);
  });

  it('기관을 모르는 요청자는 무엇도 못 한다', () => {
    const lost = { ...planMember, organizationId: null };
    expect(canUseAgent(agent({}), lost)).toBe(false);
  });

  it('꺼지거나 지운 비서는 아무도 못 쓴다', () => {
    expect(canUseAgent(agent({ is_active: false }), topAdmin)).toBe(false);
    expect(canUseAgent(agent({ deleted_at: '2026-10-14' }), topAdmin)).toBe(false);
    expect(canEditAgent(agent({ deleted_at: '2026-10-14' }), topAdmin)).toBe(false);
  });
});

describe('단계 이동', () => {
  it('나만의 → 부서는 본인만', () => {
    const mine = agent({ tier: 'personal', owner_id: planMember.userId });
    expect(canPromoteToDepartment(mine, planMember)).toBe(true);
    expect(canPromoteToDepartment(mine, topAdmin)).toBe(false);
    expect(canPromoteToDepartment(agent({ tier: 'department' }), planMember)).toBe(false);
  });

  it('공식 신청은 고칠 수 있는 사람이, 신청 중이 아닐 때만', () => {
    const dept = agent({ tier: 'department', visibility: 'department', department_id: 'PLAN' });
    expect(canRequestOfficial(dept, planMember)).toBe(true);
    expect(canRequestOfficial(dept, budgetMember)).toBe(false);
    expect(canRequestOfficial({ ...dept, approval_status: 'pending' }, planMember)).toBe(false);
    expect(canRequestOfficial(agent({ tier: 'official' }), topAdmin)).toBe(false);
  });

  it('승인은 공식이 된 뒤 고칠 수 있는 관리자만', () => {
    const pending = agent({ tier: 'department', visibility: 'department', department_id: 'PLAN', approval_status: 'pending' });
    expect(canApproveOfficial(pending, planAdmin, 'department')).toBe(true);
    expect(canApproveOfficial(pending, planAdmin, 'organization')).toBe(false);
    expect(canApproveOfficial(pending, topAdmin, 'organization')).toBe(true);
    expect(canApproveOfficial(pending, planMember, 'department')).toBe(false);
  });
});
