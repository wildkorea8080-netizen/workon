import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-18 — 기관 관리자가 직원의 **권한·부서·개인 월 한도**를 바꿔도(`PATCH /api/users/[id]`) 어디에도 남지 않았다
 * (직원을 관리자로 올려도 감사 화면에 흔적이 없음 — 슈퍼관리자의 같은 조작은 남았다). 이제 전후 값과 함께 보안 로그에.
 * 감사 화면 '보안 이벤트'는 이름표 열쇠가 실제 사건 종류와 달라 금지어·개인정보 감지가 코드 그대로 보였고,
 * 상세에 **대상이 누구인지**가 없었다.
 */

type Call = { table: string; ops: Array<[string, unknown[]]> };
const state: {
  session: unknown;
  calls: Call[];
  target: { data: unknown; error: unknown };
  updated: { data: unknown; error: unknown };
  names: { data: unknown; error: unknown };
  logs: Array<{ dept: unknown; user: unknown; type: string; details: Record<string, unknown>; severity: string }>;
} = { session: null, calls: [], target: { data: null, error: null }, updated: { data: null, error: null }, names: { data: [], error: null }, logs: [] };

vi.mock('@/lib/auth', () => ({
  getServerAuthSession: async () => state.session,
  isAdminSession: (s: { user?: { role?: string } } | null) => s?.user?.role === 'ADMIN',
}));
vi.mock('@/lib/department-scope', () => ({ getManagedDepartmentIds: async () => ['d1', 'd2'] }));
vi.mock('@/lib/security-log', () => ({
  logSecurityEvent: async (dept: unknown, user: unknown, type: string, details: Record<string, unknown>, severity: string) => {
    state.logs.push({ dept, user, type, details, severity });
    return true;
  },
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const call: Call = { table, ops: [] };
      state.calls.push(call);
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'is', 'in', 'update']) b[n] = (...args: unknown[]) => { call.ops.push([n, args]); return b; };
      b.maybeSingle = async () => state.target;
      b.single = async () => state.updated;
      b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(state.names).then(ok, bad);
      return b;
    },
  },
}));

import { PATCH } from '@/app/api/users/[id]/route';
import { securityDetailParts } from '@/lib/security-event-text';

const T = '11111111-1111-4111-8111-111111111111';
const req = (body: unknown) => ({ json: async () => body }) as never;
const patch = (body: unknown) => PATCH(req(body), { params: { id: T } });
const has = (c: Call, name: string, ...args: unknown[]) => c.ops.some(([n, a]) => n === name && JSON.stringify(a) === JSON.stringify(args));

beforeEach(() => {
  state.session = { user: { id: 'admin1', role: 'ADMIN', departmentId: 'd1' } };
  state.calls = [];
  state.logs = [];
  state.target = { data: { id: T, department_id: 'd1', role: 'USER', monthly_budget_krw: null }, error: null };
  state.updated = { data: { id: T, email: 'a@b.kr', full_name: '김직원', role: 'USER', department_id: 'd1', created_at: 'x', departments: { id: 'd1', name: '총무과' } }, error: null };
  state.names = { data: [{ id: 'd1', name: '총무과' }, { id: 'd2', name: '기획과' }], error: null };
});

describe('PATCH /api/users/[id] — 바꾼 것을 보안 로그에', () => {
  it('권한을 올리면 전후 값과 함께 high로 남김', async () => {
    const res = await patch({ role: 'admin' });
    expect(res.status).toBe(200);
    expect(state.logs).toEqual([
      { dept: 'd1', user: 'admin1', type: 'user_role_changed', details: { target_user_id: T, from_role: 'USER', to_role: 'ADMIN' }, severity: 'high' },
    ]);
  });

  it('같은 값으로 저장하면 남기지 않음', async () => {
    await patch({ role: 'USER', department_id: 'd1', monthly_budget_krw: null });
    expect(state.logs).toEqual([]);
  });

  it('부서를 옮기면 그때의 부서 이름과 함께', async () => {
    await patch({ department_id: 'd2' });
    expect(state.logs).toEqual([
      {
        dept: 'd1', user: 'admin1', type: 'user_department_changed', severity: 'medium',
        details: { target_user_id: T, from_department_id: 'd1', to_department_id: 'd2', from_department_name: '총무과', to_department_name: '기획과' },
      },
    ]);
  });

  it('부서 이름을 못 읽어도 id로 남김', async () => {
    state.names = { data: null, error: { code: 'XX000' } };
    await patch({ department_id: 'd2' });
    expect(state.logs[0].details).toMatchObject({ from_department_id: 'd1', to_department_id: 'd2', from_department_name: null, to_department_name: null });
  });

  it('개인 월 한도 — 정하기·비우기 모두, 0은 비우기', async () => {
    await patch({ monthly_budget_krw: 50000 });
    state.target = { data: { id: T, department_id: 'd1', role: 'USER', monthly_budget_krw: 50000 }, error: null };
    await patch({ monthly_budget_krw: 0 });
    await patch({ monthly_budget_krw: '50000' });
    expect(state.logs.map((l) => [l.type, l.details.from_budget_krw, l.details.to_budget_krw, l.severity])).toEqual([
      ['user_budget_changed', null, 50000, 'medium'],
      ['user_budget_changed', 50000, null, 'medium'],
    ]);
  });

  it('너무 큰 한도는 DB 오류 대신 400', async () => {
    const res = await patch({ monthly_budget_krw: 1e12 });
    expect(res.status).toBe(400);
    expect(state.calls.some((c) => c.ops.some(([n]) => n === 'update'))).toBe(false);
  });

  it('대리 접근 중에는 권한을 못 바꿈 — 한도는 되고 표시가 남음', async () => {
    state.session = { user: { id: 'admin1', role: 'ADMIN', departmentId: 'd1', isImpersonating: true } };
    const res = await patch({ role: 'ADMIN' });
    expect(res.status).toBe(403);
    expect(state.calls.some((c) => c.ops.some(([n]) => n === 'update'))).toBe(false);
    expect(state.logs).toEqual([]);

    await patch({ monthly_budget_krw: 30000 });
    expect(state.logs[0]).toMatchObject({ type: 'user_budget_changed', details: { target_user_id: T, impersonating: true, to_budget_krw: 30000 } });
  });

  it('슈퍼관리자·탈퇴 계정은 대상이 아니고, 대상을 못 읽으면 500', async () => {
    await patch({ role: 'ADMIN' });
    const read = state.calls[0];
    expect(read.table).toBe('users');
    expect(has(read, 'eq', 'is_super_admin', false)).toBe(true);
    expect(has(read, 'is', 'deleted_at', null)).toBe(true);

    state.target = { data: null, error: { code: 'XX000' } };
    expect((await patch({ role: 'ADMIN' })).status).toBe(500);
    state.target = { data: null, error: null };
    expect((await patch({ role: 'ADMIN' })).status).toBe(403);
  });

  it('저장에 실패하면 남기지 않음', async () => {
    state.updated = { data: null, error: { code: '23514' } };
    expect((await patch({ role: 'ADMIN' })).status).toBe(500);
    expect(state.logs).toEqual([]);
  });
});

