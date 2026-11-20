import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 읽기 실패를 '없음'으로 보이지 않기, 세 곳.
 * ① 관리자 이용통계(`/api/admin/usage-summary`): 이름 사전(직원·비서·부서)을 못 읽으면 모든 줄이 '(삭제됨)'으로 보였고 감사 CSV에도 그렇게 나갔다.
 * ② 문서 다른 비서에 붙이기(`/api/documents/assign`): 원본을 못 읽으면 '원본 문서를 찾을 수 없습니다'(404).
 * ③ 문서 지우기(`DELETE /api/documents`): 문서를 못 읽으면 '문서를 찾을 수 없습니다'(404).
 */

const state = { docError: null as unknown, doc: null as unknown };

vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => ({ user: { id: 'u1', role: 'ADMIN', departmentId: 'd1' } }), isAdminSession: () => true }));
vi.mock('@/lib/actor-scope', () => ({
  getActorScope: async () => ({ userId: 'u1', isAdmin: true, departmentId: 'd1', organizationId: 'o1', visibleDepartmentIds: ['d1'], managedDepartmentIds: ['d1'], managesWholeOrganization: true }),
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: () => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'in', 'is', 'order', 'or']) b[n] = () => b;
      b.maybeSingle = async () => ({ data: state.docError ? null : state.doc, error: state.docError });
      return b;
    },
  },
}));
vi.mock('@/lib/noda', () => ({ noda: {}, nodaTenant: () => 't' }));
vi.mock('@/lib/document-reading', () => ({ reconcileReading: vi.fn() }));
vi.mock('@/lib/document-editions', () => ({ pendingRetirements: vi.fn(), retireReplacedDocument: vi.fn() }));
vi.mock('@/lib/noda-events', () => ({ replayNodaEvents: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn() }));
vi.mock('@/lib/agent-store', () => ({ loadAgentAccess: vi.fn(async () => null), recordAgentEvent: vi.fn() }));
vi.mock('@/lib/document-files', () => ({ removeStorageFileIfUnused: vi.fn() }));

import { DELETE } from '@/app/api/documents/route';

const del = () => DELETE(new Request('http://x/api/documents', { method: 'DELETE', body: JSON.stringify({ documentId: 'doc1' }) }) as never);

beforeEach(() => { state.docError = null; state.doc = null; });

describe('DELETE /api/documents', () => {
  it('못 읽으면 404가 아니라 503', async () => {
    state.docError = { code: 'XX000' };
    const res = await del();
    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toContain('지금 읽지 못했습니다');
  });
  it('정말 없으면 404', async () => {
    expect((await del()).status).toBe(404);
  });
});

describe('원본 확인', () => {
  it('문서 붙이기: 원본 읽기 실패는 503', () => {
    const s = readFileSync('src/app/api/documents/assign/route.ts', 'utf8');
    expect(s).toContain('const { data: srcRow, error: srcError } = await supabaseAdmin');
    expect(s.indexOf('if (srcError)')).toBeLessThan(s.indexOf("'원본 문서를 찾을 수 없습니다.'"));
  });
  it('이용통계: 이름 사전 세 축 모두 오류를 받고, 못 읽으면 503', () => {
    const s = readFileSync('src/app/api/admin/usage-summary/route.ts', 'utf8');
    expect(s.match(/namesError = e;/g)?.length).toBe(3);
    expect(s).toContain("'이용통계의 이름을 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.' } }, { status: 503 }");
    expect(s.indexOf('if (namesError)')).toBeLessThan(s.indexOf('usageRowsFromGroups(parseUsageGroups(grouped), names)'));
  });
});
