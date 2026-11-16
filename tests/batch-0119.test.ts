import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/logger', () => ({ logSystem: async () => {} }));

import { writeAuditRow, type AuditWriteDeps } from '@/lib/audit-write';
import { sourceFiles } from './helpers/code-schema-refs';

/**
 * 2026-11-17 — 감사 기록(슈퍼관리자 조작·모델 정책 변경·로그인) 쓰기 실패를 보이게. Supabase는 실패를 던지지 않고 `{ error }`로 돌려주는데
 * `await insert(...)`만 하거나 try/catch로 감싸 표가 없거나 칸이 어긋나도 조용히 사라졌다(보안 로그 0097과 같은 꼴).
 */

function deps(o: { error?: { code?: string } | null; throws?: boolean } = {}) {
  const rows: Array<[string, Record<string, unknown>]> = [];
  const reports: string[] = [];
  const d: AuditWriteDeps = {
    insert: vi.fn(async (t, row) => { if (o.throws) throw new Error('x'); rows.push([t, row]); return { error: o.error ?? null }; }),
    report: vi.fn(async (t, k, c) => { reports.push(`${t}:${k}:${c}`); }),
  };
  return { d, rows, reports };
}

describe('writeAuditRow', () => {
  it('남기면 true, 보고 없음', async () => {
    const { d, rows, reports } = deps();
    expect(await writeAuditRow('super_admin_logs', { admin_user_id: 'A', action: 'org_created' }, 'org_created', d)).toBe(true);
    expect(rows).toEqual([['super_admin_logs', { admin_user_id: 'A', action: 'org_created' }]]);
    expect(reports).toEqual([]);
  });
  it('돌려준 오류·던진 예외 모두 실패 — 표·종류·코드만 보고, 던지지 않음', async () => {
    const a = deps({ error: { code: '42P01' } });
    expect(await writeAuditRow('model_policy_logs', { changed_by: 'U' }, 'allowed_models_changed', a.d)).toBe(false);
    expect(a.reports).toEqual(['model_policy_logs:allowed_models_changed:42P01']);
    const b = deps({ throws: true });
    expect(await writeAuditRow('access_logs', { action: 'login' }, 'login', b.d)).toBe(false);
    expect(b.reports).toEqual(['access_logs:login:exception']);
    const c = deps({ error: {} });
    c.d.report = vi.fn(async () => { throw new Error('down'); });
    await expect(writeAuditRow('access_logs', {}, 'login', c.d)).resolves.toBe(false);
  });
});

describe('감사 기록은 이 길로만', () => {
  it('super_admin_logs·model_policy_logs 직접 insert가 없다', () => {
    const offenders = sourceFiles(['src'])
      .map((f) => f.replace(/\\/g, '/'))
      .filter((f) => !f.endsWith('src/lib/audit-write.ts'))
      .filter((f) => /from\(\s*'(super_admin_logs|model_policy_logs)'\s*\)\s*\.insert/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
  it('access_logs 직접 insert는 logger.ts(돌려준 오류를 봄)뿐, 직원 로그인 기록은 writeAuditRow', () => {
    const offenders = sourceFiles(['src'])
      .map((f) => f.replace(/\\/g, '/'))
      .filter((f) => !f.endsWith('src/lib/logger.ts') && !f.endsWith('src/lib/audit-write.ts'))
      .filter((f) => /from\(\s*'access_logs'\s*\)\s*\.insert/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
    const logger = readFileSync('src/lib/logger.ts', 'utf8');
    expect(logger).toContain("const { error } = await supabaseAdmin.from('access_logs').insert({");
    expect(logger).toContain("details: { table: 'access_logs', kind: params.action, code: error.code ?? 'error' }");
    expect(readFileSync('src/lib/sign-in-record.ts', 'utf8')).toContain("await writeAuditRow('access_logs', row, String(row.action));");
  });
  it('슈퍼관리자 조작 여덟 곳·모델 정책 변경이 writeAuditRow로', () => {
    const files = [
      'src/app/api/super/accounts/users/[id]/password-reset/route.ts',
      'src/app/api/super/accounts/users/[id]/route.ts',
      'src/app/api/super/accounts/users/[id]/sign-in-lock/route.ts',
      'src/app/api/super/common-documents/route.ts',
      'src/app/api/super/common-documents/[id]/route.ts',
      'src/app/api/super/organizations/route.ts',
      'src/app/api/super/organizations/[id]/route.ts',
      'src/app/api/super/work-settings/route.ts',
    ];
    for (const f of files) expect(readFileSync(f, 'utf8'), f).toContain("await writeAuditRow('super_admin_logs', {");
    expect(readFileSync('src/app/api/super/organizations/[id]/route.ts', 'utf8')).toContain("}, status === 'suspended' ? 'org_suspended' : 'org_updated');");
    expect(readFileSync('src/app/api/admin/organization/route.ts', 'utf8')).toContain("}, 'allowed_models_changed');");
  });
});
