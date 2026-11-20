import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 브랜딩을 못 읽으면 기본값으로 꾸미지 않는다.
 * 예전 `/api/branding`은 사용자·부서·기관 읽기 실패에도 기본 브랜딩(ok: true)으로 답했고, 화면(`use-branding.ts`)은 그 값을
 * '이 사람의 브랜딩'으로 기억(branding-snapshot)해 기관명·로고·테마 색이 기본값('AI 업무도우미'·청록)으로 바뀌었다.
 */

const state = { session: null as unknown, deptError: null as unknown, orgError: null as unknown, retryError: null as unknown, orgCalls: 0 };

vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => state.session }));
vi.mock('@/lib/config', () => ({ APP_NAME: 'AI 업무도우미' }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq']) b[n] = () => b;
      b.maybeSingle = async () => {
        if (table === 'users') return { data: { department_id: 'd1' }, error: null };
        if (table === 'departments') return { data: state.deptError ? null : { organization_id: 'o1' }, error: state.deptError };
        state.orgCalls++;
        if (state.orgCalls === 1 && state.orgError) return { data: null, error: state.orgError };
        if (state.orgCalls === 2 && state.retryError) return { data: null, error: state.retryError };
        return { data: { name: '가 기관', slug: 'ga', logo_url: null, ai_notice: null, theme_color: null }, error: null };
      };
      return b;
    },
  },
}));

import { GET } from '@/app/api/branding/route';

beforeEach(() => {
  state.session = { user: { id: 'u1', departmentId: 'd1' } };
  state.deptError = null; state.orgError = null; state.retryError = null; state.orgCalls = 0;
});

describe('GET /api/branding', () => {
  it('정상', async () => {
    expect((await (await GET(new Request('http://x/') as never)).json()).data.name).toBe('가 기관');
  });
  it('부서를 못 읽으면 기본 브랜딩이 아니라 503', async () => {
    state.deptError = { code: 'XX000' };
    const res = await GET(new Request('http://x/') as never);
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
  });
  it('기관 두 번 다 못 읽으면 503, 테마 칸만 없으면 옛 칸으로', async () => {
    state.orgError = { code: '42703' };
    expect((await (await GET(new Request('http://x/') as never)).json()).data.name).toBe('가 기관');
    state.orgCalls = 0; state.retryError = { code: 'XX000' };
    expect((await GET(new Request('http://x/') as never)).status).toBe(503);
  });
  it('로그인 전 없는 기관 경로는 그대로 기본 브랜딩(어떤 기관이 있는지 드러내지 않음)', async () => {
    state.session = null;
    const body = await (await GET(new Request('http://x/') as never)).json();
    expect(body).toMatchObject({ ok: true, data: { name: 'AI 업무도우미' } });
  });
});

describe('원본 확인 — 화면', () => {
  it('실패는 기억하지도 기본값으로 덮지도 않는다', () => {
    const s = readFileSync('src/lib/use-branding.ts', 'utf8');
    expect(s).toContain('if (entry.real) cache.set(key, entry);');
    expect(s).toContain("if (snapshotUser && current?.real) writeBrandingSnapshot(snapshotUser, current.data);");
    expect(s).toContain('return remembered ?? current?.data ?? FALLBACK;');
  });
});
