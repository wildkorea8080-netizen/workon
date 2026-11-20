import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 소속을 못 읽으면 503(빈 500·'소속 없음' 403이 아니라).
 * 0193부터 `getActorScope`는 사용자·부서 읽기 실패를 던진다. try 밖에서 부르는 처리기 서른여덟은 그 오류가 처리기 밖으로 빠져
 * 몸 없는 500이었고, `.catch(() => null)`로 받던 아홉은 읽기 실패를 다시 '소속을 확인할 수 없습니다'(403)로 답했다.
 * 이제 `actorScopeOr503`(`src/lib/actor-scope-response.ts`)로 받는다.
 */

class ActorScopeReadError extends Error {
  constructor() { super('x'); this.name = 'ActorScopeReadError'; }
}
const state = { mode: 'ok' as 'ok' | 'none' | 'read' | 'other' };

vi.mock('@/lib/actor-scope', () => ({
  getActorScope: vi.fn(async () => {
    if (state.mode === 'read') throw new ActorScopeReadError();
    if (state.mode === 'other') throw new Error('boom');
    if (state.mode === 'none') return null;
    return { userId: 'u1', organizationId: 'o1', departmentId: 'd1', visibleDepartmentIds: ['d1'], managedDepartmentIds: [], isAdmin: false };
  }),
}));
vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => ({ user: { id: 'u1', departmentId: 'd1' } }), isAdminSession: () => false }));

import { actorScopeOr503 } from '@/lib/actor-scope-response';
import { GET as historyGET } from '@/app/api/apps/history/route';
import { GET as approvalsGET } from '@/app/api/apps/outbound-approvals/route';

beforeEach(() => { state.mode = 'ok'; });

describe('actorScopeOr503', () => {
  const session = { user: { id: 'u1' } } as never;
  it('읽으면 범위, 소속이 없으면 null', async () => {
    expect(await actorScopeOr503(session)).toMatchObject({ organizationId: 'o1' });
    state.mode = 'none';
    expect(await actorScopeOr503(session)).toBeNull();
  });
  it('못 읽으면 503 응답', async () => {
    state.mode = 'read';
    const res = await actorScopeOr503(session);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(503);
    expect(await (res as Response).json()).toMatchObject({ ok: false, error: { message: expect.stringContaining('확인하지 못했습니다') } });
  });
  it('그 밖의 오류는 그대로 던짐', async () => {
    state.mode = 'other';
    await expect(actorScopeOr503(session)).rejects.toThrow('boom');
  });
});

describe('라우트', () => {
  it('앱 실행 기록: 못 읽으면 빈 500이 아니라 503', async () => {
    state.mode = 'read';
    expect((await historyGET(new Request('http://x/api/apps/history') as never)).status).toBe(503);
  });
  it('보내기 전 확인 목록: 예전 .catch(() => null)이던 곳 — 403이 아니라 503', async () => {
    state.mode = 'read';
    expect((await approvalsGET(new Request('http://x/api/apps/outbound-approvals?agent=a') as never)).status).toBe(503);
  });
});

describe('원본 확인 — try 밖에서 getActorScope를 부르는 처리기가 없다', () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n === 'route.ts') files.push(p);
    }
  };
  walk(join('src', 'app', 'api'));

  it('읽기 실패를 null로 삼키지 않는다', () => {
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/getActorScope\([^)]*\)\.catch\(\(\) => null\)/);
  });
  it('처리기마다 getActorScope가 try 안에 있거나 오류를 따로 받는다', () => {
    const bad: string[] = [];
    for (const f of files) {
      const s = readFileSync(f, 'utf8');
      const re = /export async function (GET|POST|PUT|PATCH|DELETE)\b/g;
      const starts: number[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) starts.push(m.index);
      starts.forEach((i, k) => {
        const body = s.slice(i, starts[k + 1] ?? s.length);
        const g = body.search(/getActorScope\(/);
        if (g < 0) return;
        const t = body.search(/\btry\s*\{/);
        const handled = /getActorScope\([^)]*\)\.catch\(\(err\)/.test(body) || /handleWork\(/.test(body.slice(0, g));
        if ((t < 0 || t > g) && !handled) bad.push(f);
      });
    }
    expect(bad).toEqual([]);
  });
});
