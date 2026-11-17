import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));

import { SEAT_LIMIT_CODE, SEAT_UNKNOWN_CODE, SEAT_UNLIMITED, checkUserSeats, seatErrorBody, seatLimitOf, type SeatDeps } from '@/lib/user-seats';

/**
 * 2026-11-17 — 기관의 사용자 수 상한(`organizations.max_users`)을 실제로 지킨다. 예전엔 슈퍼관리자 화면에 '4 / 20명'으로 보이기만 하고
 * 관리자 등록·일괄 등록·초대 가입·다시 사용 어디서도 막지 않았다.
 */

const deps = (maxUsers: unknown, used: number | Error, org: 'ok' | 'none' | 'throw' = 'ok'): SeatDeps & { counted: string[] } => {
  const counted: string[] = [];
  return {
    counted,
    orgOfDepartment: async () => {
      if (org === 'throw') throw { code: '500' };
      return org === 'none' ? null : { organizationId: 'org-1', maxUsers };
    },
    activeUsers: async (id) => { counted.push(id); if (used instanceof Error) throw used; return used; },
  };
};

describe('상한 값', () => {
  it('없음·0·음수·999,999 이상·숫자 아님은 무제한, 그 밖은 정수', () => {
    for (const v of [null, undefined, 0, -3, SEAT_UNLIMITED, 10_000_000, 'abc', NaN]) expect(seatLimitOf(v)).toBeNull();
    expect(seatLimitOf(20)).toBe(20);
    expect(seatLimitOf('5')).toBe(5);
    expect(seatLimitOf(7.9)).toBe(7);
  });
});

describe('자리 세기', () => {
  it('남은 자리 안이면 받음, 넘으면 403 SEAT_LIMIT(상한·쓴 수와 함께)', async () => {
    expect(await checkUserSeats('dept', 1, deps(20, 19))).toEqual({ ok: true, used: 19, limit: 20, remaining: 1 });
    const over = await checkUserSeats('dept', 1, deps(20, 20));
    expect(over).toMatchObject({ ok: false, status: 403, code: SEAT_LIMIT_CODE, used: 20, limit: 20 });
    expect(over.ok ? '' : over.message).toContain('20명');
    expect(await checkUserSeats('dept', 3, deps(20, 18))).toMatchObject({ ok: false, code: SEAT_LIMIT_CODE });
  });
  it('이미 넘은 기관(상한을 낮춘 뒤)은 남은 자리 0 — 음수가 아님', async () => {
    expect(await checkUserSeats('dept', 0, deps(5, 9))).toEqual({ ok: true, used: 9, limit: 5, remaining: 0 });
  });
  it('무제한이면 세지도 않음', async () => {
    const d = deps(null, 1000);
    expect(await checkUserSeats('dept', 50, d)).toEqual({ ok: true, used: 0, limit: null, remaining: null });
    expect(d.counted).toEqual([]);
  });
  it('부서·기관을 모르거나 못 읽거나 못 세면 503 SEAT_UNKNOWN(닫힘) — 던지지 않음', async () => {
    for (const d of [deps(20, 1, 'none'), deps(20, 1, 'throw'), deps(20, new Error('x'))]) {
      expect(await checkUserSeats('dept', 1, d)).toMatchObject({ ok: false, status: 503, code: SEAT_UNKNOWN_CODE });
    }
  });
  it('응답 몸', async () => {
    const r = await checkUserSeats('dept', 1, deps(2, 2));
    if (r.ok) throw new Error('expected fail');
    expect(seatErrorBody(r)).toEqual({ ok: false, error: { message: r.message, code: SEAT_LIMIT_CODE } });
  });
});

describe('계정을 만드는 네 길이 만들기 전에 센다(원본)', () => {
  const src = (p: string) => readFileSync(p, 'utf8');
  const before = (s: string, a: string, b: string) => {
    expect(s).toContain(a);
    expect(s).toContain(b);
    expect(s.indexOf(a)).toBeLessThan(s.indexOf(b));
  };
  it('관리자 등록 — 만들기 전에, 역할은 USER·ADMIN만, 오류 원문을 내보내지 않음', () => {
    const s = src('src/app/api/users/route.ts');
    before(s, 'checkUserSeats(departmentId, 1)', ".from('users')\n      .insert(");
    expect(s).toContain("role !== 'USER' && role !== 'ADMIN'");
    expect(s).not.toContain('details: error');
  });
  it('일괄 등록 — 500명 상한, 남은 자리만큼만, 못 세면 아무것도 안 만듦', () => {
    const s = src('src/app/api/admin/bulk-register/route.ts');
    expect(s).toContain('const MAX_BULK_ROWS = 500;');
    before(s, 'checkUserSeats(adminDeptId, 0)', 'for (let i = 0; i < rows.length; i++)');
    before(s, 'if (seatsLeft !== null && seatsLeft <= 0)', 'auth.admin.createUser(');
    expect(s).toContain('if (seatsLeft !== null) seatsLeft -= 1;');
  });
  it('초대 가입 두 곳 — 초대를 차지하기 전에(상한이면 초대가 남음)', () => {
    before(src('src/app/api/register/route.ts'), 'checkUserSeats(invitation.department_id, 1)', 'await claimInvitation(invitation.id)');
    const s = src('src/app/api/signup/route.ts');
    before(s, 'checkUserSeats(inv.department_id, 1)', 'await claimInvitation(inv.id)');
    // 도메인 가입 — 기관을 찾은 뒤, users 행을 만들기 전에(넘으면 만든 Auth 계정을 지운다)
    before(s, 'const seats = await checkUserSeats(departmentId, 1);', 'await createUserRecord(');
  });
  it('기관 관리자의 다시 사용 — 꺼진 계정을 켤 때만', () => {
    const s = src('src/app/api/users/[id]/active/route.ts');
    expect(s).toContain('if (body.active && !target.is_active) {');
    before(s, 'checkUserSeats(target.department_id, 1)', ".update(body.active ? { is_active: true");
  });
  it('세는 것은 그 기관 부서의 활성·탈퇴 안 한 계정', () => {
    const s = src('src/lib/user-seats.ts');
    expect(s).toContain(".select('id, departments!inner(organization_id)', { count: 'exact', head: true })");
    expect(s).toContain(".eq('departments.organization_id', organizationId)");
    expect(s).toContain(".eq('is_active', true)");
    expect(s).toContain(".is('deleted_at', null)");
  });
});
