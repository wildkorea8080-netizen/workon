import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 슈퍼관리자 추가가 이미 있는 계정을 덮어쓰지 않게.
 * 예전: 등록 여부를 못 읽으면 '없음' → 같은 이메일의 Auth 계정 비밀번호를 바꾸고 → users를 upsert(id 기준)해
 * 그 이메일이 직원이면 직원 행이 슈퍼관리자로 덮였다. Auth 찾기는 첫 1,000명만, 비밀번호 바꾸기 실패는 안 봄,
 * users 쓰기가 실패하면 만든 Auth 계정이 남았다.
 */

type Op = [string, unknown[]];
const state = {
  admin: { sub: 'a1' } as unknown,
  usersRead: { data: [] as unknown[], error: null as unknown },
  insert: { data: { id: 'au1', email: 'new@x.kr', full_name: '새 관리자' } as unknown, error: null as unknown },
  authPages: [[]] as Array<Array<{ id: string; email: string }>>,
  listError: null as unknown,
  updateError: null as unknown,
  createResult: { data: { user: { id: 'au1' } }, error: null } as { data: { user: { id: string } | null }; error: unknown },
  ops: [] as Op[],
  auth: [] as Op[],
};

vi.mock('@/lib/super-auth', () => ({ getSuperAdminFromRequest: () => state.admin }));
vi.mock('@/lib/audit-write', () => ({ writeAuditRow: async () => true }));
vi.mock('@/lib/sign-in-throttle', () => ({ accountLocks: async () => new Map(), lockReadDeps: () => ({}) }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'limit', 'insert', 'upsert', 'order']) b[n] = (...args: unknown[]) => { state.ops.push([`${table}.${n}`, args]); return b; };
      b.single = async () => state.insert;
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(state.usersRead).then(res);
      return b;
    },
    auth: {
      admin: {
        listUsers: async (args: { page: number }) => {
          state.auth.push(['listUsers', [args]]);
          if (state.listError) return { data: null, error: state.listError };
          return { data: { users: state.authPages[args.page - 1] ?? [] }, error: null };
        },
        updateUserById: async (...args: unknown[]) => { state.auth.push(['updateUserById', args]); return { data: {}, error: state.updateError }; },
        createUser: async (...args: unknown[]) => { state.auth.push(['createUser', args]); return state.createResult; },
        deleteUser: async (...args: unknown[]) => { state.auth.push(['deleteUser', args]); return { error: null }; },
      },
    },
  },
}));

import { findAuthUserByEmail, parseSuperAdminInput } from '@/lib/super-admin-create';
import { POST } from '@/app/api/super/accounts/super-admins/route';

const post = (body: unknown) => POST(new Request('http://x/api/super/accounts/super-admins', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
}) as never);
const authCalls = (n: string) => state.auth.filter(([k]) => k === n);

beforeEach(() => {
  state.admin = { sub: 'a1' };
  state.usersRead = { data: [], error: null };
  state.insert = { data: { id: 'au1', email: 'new@x.kr', full_name: '새 관리자' }, error: null };
  state.authPages = [[]];
  state.listError = null;
  state.updateError = null;
  state.createResult = { data: { user: { id: 'au1' } }, error: null };
  state.ops = [];
  state.auth = [];
});

describe('parseSuperAdminInput', () => {
  it('이름 다듬기·이메일 소문자', () => {
    expect(parseSuperAdminInput({ name: '  홍​길동 \n', email: ' New@X.kr ' })).toEqual({ ok: true, name: '홍 길동', email: 'new@x.kr' });
  });
  it('빈 이름·긴 이름·틀린 이메일·깨진 요청은 거절', () => {
    expect(parseSuperAdminInput({ name: ' ', email: 'a@b.kr' }).ok).toBe(false);
    expect(parseSuperAdminInput({ name: 'a'.repeat(51), email: 'a@b.kr' }).ok).toBe(false);
    expect(parseSuperAdminInput({ name: '가', email: 'ab.kr' }).ok).toBe(false);
    expect(parseSuperAdminInput({ name: 1, email: 'a@b.kr' }).ok).toBe(false);
    expect(parseSuperAdminInput(null).ok).toBe(false);
  });
});

