import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-12 — 금지어 범위.
 * ① 관리자 목록(`GET /api/forbidden-words`)에 부서·기관 조건이 없어 모든 기관의 금지어가 보였다(기관 넘음)
 * ② 켜고 끄기·지우기는 관리자 자기 부서 것만 찾아 하위 부서 금지어를 고칠 수 없었다
 * ③ 대화 필터가 직원 부서 금지어만 걸어 기관 직속 부서 관리자가 넣은 금지어가 하위 부서 직원에게 안 걸렸다
 */

type Call = { table: string; ops: [string, unknown[]][] };
const state = vi.hoisted(() => ({ calls: [] as Call[], results: {} as Record<string, { data: unknown; error: unknown }> }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from(table: string) {
      const call: Call = { table, ops: [] };
      state.calls.push(call);
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'order', 'maybeSingle', 'insert']) {
        q[m] = (...args: unknown[]) => { call.ops.push([m, args]); return q; };
      }
      q.then = (resolve: (v: unknown) => unknown) => resolve(state.results[table] ?? { data: [], error: null });
      return q;
    },
  },
}));

import { findManagedForbiddenWord, listManagedForbiddenWords } from '@/lib/forbidden-words-scope';
import { filterUserInput } from '@/lib/filter';

beforeEach(() => { state.calls = []; state.results = {}; });

const inArgs = (call: Call | undefined) => call?.ops.find(([m]) => m === 'in')?.[1];

describe('관리 범위', () => {
  it('목록은 관리 범위 부서의 금지어만 찾고 부서 이름을 붙인다', async () => {
    state.results.forbidden_words = { data: [{ id: 'w1', department_id: 'd2', word: '대외비', context: null, is_active: true, created_at: '2026-11-12' }], error: null };
    state.results.departments = { data: [{ id: 'd1', name: '본부' }, { id: 'd2', name: '총무팀' }], error: null };
    const listed = await listManagedForbiddenWords(['d1', 'd2']);
    expect(listed).toEqual({ rows: [expect.objectContaining({ id: 'w1', department_name: '총무팀' })] });
    const words = state.calls.find((c) => c.table === 'forbidden_words');
    expect(inArgs(words)).toEqual(['department_id', ['d1', 'd2']]);
  });
  it('관리 범위가 비었으면 아무것도 묻지 않는다(조건 없는 조회를 하지 않음)', async () => {
    expect(await listManagedForbiddenWords([])).toEqual({ rows: [] });
    expect(await findManagedForbiddenWord('w1', [])).toBeNull();
    expect(state.calls).toHaveLength(0);
  });
  it('목록 조회 실패는 오류로', async () => {
    state.results.forbidden_words = { data: null, error: { message: 'boom' } };
    expect(await listManagedForbiddenWords(['d1'])).toEqual({ error: 'boom' });
  });
  it('하나 찾기 — id와 관리 범위를 함께 걸고, 범위 밖(없음)은 null·실패는 error', async () => {
    state.results.forbidden_words = { data: null, error: null };
    expect(await findManagedForbiddenWord('w9', ['d1'])).toBeNull();
    const call = state.calls[0];
    expect(call.ops).toContainEqual(['eq', ['id', 'w9']]);
    expect(inArgs(call)).toEqual(['department_id', ['d1']]);
    state.results.forbidden_words = { data: null, error: { message: 'x' } };
    expect(await findManagedForbiddenWord('w9', ['d1'])).toBe('error');
  });
});

describe('대화 필터', () => {
  it('직원 부서 + 상위 부서의 켜진 금지어를 걸고, 같은 금지어는 한 번만', async () => {
    state.results.forbidden_words = { data: [{ word: '대외비' }, { word: '대외비' }], error: null };
    const r = await filterUserInput('team', '대외비 자료 정리', undefined, { departmentIds: ['team', 'hq'] });
    expect(r.isValid).toBe(false);
    expect(r.blockedWords).toEqual(['대외비']);
    const call = state.calls.find((c) => c.table === 'forbidden_words');
    expect(inArgs(call)).toEqual(['department_id', ['team', 'hq']]);
    expect(call?.ops).toContainEqual(['eq', ['is_active', true]]);
  });
  it('부서 목록을 주지 않으면 직원 부서 것만', async () => {
    await filterUserInput('team', '회의록 정리');
    expect(inArgs(state.calls.find((c) => c.table === 'forbidden_words'))).toEqual(['department_id', ['team']]);
  });
});

describe('연결(원본)', () => {
  it('목록 라우트는 관리 범위로만 읽는다 — 조건 없는 select가 다시 생기지 않게', () => {
    const route = readFileSync('src/app/api/forbidden-words/route.ts', 'utf8');
    expect(route).toContain('listManagedForbiddenWords(actor.managedDepartmentIds)');
    expect(route).not.toMatch(/from\('forbidden_words'\)\s*\.select\('\*'\)\s*\.order/);
  });
  it('켜고 끄기·지우기는 서비스 키로 관리 범위 안의 금지어를 찾는다', () => {
    const route = readFileSync('src/app/api/forbidden-words/[id]/route.ts', 'utf8');
    expect(route).not.toContain("from '@/lib/supabase'");
    expect(route.match(/findManagedForbiddenWord\(params\.id, actor\.managedDepartmentIds\)/g)).toHaveLength(2);
    expect(route.match(/isAdminSession\(session\)/g)).toHaveLength(2);
  });
  it('대화 준비가 상위 부서까지 넘긴다', () => {
    const prepare = readFileSync('src/lib/assistant/prepare.ts', 'utf8');
    expect(prepare).toContain('filterUserInput(actor.departmentId, message, undefined, { departmentIds: actor.visibleDepartmentIds })');
  });
});
