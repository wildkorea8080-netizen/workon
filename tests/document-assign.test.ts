import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import {
  canReadDocument,
  buildAssignedDocumentRow,
  ASSIGN_SOURCE_COLUMNS,
  type AssignSourceDocument,
} from '@/lib/document-files';
import type { AgentAccessInfo, ActorScope } from '@/lib/agent-permissions';

/**
 * "다른 비서에도 연결" (POST /api/documents/assign).
 *
 * 예전에는 관리자이기만 하면 어떤 문서든(타 기관 문서까지) 어떤 비서에든
 * 붙일 수 있었고, 붙인 비서는 문서 찾기가 꺼져 있어 그 문서를 쓰지도 못했다.
 * 업로드와 같은 규칙을 따른다.
 *
 * 부서 구조 (기관 ORG): TOP ─ PLAN ─ BUDGET, TOP ─ HR. 다른 기관 OTHER.
 */
const ORG = 'org-1';

function actor(over: Partial<ActorScope> = {}): ActorScope {
  return {
    userId: 'admin-plan', isAdmin: true, departmentId: 'PLAN', organizationId: ORG,
    visibleDepartmentIds: ['PLAN', 'TOP'], managedDepartmentIds: ['PLAN', 'BUDGET'],
    managesWholeOrganization: false, ...over,
  };
}

function target(over: Partial<AgentAccessInfo>): AgentAccessInfo {
  return {
    id: 'a1', tier: 'official', department_id: 'BUDGET', organization_id: ORG,
    visibility: 'organization', owner_id: null, created_by: null,
    is_active: true, is_published: true, deleted_at: null, approval_status: null,
    version: 1, approval_version: null, ...over,
  };
}

const source: AssignSourceDocument = {
  id: 'doc-1',
  department_id: 'TOP',
  organization_id: ORG,
  visibility: 'organization',
  uploaded_by: 'u-1',
  storage_path: 'documents/TOP/1-a.pdf',
  file_name: '여비규정.pdf',
  file_type: 'application/pdf',
  title: '여비규정',
  summary: '요약',
  metadata: { chunk_count: 1, chunks: [] },
  embedding: null,
};

describe('원본 문서를 볼 수 있는가 (문서 목록과 같은 기준)', () => {
  it('같은 기관 전체 공개 문서는 본다', () => {
    expect(canReadDocument(source, actor())).toBe(true);
  });

  it('다른 기관 문서는 보지 못한다', () => {
    expect(canReadDocument({ ...source, organization_id: 'org-2' }, actor())).toBe(false);
  });

  it('기관을 모르면 아무것도 보지 못한다', () => {
    expect(canReadDocument(source, actor({ organizationId: null }))).toBe(false);
    expect(canReadDocument({ ...source, organization_id: null }, actor())).toBe(false);
  });

  it('부서 제한 문서는 내 부서 계통(자기 + 상위)에 걸린 것만', () => {
    expect(canReadDocument({ ...source, visibility: 'department', department_id: 'TOP' }, actor())).toBe(true);
    expect(canReadDocument({ ...source, visibility: 'department', department_id: 'PLAN' }, actor())).toBe(true);
    // 형제 부서
    expect(canReadDocument({ ...source, visibility: 'department', department_id: 'HR' }, actor())).toBe(false);
  });

  it('알 수 없는 공개 범위는 닫는다', () => {
    expect(canReadDocument({ ...source, visibility: null }, actor())).toBe(false);
  });
});

describe('새 문서 행 (업로드와 같은 공개 규칙)', () => {
  const keys = (row: Record<string, unknown>) => Object.keys(row).sort();

  it('공식 비서는 원본의 부서·공개 범위를 따른다', () => {
    const row = buildAssignedDocumentRow({ ...source, visibility: 'department', department_id: 'TOP' }, target({ id: 'off' }));
    expect(row).toMatchObject({ agent_id: 'off', department_id: 'TOP', visibility: 'department' });
    expect(buildAssignedDocumentRow(source, target({ id: 'off' }))).toMatchObject({ department_id: 'TOP', visibility: 'organization' });
  });

  it('부서·나만의 비서는 그 비서의 부서 안에 둔다', () => {
    // 기관 전체 공개 문서를 부서 비서에 붙여도 새 행은 그 부서 안에 머문다 —
    // 문서 목록과 Q&A 검색은 비서 단계가 아니라 visibility로 거른다
    for (const tier of ['department', 'personal'] as const) {
      const row = buildAssignedDocumentRow(source, target({ id: tier, tier, department_id: 'BUDGET' }));
      expect(row).toMatchObject({ agent_id: tier, department_id: 'BUDGET', visibility: 'department' });
    }
  });

  it('모든 행이 같은 키 집합이다 (PostgREST 배치 규칙)', () => {
    const rows = [
      buildAssignedDocumentRow(source, target({ id: 'off' })),
      buildAssignedDocumentRow(source, target({ id: 'dep', tier: 'department' })),
      buildAssignedDocumentRow(source, target({ id: 'per', tier: 'personal' })),
    ];
    expect(new Set(rows.map((r) => keys(r).join(','))).size).toBe(1);
    expect(keys(rows[0])).toContain('visibility');
    expect(keys(rows[0])).not.toContain('id');
    expect(keys(rows[0])).not.toContain('organization_id'); // 트리거가 채운다
  });

  it('원본 조회는 필요한 칸만 고른다', () => {
    expect(ASSIGN_SOURCE_COLUMNS).not.toContain('*');
    for (const col of ['organization_id', 'visibility', 'metadata', 'embedding', 'storage_path']) {
      expect(ASSIGN_SOURCE_COLUMNS).toContain(col);
    }
  });
});

describe('라우트', () => {
  const route = readFileSync('src/app/api/documents/assign/route.ts', 'utf8');

  it('원본 조회를 요청자 기관으로 한정한다', () => {
    expect(route).toContain(".eq('organization_id', actor.organizationId)");
    expect(route).toContain('canReadDocument(');
    expect(route).not.toContain("select('*')");
  });

  it('고른 비서 전부를 검사하고 중복을 거른다', () => {
    expect(route).toMatch(/new Set\(/);
    expect(route).toMatch(/for \(const \w+ of agentIds\)/);
    expect(route).not.toContain('agentIds[0]');
  });

  it('새로 연결한 비서마다 기록하고 문서 찾기를 켠다 (업로드와 같다)', () => {
    // 켜지 않으면 연결해도 그 비서는 문서를 찾지 못한다(S1-b는 doc_search가 켜진 비서만 찾는다)
    expect(route).toMatch(/recordAgentEvent\(\w+, 'document_added'/);
    expect(route).toMatch(/enableAgentCapability\(\w+, 'doc_search'/);
  });
});
