import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 직원 공지 띠.
 * 예전: 부서 → 기관을 못 읽으면 '전체 공지만'으로 보아 **내 기관 공지가 조용히 빠졌고**, 세션에 부서가 없으면 기관 공지를 못 봤다.
 * 읽음 표시는 uuid가 아니거나 없는 공지에 DB 오류 500, 대리 접근 중에는 기관 관리자 이름으로 읽음이 남았다.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const NOTICE = '22222222-2222-4222-8222-222222222222';
const state = {
  session: null as unknown,
  deptError: null as unknown,
  userDept: 'd1' as string | null,
  upsertError: null as unknown,
  upserts: 0,
  ors: [] as string[],
};

vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => state.session }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'order', 'limit', 'in']) b[n] = () => b;
      b.or = (f: string) => { state.ors.push(f); return b; };
      b.upsert = async () => { state.upserts++; return { error: state.upsertError }; };
      b.maybeSingle = async () => {
        if (table === 'users') return { data: { department_id: state.userDept }, error: null };
        if (table === 'departments') return { data: state.deptError ? null : { organization_id: ORG }, error: state.deptError };
        return { data: null, error: null };
      };
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res);
      return b;
    },
  },
}));

import { GET } from '@/app/api/notices/route';
import { POST as readPOST } from '@/app/api/notices/[id]/read/route';

beforeEach(() => {
  state.session = { user: { id: 'u1', departmentId: 'd1' } };
  state.deptError = null; state.userDept = 'd1'; state.upsertError = null; state.upserts = 0; state.ors = [];
});

describe('GET /api/notices', () => {
  it('기관을 못 읽으면 전체 공지만이 아니라 503', async () => {
    state.deptError = { code: 'XX000' };
    expect((await GET(new Request('http://x/') as never)).status).toBe(503);
  });
  it('세션에 부서가 없으면 사용자 행에서 찾아 내 기관 공지까지', async () => {
    state.session = { user: { id: 'u1' } };
    await GET(new Request('http://x/') as never);
    expect(state.ors.some((f) => f.includes(`target_org_ids.cs.{${ORG}}`))).toBe(true);
  });
});

describe('POST /api/notices/[id]/read', () => {
  const read = (id: string) => readPOST(new Request('http://x/', { method: 'POST' }) as never, { params: { id } });
  it('uuid가 아니면 400, 없는 공지(23503)는 404', async () => {
    expect((await read('abc')).status).toBe(400);
    expect(state.upserts).toBe(0);
    state.upsertError = { code: '23503' };
    expect((await read(NOTICE)).status).toBe(404);
  });
  it('대리 접근 중에는 읽음을 남기지 않음', async () => {
    state.session = { user: { id: 'u1', isImpersonating: true } };
    expect((await read(NOTICE)).status).toBe(200);
    expect(state.upserts).toBe(0);
  });
  it('보통은 남김', async () => {
    expect((await read(NOTICE)).status).toBe(200);
    expect(state.upserts).toBe(1);
  });
});
