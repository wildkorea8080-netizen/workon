import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-20 — 초대를 차지하다 DB가 실패한 것을 '이미 사용됐거나 만료된 초대'로 답하지 않는다.
 * 가입(`/api/signup`·`/api/register`)은 계정을 만들기 전에 초대를 조건부로 차지한다(안 썼고 만료 전일 때만).
 * 예전엔 그 쓰기가 DB 오류로 실패해도 '차지하지 못함'(null)이라 '이미 사용됐거나 만료된 초대 링크입니다'(400)로 답했다 —
 * 가입하려던 사람은 멀쩡한 초대가 죽은 줄 알고 관리자에게 새 초대를 요청한다.
 * 이제 DB 오류는 `InvitationClaimError` → 503 '지금 확인하지 못했습니다'. 정말 썼거나 만료면 예전처럼 400.
 */

const state = vi.hoisted(() => ({ result: { data: null as unknown, error: null as unknown } }));

vi.mock('@/lib/logger', () => ({ logSystem: vi.fn() }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: () => {
      const b: Record<string, unknown> = {};
      for (const n of ['update', 'eq', 'is', 'gt', 'select']) b[n] = () => b;
      b.maybeSingle = async () => state.result;
      return b;
    },
  },
}));

import { claimInvitation, isInvitationClaimError, INVITATION_CLAIM_UNAVAILABLE } from '@/lib/invitation-claim';

beforeEach(() => { state.result = { data: null, error: null }; });

describe('claimInvitation', () => {
  const now = Date.parse('2026-11-20T03:00:00Z');
  it('차지했으면 그 시각', async () => {
    state.result = { data: { id: 'i1' }, error: null };
    expect(await claimInvitation('i1', now)).toBe('2026-11-20T03:00:00.000Z');
  });
  it('이미 썼거나 만료면(바뀐 행 없음) null', async () => {
    expect(await claimInvitation('i1', now)).toBeNull();
  });
  it('DB 오류면 던진다 — null(이미 사용됨)로 넘기지 않는다', async () => {
    state.result = { data: null, error: { code: '57014', message: 'timeout' } };
    const err = await claimInvitation('i1', now).catch((e) => e);
    expect(isInvitationClaimError(err)).toBe(true);
    expect(err.code).toBe('57014');
  });
});

describe('가입 라우트 (원본)', () => {
  const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

  for (const [path, call] of [['src/app/api/signup/route.ts', 'claimInvitation(inv.id)'], ['src/app/api/register/route.ts', 'claimInvitation(invitation.id)']] as const) {
    it(`${path} — 차지 실패(DB)는 503, 이미 사용됨은 400`, () => {
      const src = read(path);
      const at = src.indexOf(call);
      const block = src.slice(at, at + 900);
      expect(block).toContain('if (isInvitationClaimError(claimError)) {');
      expect(block).toContain('INVITATION_CLAIM_UNAVAILABLE');
      expect(block).toContain('{ status: 503 }');
      // 그 뒤에야 '이미 사용됨'
      expect(block.indexOf("'이미 사용됐거나 만료된 초대 링크입니다.'")).toBeGreaterThan(block.indexOf('{ status: 503 }'));
      // 모르는 오류는 삼키지 않는다
      expect(block).toContain('throw claimError;');
    });
  }

  it('안내 문구', () => {
    expect(INVITATION_CLAIM_UNAVAILABLE).toBe('초대를 지금 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
  });
});
