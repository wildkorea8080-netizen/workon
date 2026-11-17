import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));

import { SEAT_NEAR_PERCENT, seatAlerts } from '@/lib/user-seats';

/**
 * 2026-11-17 — 사용자 수 상한에 닿았거나 가까운 기관을 슈퍼관리자 대시보드가 띠로 알린다. 상한을 지키기 시작해(0131)
 * 닿은 기관은 직원 등록·초대 가입이 막히므로 운영자가 먼저 알아 계약 인원을 늘리거나 기관에 알린다.
 */

describe('상한 가까운 기관 가르기', () => {
  const orgs = [
    { id: 'a', name: '가 기관', max_users: 20 },
    { id: 'b', name: '나 기관', max_users: 10 },
    { id: 'c', name: '다 기관', max_users: 100 },
    { id: 'd', name: '라 기관', max_users: null },
    { id: 'e', name: null, max_users: 5 },
  ];
  const users = (counts: Record<string, number>) => Object.entries(counts).flatMap(([id, n]) => Array(n).fill(id));

  it('90% 이상은 가까움, 상한 이상은 닿음 — 닿은 기관 먼저, 그다음 비율 순', () => {
    expect(SEAT_NEAR_PERCENT).toBe(90);
    const r = seatAlerts(orgs, [...users({ a: 18, b: 10, c: 89, d: 5000, e: 6 }), null, undefined]);
    expect(r.full).toBe(2);
    expect(r.near).toBe(1);
    expect(r.orgs.map((o) => [o.id, o.used, o.limit, o.full])).toEqual([
      ['e', 6, 5, true], ['b', 10, 10, true], ['a', 18, 20, false],
    ]);
    expect(r.orgs[0].name).toBe('—');
  });
  it('여유 있거나 무제한이면 없음, 계정이 하나도 없는 기관도 셈', () => {
    expect(seatAlerts(orgs, users({ a: 17, c: 10 }))).toEqual({ near: 0, full: 0, orgs: [] });
    expect(seatAlerts([{ id: 'z', name: 'z', max_users: 1 }], []).orgs).toEqual([]);
  });
});

describe('대시보드(원본)', () => {
  it('API가 활성 기관 상한과 활성·탈퇴 안 한 계정의 기관을 읽고, 못 읽으면 null', () => {
    const src = readFileSync('src/app/api/super/dashboard/route.ts', 'utf8');
    expect(src).toContain("supabaseAdmin.from('organizations').select('id, name, max_users').eq('status', 'active')");
    expect(src).toContain(".from('users').select('departments!inner(organization_id)'");
    expect(src).toContain(".eq('is_active', true).is('deleted_at', null).order('id').range(a, b)");
    expect(src).toContain('seats: seatOrgs.error || seatUsers.error ? null : seatAlerts(');
  });
  it('화면이 띠를 보이고 기관 상세로 잇는다', () => {
    const page = readFileSync('src/app/super/page.tsx', 'utf8');
    expect(page).toContain('(al.seats?.orgs ?? []).length > 0');
    expect(page).toContain('href={`/super/organizations/${o.id}`}');
    expect(page).toContain('새 계정·초대 가입이 막힙니다');
  });
});
