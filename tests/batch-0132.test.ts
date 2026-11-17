import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));

import { seatUsage, type SeatDeps } from '@/lib/user-seats';

/**
 * 2026-11-17 — 인원 상한을 화면에. 기관 관리자 '사용자 관리'가 기관 전체 활성 계정 수·상한·남은 자리를 보이고,
 * 슈퍼관리자 기관 상세의 한도 막대가 실제 수를 쓴다(예전엔 비서 수 칸이 없어 늘 0, 막대는 부서 수로 그렸고, 사용자 수는
 * 사용 중지 계정까지 셌으며, 토큰은 로그를 앱으로 읽어 더했다).
 */

const deps = (maxUsers: unknown, used: number | 'throw', org: 'ok' | 'none' = 'ok'): SeatDeps => ({
  orgOfDepartment: async () => (org === 'none' ? null : { organizationId: 'o', maxUsers }),
  activeUsers: async () => { if (used === 'throw') throw new Error('x'); return used; },
});

describe('자리 현황(표시용)', () => {
  it('상한이 없어도 쓴 수는 센다', async () => {
    expect(await seatUsage('d', deps(null, 7))).toEqual({ used: 7, limit: null });
    expect(await seatUsage('d', deps(20, 4))).toEqual({ used: 4, limit: 20 });
  });
  it('못 읽으면 null — 던지지 않음', async () => {
    expect(await seatUsage('d', deps(20, 'throw'))).toBeNull();
    expect(await seatUsage('d', deps(20, 1, 'none'))).toBeNull();
  });
});

describe('화면·API(원본)', () => {
  it('사용자 목록 API가 자리 현황을 싣고 화면이 상한·남은 자리를 보인다', () => {
    const api = readFileSync('src/app/api/users/route.ts', 'utf8');
    expect(api).toContain('const seats = await seatUsage(departmentId);');
    expect(api).toContain('data: normalized, seats');
    const ui = readFileSync('src/components/admin/UsersManager.tsx', 'utf8');
    expect(ui).toContain('setSeats(usersRes.seats ?? null)');
    expect(ui).toContain('상한에 닿아 새 계정을 만들 수 없습니다');
    expect(ui).toContain('(사용 중지 계정은 세지 않음)');
  });
  it('슈퍼관리자 기관 상세 — 상한 판정과 같은 수, 비서 수, DB 토큰 합, 못 읽으면 null', () => {
    const api = readFileSync('src/app/api/super/organizations/[id]/route.ts', 'utf8');
    expect(api).toContain('seatDeps().activeUsers(params.id).catch(() => null)');
    expect(api).toContain(".from('agents').select('id', { count: 'exact', head: true })");
    expect(api).toContain("rpc('organization_chat_tokens'");
    expect(api).toContain('agent_count: agentCount');
    expect(api).not.toContain('pagedRows');
    const page = readFileSync('src/app/super/organizations/[id]/page.tsx', 'utf8');
    expect(page).toContain('pctOf(org.agent_count, org.max_agents)');
    expect(page).not.toContain('(org.departments ?? []).length)');
    expect(page).not.toContain('current_agents');
    expect(page).toContain('비서(표시만 — 상한을 아직 막지 않음)');
    expect(page).toContain("(n === null ? '—' : fmtN(n))");
  });
});