describe('securityDetailParts — 감사 화면 상세', () => {
  const nameOf = (id: string) => (id === T ? '김직원' : null);
  it('대상 이름·사유', () => {
    expect(securityDetailParts({ target_user_id: T, reason: '퇴직' }, nameOf)).toEqual(['대상: 김직원', '사유: 퇴직']);
  });
  it('관리 범위 밖 사람의 이름은 내보내지 않음', () => {
    expect(securityDetailParts({ target_user_id: '22222222-2222-4222-8222-222222222222' }, nameOf)).toEqual(['대상: (관리 범위 밖이거나 삭제된 계정)']);
  });
  it('원문 열람의 대상 "(전체)"는 그대로', () => {
    expect(securityDetailParts({ target_user_id: '(전체)', reason: '감사 요청 자료 제출' }, nameOf)).toEqual(['대상: (전체)', '사유: 감사 요청 자료 제출']);
  });
  it('권한·부서·한도의 전후 값', () => {
    expect(securityDetailParts({ target_user_id: T, from_role: 'USER', to_role: 'ADMIN' }, nameOf)).toEqual(['대상: 김직원', '권한: 일반 직원 → 관리자']);
    expect(securityDetailParts({ from_department_id: 'd1', to_department_id: 'd2', from_department_name: '총무과', to_department_name: null }, nameOf)).toEqual(['부서: 총무과 → (이름 모름)']);
    expect(securityDetailParts({ from_budget_krw: null, to_budget_krw: 50000, impersonating: true }, nameOf)).toEqual(['개인 월 한도: 부서 기본값 → 50,000원', '대리 접근 중']);
  });
  it('탐지어는 보이고 질문 글·패턴 원문은 싣지 않음', () => {
    expect(securityDetailParts({ word: '기밀', context: '기밀 문서를 요약해 줘' }, nameOf)).toEqual(['탐지어: 기밀']);
    // 몇 곳인지만 보인다(2026-11-18 batch-0170) — 규칙 원문(정규식)은 여전히 싣지 않는다
    expect(securityDetailParts({ pattern: '\\d{6}-\\d{7}', matches: 1 }, nameOf)).toEqual(['개인정보 꼴 1곳']);
  });
  it('줄바꿈·긴 사유는 다듬고, 이상한 값은 빈 목록', () => {
    expect(securityDetailParts({ reason: `퇴직\n${'가'.repeat(200)}` }, nameOf)[0]).toHaveLength('사유: '.length + 100);
    expect(securityDetailParts(null, nameOf)).toEqual([]);
    expect(securityDetailParts('x', nameOf)).toEqual([]);
  });
});

describe('원본', () => {
  const audit = readFileSync('src/app/api/admin/audit-logs/route.ts', 'utf8');
  const types = readFileSync('src/lib/security-log.ts', 'utf8');

  it('남는 보안 사건 종류마다 감사 화면 이름표가 있음 — 코드가 그대로 보이지 않게', () => {
    const union = types.slice(types.indexOf('export type SecurityEventType'), types.indexOf('export type SecuritySeverity'));
    const events = [...union.matchAll(/\|\s*'([a-z_]+)'|=\s*\n?\s*'([a-z_]+)'/g)].map((m) => m[1] ?? m[2]);
    expect(events.length).toBeGreaterThan(30);
    const text = readFileSync('src/lib/security-event-text.ts', 'utf8');
    const labels = text.slice(text.indexOf('export const SECURITY_EVENT_LABELS'), text.indexOf('export const SECURITY_SEVERITY_LABELS'));
    for (const e of events) expect(labels, e).toMatch(new RegExp(`\\n\\s+${e}: '`));
    // 어느 기록과도 맞지 않던 옛 열쇠
    expect(labels).not.toMatch(/\n\s+(forbidden_word|personal_info|blocked_upload|rate_limit): '/);
  });

  it('감사 화면 상세가 대상·사유를 싣는 함수를 씀', () => {
    expect(audit).toContain("...securityDetailParts(details, (id) => memberMap.get(id)?.name ?? null)");
    expect(readFileSync('src/lib/security-event-text.ts', 'utf8')).toContain("user_role_changed: '직원 권한 바꾸기(관리자)'");
  });

  it('상세 함수는 잎 파일', () => {
    expect(readFileSync('src/lib/security-event-text.ts', 'utf8')).not.toMatch(/^import /m);
  });
});
