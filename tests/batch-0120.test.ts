import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/logger', () => ({ logSystem: async () => {} }));

import { SYNC_WARNINGS, contractToRestore, reportContractSync } from '@/lib/contract-sync';

/**
 * 2026-11-17 — 슈퍼관리자의 계약·기관 쓰기 맞추기. 둘째 쓰기의 오류를 보지 않아 계약과 기관 한도가 어긋난 채 성공으로 보였고,
 * 기관을 다시 활성화하면 해지된 계약을 모두 되살려 옛 계약까지 active가 되고 매출 합계가 부풀었다.
 */

const NOW = Date.parse('2026-11-17T00:00:00Z');
const c = (id: string, status: string, started: string, expires: string | null = null) => ({ id, status, started_at: started, expires_at: expires });

describe('되살릴 계약', () => {
  it('해지된 것 중 기한이 남은 가장 최근 하나만', () => {
    expect(contractToRestore([
      c('old', 'cancelled', '2024-01-01T00:00:00Z', '2024-12-31T00:00:00Z'),
      c('mid', 'cancelled', '2025-01-01T00:00:00Z'),
      c('new', 'cancelled', '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z'),
    ], NOW)).toBe('new');
  });
  it('active가 이미 있으면 되살리지 않음, 기한이 다 지났으면 없음, 계약 없음', () => {
    expect(contractToRestore([c('a', 'active', '2026-01-01T00:00:00Z'), c('b', 'cancelled', '2026-02-01T00:00:00Z')], NOW)).toBeNull();
    expect(contractToRestore([c('x', 'cancelled', '2024-01-01T00:00:00Z', '2025-01-01T00:00:00Z')], NOW)).toBeNull();
    expect(contractToRestore([], NOW)).toBeNull();
  });
  it('최근 계약이 기한이 지났으면 그 앞의 기한 없는 계약', () => {
    expect(contractToRestore([
      c('expired', 'cancelled', '2026-06-01T00:00:00Z', '2026-10-01T00:00:00Z'),
      c('open', 'cancelled', '2025-06-01T00:00:00Z'),
    ], NOW)).toBe('open');
  });
});

describe('맞추기 실패 보고', () => {
  it('payment·critical로 단계·코드만, 경고 문구를 돌려줌, 던지지 않음', async () => {
    const logs: unknown[] = [];
    expect(await reportContractSync('org_limits_after_contract', 'ORG', '23503', async (p) => { logs.push(p); })).toBe(SYNC_WARNINGS.org_limits_after_contract);
    expect(logs).toEqual([{ level: 'critical', category: 'payment', message: '계약·기관 상태를 맞추지 못했습니다', details: { stage: 'org_limits_after_contract', code: '23503' }, orgId: 'ORG' }]);
    await expect(reportContractSync('org_admin_invitation', 'ORG', 'x', async () => { throw new Error('down'); })).resolves.toBe(SYNC_WARNINGS.org_admin_invitation);
  });
});

describe('연결(원본)', () => {
  it('계약 만들기 — 옛 계약을 못 끝내면 새 계약을 만들지 않음, 기관 맞추기 실패는 경고', () => {
    const src = readFileSync('src/app/api/super/contracts/route.ts', 'utf8');
    const insertAt = src.search(/\.insert\(\{\s*organization_id: orgId/);
    expect(insertAt).toBeGreaterThan(0);
    expect(src.indexOf("reportContractSync('cancel_previous_contract'")).toBeLessThan(insertAt);
    expect(src).toContain("const warning = orgErr ? await reportContractSync('org_limits_after_contract'");
  });
  it('계약 해지·바꾸기 — 기관 정지·요금제 맞추기 실패는 경고', () => {
    const src = readFileSync('src/app/api/super/contracts/[id]/route.ts', 'utf8');
    expect(src).toContain("reportContractSync('org_suspend_after_cancel'");
    expect(src).toContain("reportContractSync('org_plan_after_contract_change'");
  });
  it('기관 활성화 — 해지된 계약을 모두가 아니라 하나만', () => {
    const src = readFileSync('src/app/api/super/organizations/[id]/route.ts', 'utf8');
    expect(src).not.toMatch(/\.update\(\{ status: 'active' \}\)\s*\.eq\('organization_id', id\)/);
    expect(src).toContain("contractToRestore((contracts ?? []) as ContractLite[])");
    expect(src).toContain(".update({ status: 'active' }).eq('id', restoreId).eq('status', 'cancelled')");
  });
  it('기관 만들기 — 초대를 못 저장하면 링크를 주지 않고 경고, 화면도 안내', () => {
    const src = readFileSync('src/app/api/super/organizations/route.ts', 'utf8');
    // 2026-11-17: 기본 부서를 못 만들면 초대도 만들지 않는다(batch-0126) — 초대를 저장했을 때만 링크
    // 2026-11-19: 경고는 목록(warnings)에 모은다 — 계약 저장 실패도 함께(batch-0184)
    expect(src).toContain("if (inviteErr) warnings.push(await reportContractSync('org_admin_invitation'");
    expect(src).toContain('else inviteUrl = `${baseUrl}/signup?invite=${inviteToken}`;');
    const page = readFileSync('src/app/super/organizations/page.tsx', 'utf8');
    expect(page).toContain('{result.inviteUrl ? (');
  });
  it('화면이 경고를 보인다', () => {
    const contracts = readFileSync('src/app/super/contracts/page.tsx', 'utf8');
    expect(contracts).toContain("onToast(d.warning ?? '계약이 해지됐습니다.')");
    expect(contracts.match(/if \(d\.warning\) alert\(d\.warning\)/g)).toHaveLength(2);
    expect(readFileSync('src/app/super/organizations/[id]/page.tsx', 'utf8')).toContain('showToast(d?.warning ??');
  });
});
