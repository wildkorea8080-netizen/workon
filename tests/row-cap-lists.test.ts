import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';

/**
 * 1,000행 상한 — 목록 둘(2026-11-06). Supabase API는 한 번에 1,000행까지만 **오류 없이** 돌려준다.
 * 대화 목록의 첫 메시지 미리보기는 모든 사용자 메시지를 한 번에 읽어 뒤 대화의 미리보기가 빠졌고,
 * 슈퍼관리자 직원 목록은 모든 기관의 부서를 한 번에 읽어 뒤 부서의 이름이 '—'가 되고 기관으로 거를 때 직원이 빠졌다
 */

const state = vi.hoisted(() => ({
  calls: [] as unknown[][],
  departments: [] as { id: string; name: string; organization_id: string }[],
  firstMessages: {} as Record<string, string>,
}));
vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => ({ user: { id: 'me' } }) }));
vi.mock('@/lib/super-auth', () => ({ getSuperAdminFromRequest: () => ({ id: 'super' }) }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let range: [number, number] | null = null;
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is', 'or', 'in', 'gte', 'order', 'limit', 'range']) {
        q[m] = (...args: unknown[]) => {
          state.calls.push([table, m, ...args]);
          if (m === 'eq') filters[String(args[0])] = args[1];
          if (m === 'range') range = [args[0] as number, args[1] as number];
          return q;
        };
      }
      const result = () => {
        if (table === 'conversations') return { data: [{ id: 'c1', title: 't1' }, { id: 'c2', title: 't2' }], error: null };
        if (table === 'messages') return { data: state.firstMessages[String(filters.conversation_id)] !== undefined ? { content: state.firstMessages[String(filters.conversation_id)] } : null, error: null };
        if (table === 'departments') {
          const all = state.departments;
          const [a, b] = range ?? [0, all.length - 1];
          // 실제 API처럼 한 번에 1,000행까지만
          return { data: all.slice(a, Math.min(b + 1, a + 1000)), error: null, count: all.length };
        }
        if (table === 'organizations') return { data: [{ id: 'o1', name: '기관 하나' }, { id: 'o2', name: '기관 둘' }], error: null, count: 2 };
        if (table === 'users') return { data: [{ id: 'u1', department_id: state.departments.at(-1)?.id }], error: null, count: 1 };
        return { data: null, error: null };
      };
      q.maybeSingle = () => Promise.resolve(result());
      q.then = (resolve: (v: unknown) => unknown) => resolve(result());
      return q;
    },
  },
}));

import { NextRequest } from 'next/server';
import { GET as listConversations } from '@/app/api/conversations/route';
import { GET as superUsers } from '@/app/api/super/accounts/users/route';

beforeEach(() => { state.calls = []; state.departments = []; state.firstMessages = {}; });

describe('대화 목록 미리보기', () => {
  it('대화마다 첫 사용자 메시지 하나만 읽고 200자로 자른다', async () => {
    state.firstMessages = { c1: '가'.repeat(300), c2: '둘째 대화 질문' };
    const res = await listConversations(new NextRequest('http://localhost/api/conversations'));
    const data = (await res.json()).data as { id: string; first_message: string | null }[];
    expect(data.find((c) => c.id === 'c1')?.first_message).toHaveLength(200);
    expect(data.find((c) => c.id === 'c2')?.first_message).toBe('둘째 대화 질문');
    expect(state.calls.filter((c) => c[0] === 'messages' && c[1] === 'limit')).toEqual([['messages', 'limit', 1], ['messages', 'limit', 1]]);
    expect(state.calls.some((c) => c[0] === 'messages' && c[1] === 'in')).toBe(false);
  });

  it('쪽 크기·시작은 1~100·0 이상으로 맞춘다(숫자가 아니면 기본값)', async () => {
    await listConversations(new NextRequest('http://localhost/api/conversations?limit=5000&offset=-3'));
    expect(state.calls).toContainEqual(['conversations', 'range', 0, 99]);
    state.calls = [];
    await listConversations(new NextRequest('http://localhost/api/conversations?limit=abc&offset=xyz'));
    expect(state.calls).toContainEqual(['conversations', 'range', 0, 19]);
  });
});

describe('슈퍼관리자 직원 목록', () => {
  it('부서가 1,000개를 넘어도 끝까지 읽어 뒤 부서의 이름을 붙이고, 기관으로 거를 때 그 부서를 빼지 않는다', async () => {
    state.departments = Array.from({ length: 1500 }, (_, i) => ({ id: `d${String(i).padStart(4, '0')}`, name: `부서${i}`, organization_id: i < 1400 ? 'o1' : 'o2' }));
    const res = await superUsers(new NextRequest('http://localhost/api/super/accounts/users?orgId=o2'));
    const body = await res.json();
    expect(body.data[0]).toMatchObject({ department_name: '부서1499', organization_name: '기관 둘' });
    const inCall = state.calls.find((c) => c[0] === 'users' && c[1] === 'in');
    expect((inCall?.[3] as string[]).length).toBe(100);
    expect(state.calls.filter((c) => c[0] === 'departments' && c[1] === 'range').length).toBeGreaterThan(1);
  });
});

describe('보안 기록 개수', () => {
  it('개수만 센다 — 행을 받지 않는다', () => {
    expect(readFileSync('src/app/api/security-logs/route.ts', 'utf8')).toContain(".select('id', { count: 'exact', head: true })");
  });
});
