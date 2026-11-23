import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-20 — 공개 범위(`getAccessScope`)가 부서를 못 읽은 것을 '기관 없음'으로 넘기지 않는다.
 * `visibilityFilter`는 기관을 모르면 부서 제한 자료만 남긴다(좁히는 쪽). 그래서 부서 읽기 실패가 '기관 없음'이 되면
 * 직원의 비서 목록(`GET /api/agents`)·관리자의 문서 목록(`GET /api/documents`)이 **오류 없이 줄어든(대개 빈) 목록**으로 내려갔다 —
 * 기관 전체 공개가 기본이라 거의 다 빠지고, 화면은 '비서가 없습니다'·문서 0건으로 보인다.
 * 이제 못 읽으면 `AccessScopeReadError` → 두 목록은 503, 능력 범위(화면용)는 null(못 읽음)·판정용은 빈 범위로 닫음.
 * 부서 행이 정말 없는 것(오류 없음)은 예전처럼 좁힌다.
 */

const state = vi.hoisted(() => ({ deptError: null as unknown, dept: { organization_id: 'o1' } as unknown, calls: [] as string[] }));

vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => ({ user: { id: 'u1', role: 'USER', departmentId: 'd1' } }) }));
vi.mock('@/lib/noda-events', () => ({ replayNodaEvents: async () => {} }));
vi.mock('@/lib/connectors', () => ({ connectorCatalog: () => [{ id: 'law', name: '국가법령정보', description: '', tools: [] }] }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    rpc: async () => ({ data: [{ id: 'd1' }], error: null }),
    from: (table: string) => {
      state.calls.push(table);
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'is', 'in', 'or', 'order', 'range', 'limit', 'neq']) b[n] = () => b;
      const result = () => {
        if (table === 'departments') return { data: state.deptError ? null : state.dept, error: state.deptError };
        if (table === 'users') return { data: { favorite_agent_ids: [] }, error: null };
        return { data: [], error: null };
      };
      b.maybeSingle = async () => result();
      b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad);
      return b;
    },
  },
}));

import { getAccessScope } from '@/lib/department-scope';
import { isAccessScopeReadError } from '@/lib/access-scope-error';
import { getCapabilityScope, readCapabilityScope } from '@/lib/connector-scope';
import { GET as agents } from '@/app/api/agents/route';
import { GET as documents } from '@/app/api/documents/route';

const BOOM = { code: 'XX000', message: 'boom' };

beforeEach(() => { state.deptError = null; state.dept = { organization_id: 'o1' }; state.calls = []; });

describe('getAccessScope', () => {
  it('읽히면 기관과 보이는 부서', async () => {
    expect(await getAccessScope('d1')).toEqual({ organizationId: 'o1', visibleDepartmentIds: ['d1'] });
  });
  it('부서를 못 읽으면 던진다(기관 없음으로 넘기지 않음)', async () => {
    state.deptError = BOOM;
    const err = await getAccessScope('d1').catch((e) => e);
    expect(isAccessScopeReadError(err)).toBe(true);
    expect(err.code).toBe('XX000');
  });
  it('부서 행이 정말 없으면 예전처럼 좁힌다(던지지 않음)', async () => {
    state.dept = null;
    expect(await getAccessScope('d1')).toEqual({ organizationId: null, visibleDepartmentIds: ['d1'] });
  });
});

describe('목록 라우트', () => {
  it('비서 목록 — 공개 범위를 못 읽으면 503(줄어든 목록을 정상으로 답하지 않음)', async () => {
    state.deptError = BOOM;
    const res = await agents(new NextRequest('http://x/api/agents'));
    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toContain('비서 목록을 지금 불러오지 못했습니다');
    expect(state.calls).not.toContain('agents');
  });
  it('문서 목록 — 공개 범위를 못 읽으면 503', async () => {
    state.deptError = BOOM;
    const res = await documents(new NextRequest('http://x/api/documents'));
    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toContain('문서 목록을 지금 불러오지 못했습니다');
    expect(state.calls).not.toContain('documents');
  });
  it('읽히면 비서 목록은 예전처럼 200', async () => {
    const res = await agents(new NextRequest('http://x/api/agents'));
    expect(res.status).toBe(200);
  });
});

describe('능력 범위', () => {
  it('공개 범위를 못 읽으면 화면용은 null, 판정용은 빈 범위로 닫는다', async () => {
    state.deptError = BOOM;
    expect(await readCapabilityScope('d1')).toBeNull();
    expect((await getCapabilityScope('d1')).publicDataConnectors.size).toBe(0);
  });
});
