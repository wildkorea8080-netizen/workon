import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { DORMANT_DAYS, USER_LIST_FILTERS, matchesUserFilter } from '@/lib/user-list-filter';

/** 2026-11-16 — 기관 관리자가 직원 계정을 사용 중지·다시 사용한다(예전엔 슈퍼관리자만). 장기 미접속 거르기 */

const NOW = Date.parse('2026-11-16T10:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

describe('목록 거르기', () => {
  it('사용 중지', () => {
    expect(matchesUserFilter({ is_active: false }, 'inactive', NOW)).toBe(true);
    expect(matchesUserFilter({ is_active: true }, 'inactive', NOW)).toBe(false);
    expect(matchesUserFilter({}, 'inactive', NOW)).toBe(false);
  });
  it('90일 넘게 로그인 안 함 — 기록이 있는 사람만(기록 없음은 따로)', () => {
    expect(DORMANT_DAYS).toBe(90);
    expect(matchesUserFilter({ last_sign_in_at: daysAgo(91) }, 'dormant', NOW)).toBe(true);
    expect(matchesUserFilter({ last_sign_in_at: daysAgo(89) }, 'dormant', NOW)).toBe(false);
    expect(matchesUserFilter({ last_sign_in_at: null }, 'dormant', NOW)).toBe(false);
    expect(matchesUserFilter({ last_sign_in_at: 'x' }, 'dormant', NOW)).toBe(false);
  });
  it('로그인 기록 없음·전체', () => {
    expect(matchesUserFilter({ last_sign_in_at: null }, 'no_sign_in', NOW)).toBe(true);
    expect(matchesUserFilter({ last_sign_in_at: daysAgo(1) }, 'no_sign_in', NOW)).toBe(false);
    expect(matchesUserFilter({ is_active: false }, 'all', NOW)).toBe(true);
    expect(USER_LIST_FILTERS.map((f) => f.key)).toEqual(['all', 'inactive', 'dormant', 'no_sign_in']);
  });
});

describe('연결(원본)', () => {
  const src = readFileSync('src/app/api/users/[id]/active/route.ts', 'utf8');
  it('라우트 — 관리자·대리 접근 막음·본인 안 됨·관리 범위·슈퍼관리자 계정 제외·끌 때 사유·보안 로그 high', () => {
    expect(src).toContain('isAdminSession(session)');
    expect(src).toContain('if (session.user.isImpersonating)');
    expect(src).toContain('if (params.id === session.user.id)');
    expect(src).toContain("typeof body.active !== 'boolean'");
    expect(src).toContain('if (!body.active && reason.length < 2)');
    expect(src).toContain('managedDeptIds.includes(target.department_id)');
    expect(src).toContain(".eq('is_super_admin', false)");
    expect(src).toContain('{ is_active: true, reactivated_at: new Date().toISOString() } : { is_active: false }');
    expect(src).toContain("event_type: body.active ? 'user_reactivated' : 'user_deactivated'");
    expect(src).toContain("severity: 'high'");
  });
  it('끄면 로그인이 막히고 열린 로그인도 끝난다(이미 있는 장치)', () => {
    expect(readFileSync('src/lib/user-withdrawal.ts', 'utf8')).toMatch(/is_active/);
    expect(readFileSync('src/lib/middleware-db.ts', 'utf8')).toContain("row.is_active === false || row.deleted_at) return { kind: 'inactive' }");
  });
  it('화면·목록·감사 이름표', () => {
    expect(readFileSync('src/app/api/users/route.ts', 'utf8')).toContain('last_sign_in_at, is_active');
    const ui = readFileSync('src/components/admin/UsersManager.tsx', 'utf8');
    expect(ui).toContain('`/api/users/${userId}/active`');
    expect(ui).toContain('matchesUserFilter(u, listFilter)');
    expect(ui).toContain('사용 중지됨');
    const audit = readFileSync('src/app/api/admin/audit-logs/route.ts', 'utf8');
    expect(audit).toContain("user_deactivated: '계정 사용 중지(관리자)'");
    expect(audit).toContain("user_reactivated: '계정 다시 사용(관리자)'");
    expect(readFileSync('src/lib/user-list-filter.ts', 'utf8')).not.toMatch(/^import /m);
  });
});
