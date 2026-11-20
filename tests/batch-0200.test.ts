import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 멈춘 기관의 나머지 두 길.
 * ① 문서 올리기는 종료한 기관도 막았지만(0183) 안내가 '정지되어'였다 — 이제 정지·종료를 가른다.
 * ② 기관 통계 읽기 API(`/api/v1/*`)는 기관을 정지·종료해도 키가 그대로 읽혔다 — 대화·문서 올리기처럼 403.
 */

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));

import { organizationUploadBlock, ORG_SUSPENDED_UPLOAD_MESSAGE, ORG_TERMINATED_UPLOAD_MESSAGE } from '@/lib/document-upload';
import { generateOrgApiToken, handleOrgApiCall, hashOrgApiToken, type OrgApiDeps } from '@/lib/org-api/keys';
import { ORG_API_ORG_STOPPED } from '@/lib/org-api/spec';

describe('문서 올리기 — 막는 까닭', () => {
  it('정지·종료를 가른다', async () => {
    expect(await organizationUploadBlock('o1', async () => 'suspended')).toBe(ORG_SUSPENDED_UPLOAD_MESSAGE);
    expect(await organizationUploadBlock('o1', async () => 'terminated')).toBe(ORG_TERMINATED_UPLOAD_MESSAGE);
    expect(ORG_TERMINATED_UPLOAD_MESSAGE).toContain('종료되어');
  });
  it('활성·체험·기관 없음·조회 실패는 막지 않음(예전과 같음)', async () => {
    expect(await organizationUploadBlock('o1', async () => 'active')).toBeNull();
    expect(await organizationUploadBlock('o1', async () => 'trial')).toBeNull();
    expect(await organizationUploadBlock(null, async () => 'terminated')).toBeNull();
    expect(await organizationUploadBlock('o1', async () => { throw new Error('down'); })).toBeNull();
  });
});

describe('기관 통계 API — 멈춘 기관', () => {
  const token = generateOrgApiToken().token;
  function deps(status: string | null | (() => never)) {
    const recordCall = vi.fn(async () => {});
    const run = vi.fn(async () => ({ data: { n: 1 } }));
    const d: OrgApiDeps = {
      claim: async (hash) => (hash === hashOrgApiToken(token)
        ? { ok: true as const, key: { id: 'k1', organization_id: 'o1', created_by: 'u1', scopes: ['adoption'] } }
        : { ok: false as const, reason: 'invalid' as const }),
      loadCreator: async () => ({ id: 'u1', role: 'ADMIN', is_active: true, deleted_at: null, department_id: 'top' }),
      loadDepartment: async () => ({ organization_id: 'o1', parent_id: null }),
      allowedIps: async () => null,
      orgStatus: async () => (typeof status === 'function' ? status() : status),
      managedDepartmentIds: async () => ['top'],
      recordCall,
      now: () => Date.parse('2026-11-19T01:00:00Z'),
    };
    return { d, recordCall, run };
  }
  const call = (d: OrgApiDeps, run: () => Promise<{ data: unknown }>) =>
    handleOrgApiCall(d, { authorization: `Bearer ${token}`, ip: '10.0.0.1' }, 'adoption-report', run);

  it.each(['suspended', 'terminated'])('%s 기관은 403·숫자를 세지 않음·호출은 기록', async (status) => {
    const { d, recordCall, run } = deps(status);
    const res = await call(d, run);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: { message: ORG_API_ORG_STOPPED } });
    expect(run).not.toHaveBeenCalled();
    expect(recordCall).toHaveBeenCalledWith('k1', 'o1', 'adoption-report', 403);
  });
  it('활성 기관은 그대로', async () => {
    const { d, run } = deps('active');
    expect((await call(d, run)).status).toBe(200);
    expect(run).toHaveBeenCalled();
  });
  it('상태를 못 읽으면 숫자를 내지 않는다(던짐 → 라우트 500)', async () => {
    const { d, run } = deps(() => { throw new Error('down'); });
    await expect(call(d, run)).rejects.toThrow('down');
    expect(run).not.toHaveBeenCalled();
  });
  it('원본: 기관 행은 한 호출에 한 번 읽어 상태·IP를 함께', () => {
    const s = readFileSync('src/lib/org-api/keys.ts', 'utf8');
    expect(s).toContain(".select('allowed_ips, status')");
    expect(s.indexOf('deps.orgStatus(key.organization_id)')).toBeLessThan(s.indexOf('deps.allowedIps(key.organization_id)'));
  });
});