describe('findAuthUserByEmail', () => {
  const full = (p: number) => Array.from({ length: 1000 }, (_, i) => ({ id: `p${p}-${i}`, email: `u${p}-${i}@x.kr` }));
  it('첫 1,000명 뒤의 계정도 찾는다(대소문자 무시)', async () => {
    const pages = [full(1), [{ id: 'hit', email: 'Boss@X.kr' }]];
    expect(await findAuthUserByEmail('boss@x.kr', async ({ page }) => ({ data: { users: pages[page - 1] ?? [] }, error: null }))).toBe('hit');
  });
  it('끝까지 없으면 null, 못 읽으면 undefined', async () => {
    expect(await findAuthUserByEmail('no@x.kr', async ({ page }) => ({ data: { users: page === 1 ? full(1) : [] }, error: null }))).toBeNull();
    expect(await findAuthUserByEmail('no@x.kr', async () => ({ data: null, error: { message: 'down' } }))).toBeUndefined();
    expect(await findAuthUserByEmail('no@x.kr', async () => { throw new Error('net'); })).toBeUndefined();
  });
});

describe('POST /api/super/accounts/super-admins', () => {
  const body = { name: '새 관리자', email: 'new@x.kr' };

  it('틀린 입력은 400 — DB·Auth를 부르지 않음', async () => {
    for (const b of [{ name: '', email: 'new@x.kr' }, { name: '가', email: 'x' }, '{깨짐']) {
      state.ops = []; state.auth = [];
      expect((await post(b)).status).toBe(400);
      expect(state.ops).toHaveLength(0);
      expect(state.auth).toHaveLength(0);
    }
  });

  it('등록 여부를 못 읽으면 503 — Auth 비밀번호를 바꾸지 않는다', async () => {
    state.usersRead = { data: null as never, error: { code: 'XX000' } };
    state.authPages = [[{ id: 'emp1', email: 'new@x.kr' }]];
    expect((await post(body)).status).toBe(503);
    expect(state.auth).toHaveLength(0);
  });

  it('이미 있는 이메일은 409 — Auth를 건드리지 않는다', async () => {
    state.usersRead = { data: [{ id: 'emp1' }], error: null };
    expect((await post(body)).status).toBe(409);
    expect(state.auth).toHaveLength(0);
  });

  it('Auth를 못 읽으면 503, 비밀번호 바꾸기가 실패하면 503 — users에 쓰지 않음', async () => {
    state.listError = { message: 'down' };
    expect((await post(body)).status).toBe(503);
    state.listError = null;
    state.authPages = [[{ id: 'au9', email: 'new@x.kr' }]];
    state.updateError = { message: 'nope' };
    expect((await post(body)).status).toBe(503);
    expect(state.ops.some(([k]) => k === 'users.insert' || k === 'users.upsert')).toBe(false);
  });

  it('users 행은 insert로만(upsert로 덮지 않음)', async () => {
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(state.ops.some(([k]) => k === 'users.upsert')).toBe(false);
    const ins = state.ops.find(([k]) => k === 'users.insert')!;
    expect(ins[1][0]).toMatchObject({ id: 'au1', email: 'new@x.kr', is_super_admin: true, password_must_change: true });
    const d = await res.json();
    expect(d.data.tempPassword).toEqual(expect.any(String));
  });

  it('users 쓰기가 실패하면 이번에 만든 Auth 계정을 지운다 · 겹침은 409', async () => {
    state.insert = { data: null, error: { code: '23505' } };
    expect((await post(body)).status).toBe(409);
    expect(authCalls('deleteUser')).toHaveLength(1);
  });

  it('있던 Auth 계정을 쓴 경우는 실패해도 지우지 않는다', async () => {
    state.authPages = [[{ id: 'au9', email: 'new@x.kr' }]];
    state.insert = { data: null, error: { code: 'XX000' } };
    expect((await post(body)).status).toBe(500);
    expect(authCalls('deleteUser')).toHaveLength(0);
    expect(authCalls('createUser')).toHaveLength(0);
  });
});

describe('원본 확인', () => {
  it('설정 라우트도 쪽마다 찾고 비밀번호 바꾸기 실패를 본다', () => {
    const src = readFileSync('src/app/api/super/auth/setup/route.ts', 'utf8');
    expect(src).toContain('findAuthUserByEmail(normalizedEmail)');
    expect(src).not.toContain('perPage: 1000');
    expect(src).toContain('if (pwError)');
  });
  it('추가 창은 응답을 보고 저장 중 표시를 늘 푼다', () => {
    const src = readFileSync('src/app/super/accounts/page.tsx', 'utf8');
    const h = src.slice(src.indexOf('function AddSuperAdminModal'), src.indexOf('return (', src.indexOf('function AddSuperAdminModal')));
    // 0264부터 requestJson(2xx이고 몸이 ok일 때만 ok, 던지지 않음) — 저장 중 표시는 언제나 푼다
    expect(h).toContain('const r = await requestJson(');
    expect(h).toContain('setSaving(false);');
    expect(h).toContain('if (r.ok) onCreated(r.body.data);');
  });
});
