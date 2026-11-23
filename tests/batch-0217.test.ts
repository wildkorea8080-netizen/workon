import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-20 — 접속 차단 기록(`POST /api/access-denied`)이 소속·허용 IP를 못 읽으면 '기록할 것 없음'으로 끝내지 않는다.
 * 차단 화면이 이 라우트를 불러 `security_logs`에 `ip_blocked`를 남긴다(감사에서 "누가 언제 어디서 막혔는가").
 * 예전엔 사용자·부서·기관 읽기 실패가 모두 `{ ok: true, logged: false }`라, 차단된 접속이 감사 기록에서 빠져도 흔적이 없었다.
 * 이제 운영 기록(error·security — 단계·오류 코드만)에 남기고 503.
 */

const state = vi.hoisted(() => ({
  session: { user: { id: 'u1', departmentId: 'd1' as string | undefined } },
  errors: {} as Record<string, unknown>,
  allowed: ['203.0.113.0/24'] as string[] | null,
  security: [] as unknown[][],
  system: [] as Array<{ message: string; details: Record<string, unknown> }>,
}));

vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => state.session }));
vi.mock('@/lib/security-log', () => ({ logSecurityEvent: async (...a: unknown[]) => { state.security.push(a); return true; } }));
vi.mock('@/lib/logger', () => ({ logSystem: async (p: { message: string; details: Record<string, unknown> }) => { state.system.push(p); } }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq']) b[n] = () => b;
      b.maybeSingle = async () => {
        if (state.errors[table]) return { data: null, error: state.errors[table] };
        if (table === 'users') return { data: { department_id: 'd1' }, error: null };
        if (table === 'departments') return { data: { organization_id: 'o1' }, error: null };
        return { data: { allowed_ips: state.allowed }, error: null };
      };
      return b;
    },
  },
}));

import { POST } from '@/app/api/access-denied/route';

const call = () => POST(new NextRequest('http://x/api/access-denied', { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.7' } }));
const BOOM = { code: 'XX000', message: 'boom' };

beforeEach(() => {
  state.session = { user: { id: 'u1', departmentId: 'd1' } };
  state.errors = {}; state.allowed = ['203.0.113.0/24']; state.security = []; state.system = [];
});

describe('접속 차단 기록', () => {
  it('막힌 접속은 보안 로그에 남긴다', async () => {
    const res = await call();
    expect(await res.json()).toMatchObject({ ok: true, data: { logged: true } });
    expect(state.security).toHaveLength(1);
    expect(state.security[0][2]).toBe('ip_blocked');
  });
  it('허용 목록이 없는 기관은 남기지 않는다(예전과 같음)', async () => {
    state.allowed = null;
    expect(await (await call()).json()).toMatchObject({ ok: true, data: { logged: false } });
    expect(state.system).toEqual([]);
  });
  for (const [table, stage] of [['departments', 'department'], ['organizations', 'organization']] as const) {
    it(`${table}를 못 읽으면 503 + 운영 기록`, async () => {
      state.errors[table] = BOOM;
      const res = await call();
      expect(res.status).toBe(503);
      expect(state.security).toEqual([]);
      expect(state.system).toHaveLength(1);
      expect(state.system[0].details).toMatchObject({ stage, code: 'XX000' });
    });
  }
  it('세션에 부서가 없는데 사용자를 못 읽으면 503 + 운영 기록', async () => {
    state.session.user.departmentId = undefined;
    state.errors.users = BOOM;
    expect((await call()).status).toBe(503);
    expect(state.system[0].details).toMatchObject({ stage: 'user' });
  });
  it('운영 기록에 IP·허용 목록을 싣지 않는다', async () => {
    state.errors.organizations = BOOM;
    await call();
    expect(JSON.stringify(state.system)).not.toContain('198.51.100.7');
    expect(JSON.stringify(state.system)).not.toContain('203.0.113');
  });
});
