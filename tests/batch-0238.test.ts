import { readFileSync } from 'fs';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-20 — 링크를 처음 열 때 DB를 못 읽은 것을 '유효하지 않은 링크·찾을 수 없음'으로 답하지 않는다.
 * ① 초대 링크 확인(`GET /api/register/validate-token`): `.single()`이라 읽기 실패도 '유효하지 않은 초대 링크입니다'(404)였다.
 *    가입 화면은 이 답을 그대로 보이고 입력 칸을 닫는다 — 멀쩡한 초대가 죽은 줄 알게 된다(가입 자체 `/api/register`는 2026-11-19에 고쳤다).
 * ② 공개 공유 링크(`GET /api/shared/[token]`): 대화·주인 읽기 실패도 '공유된 대화를 찾을 수 없습니다'(404) — 링크를 받은 사람이
 *    공유가 취소된 줄 알았다. 이제 503 '지금 열지 못했습니다'(열지는 않는다 — 닫힘은 그대로).
 */

const state = vi.hoisted(() => ({ result: { data: null as unknown, error: null as unknown } }));

vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: () => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq']) b[n] = () => b;
      b.maybeSingle = async () => state.result;
      b.single = async () => (state.result.data ? state.result : { data: null, error: state.result.error ?? { code: 'PGRST116' } });
      return b;
    },
  },
}));

import { GET as validate } from '@/app/api/register/validate-token/route';
import { SIGNUP_READ_FAILED_MESSAGE } from '@/lib/signup-org';

beforeEach(() => { state.result = { data: null, error: null }; });

const call = async () => {
  const res = await validate(new NextRequest('http://x/api/register/validate-token?token=abc'));
  return { status: res.status, body: await res.json() };
};

describe('초대 링크 확인', () => {
  it('못 읽으면 503 — 유효하지 않은 링크라고 하지 않는다', async () => {
    state.result = { data: null, error: { code: '57014', message: 'timeout' } };
    const out = await call();
    expect(out.status).toBe(503);
    expect(out.body.error.message).toBe(SIGNUP_READ_FAILED_MESSAGE);
  });
  it('정말 없으면 예전처럼 404 유효하지 않은 초대 링크', async () => {
    const out = await call();
    expect(out.status).toBe(404);
    expect(out.body.error.message).toBe('유효하지 않은 초대 링크입니다.');
  });
  it('쓸 수 있는 초대면 그 정보', async () => {
    state.result = { data: { id: 'i1', email: 'kim@org.go.kr', department_id: 'd1', role: 'USER', expires_at: '2999-01-01T00:00:00Z', accepted_at: null }, error: null };
    const out = await call();
    expect(out.status).toBe(200);
    expect(out.body.data).toMatchObject({ valid: true, email: 'kim@org.go.kr' });
  });
});

describe('가입 화면 (원본)', () => {
  it('몸을 못 읽은 응답도 정해 둔 안내로 — 유효하지 않다고 단정하지 않는다', () => {
    const src = readFileSync('src/app/register/page.tsx', 'utf8').replace(/\r\n/g, '\n');
    expect(src).toContain('.then(r => r.json().catch(() => null))');
    expect(src).toContain("setTokenError(result?.error?.message || '초대 링크를 지금 확인하지 못했습니다. 잠시 뒤 다시 열어 주세요.');");
  });
});

describe('공개 공유 링크 (원본)', () => {
  const src = readFileSync('src/app/api/shared/[token]/route.ts', 'utf8').replace(/\r\n/g, '\n');
  it('대화·주인을 못 읽으면 503, 정말 없을 때만 404', () => {
    expect(src).toContain('if (error) return UNREAD();');
    expect(src).toContain('if (!conversation) return NOT_FOUND();');
    expect(src).toContain('if (ownerError) return UNREAD();');
    expect(src).toContain('if (!owner) return NOT_FOUND();');
    expect(src).not.toContain('if (error || !conversation)');
    expect(src).not.toContain('if (ownerError || !owner)');
    expect(src).toContain("'공유된 대화를 지금 열지 못했습니다. 잠시 뒤 다시 열어 주세요.' } }, { status: 503 })");
  });
});
