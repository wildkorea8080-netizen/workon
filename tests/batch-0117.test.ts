import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));

import { logSecurityEvent, type SecurityLogDeps } from '@/lib/security-log';
import { extractRefs, missingRefs, sourceFiles } from './helpers/code-schema-refs';

/**
 * 2026-11-17 — 보안 로그는 한 곳에서, 실패를 보이게. 운영에 security_logs 표가 없던 동안(0097) 모든 보안 로그가 조용히 사라졌다 —
 * Supabase는 실패를 던지지 않고 `{ error }`로 돌려주는데 쓰던 곳마다 try/catch로만 감쌌다.
 */

function deps(o: { error?: { code?: string } | null; throws?: boolean } = {}) {
  const rows: Record<string, unknown>[] = [];
  const reports: string[] = [];
  const d: SecurityLogDeps = {
    insert: vi.fn(async (row) => { if (o.throws) throw new Error('x'); rows.push(row); return { error: o.error ?? null }; }),
    report: vi.fn(async (t, c) => { reports.push(`${t}:${c}`); }),
  };
  return { d, rows, reports };
}

describe('logSecurityEvent', () => {
  it('남기면 true — 부서·사람·종류·상세·심각도·시각', async () => {
    const { d, rows, reports } = deps();
    expect(await logSecurityEvent('D', 'U', 'password_changed', { a: 1 }, 'low', d)).toBe(true);
    expect(rows[0]).toMatchObject({ department_id: 'D', user_id: 'U', event_type: 'password_changed', details: { a: 1 }, severity: 'low' });
    expect(typeof rows[0].created_at).toBe('string');
    expect(reports).toEqual([]);
  });
  it('돌려준 오류(표 없음 42P01)도 실패로 — 운영 기록에 종류·코드만, 던지지 않음', async () => {
    const { d, reports } = deps({ error: { code: '42P01' } });
    expect(await logSecurityEvent(null, undefined, 'ip_blocked', { ip: '1.2.3.4' }, 'high', d)).toBe(false);
    expect(reports).toEqual(['ip_blocked:42P01']);
  });
  it('던져도 false, 보고가 실패해도 던지지 않음, 사람·부서 없으면 NULL', async () => {
    const a = deps({ throws: true });
    expect(await logSecurityEvent('D', 'U', 'sign_in_unlocked', {}, 'medium', a.d)).toBe(false);
    expect(a.reports).toEqual(['sign_in_unlocked:exception']);
    const b = deps({ error: { code: 'x' } });
    b.d.report = vi.fn(async () => { throw new Error('report'); });
    await expect(logSecurityEvent('D', 'U', 'ip_blocked', {}, 'high', b.d)).resolves.toBe(false);
    const c = deps();
    await logSecurityEvent(undefined, null, 'ip_blocked', {}, 'high', c.d);
    expect(c.rows[0]).toMatchObject({ department_id: null, user_id: null });
  });
});

describe('보안 로그는 이 함수로만', () => {
  it('src 어디에도 security_logs 직접 insert가 없다(security-log.ts 빼고)', () => {
    const offenders = sourceFiles(['src'])
      .filter((f) => !f.replace(/\\/g, '/').endsWith('src/lib/security-log.ts'))
      .filter((f) => /from\(\s*'security_logs'\s*\)\s*\.insert/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
  it('예전 이름(filter.ts)으로 불러도 같은 함수', () => {
    expect(readFileSync('src/lib/filter.ts', 'utf8')).toContain("export { logSecurityEvent, type SecurityEventType } from '@/lib/security-log';");
  });
  it('IP 차단 기록은 실제로 남겼을 때만 logged:true', () => {
    expect(readFileSync('src/app/api/access-denied/route.ts', 'utf8')).toContain("return NextResponse.json({ ok: true, data: { logged } });");
  });
});

describe('관리자 설정 화면의 보안 로그 — users에는 name 칸이 없다', () => {
  it('조회가 full_name을 고르고 화면도 full_name', () => {
    const route = readFileSync('src/app/api/security-logs/route.ts', 'utf8');
    expect(route).toMatch(/users:user_id \(\s*full_name,\s*email\s*\)/);
    expect(readFileSync('src/components/admin/SettingsManager.tsx', 'utf8')).toContain("log.users?.full_name || '알 수 없음'");
  });
  it('코드 쪽 스키마 검사가 여러 줄 백틱 select의 내장 관계 칸도 본다', () => {
    const src = "await db\n  .from('security_logs')\n  .select(`\n    *,\n    users:user_id (\n      name,\n      email\n    )\n  `)\n  .eq('department_id', d);";
    const schema = { columns: new Map([['security_logs', new Set(['id', 'department_id'])], ['users', new Set(['id', 'full_name', 'email'])]]), functions: new Set<string>() };
    expect(Array.from(missingRefs(extractRefs(src, 'x.ts'), schema).keys())).toEqual(['칸 users.name (내장 관계)']);
  });
});
