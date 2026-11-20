import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-20 — 슈퍼관리자 화면 두 곳이 읽기 실패를 '없음'으로 쓰지 않는다.
 * ① 공통 자료실 문서 지우기: 감사 기록에 남길 이름·유형·연도·이용 조건을 못 읽어도 그대로 지워,
 *    되돌릴 수 없는 삭제의 기록(`common_document_deleted`)에 무엇을 지웠는지가 비었다 → 못 읽으면 지우지 않고 503.
 * ② API 키 화면의 통계: 활성 기관 수·기관이 비어 있는 기록의 토큰을 못 읽으면 0개·0토큰이었다 → null('읽지 못함'),
 *    토큰은 숫자만 더한다(예전엔 글 값이 이어 붙었다).
 */

const state = {
  beforeError: null as unknown,
  countError: null as unknown,
  usageError: null as unknown,
  usage: [] as Array<{ details: unknown }>,
};
const del = vi.fn(async () => ({ ok: true }));
const audit = vi.fn(async () => true);

vi.mock('@/lib/super-auth', () => ({ getSuperAdminFromRequest: () => ({ sub: 's1' }) }));
vi.mock('@/lib/common-documents', () => ({ deleteCommonDocument: (...a: unknown[]) => del(...(a as [])) }));
vi.mock('@/lib/audit-write', () => ({ writeAuditRow: (...a: unknown[]) => audit(...(a as [])) }));
vi.mock('@/lib/crypto', () => ({ encryptApiKey: (v: string) => v, decryptApiKey: (v: string) => v, maskApiKey: () => 'sk-…' }));
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn() }));
vi.mock('@/lib/paged-select', () => ({
  pagedRows: async () => ({ data: state.usageError ? [] : state.usage, error: state.usageError, truncated: false, total: null }),
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'is', 'in', 'order']) b[n] = () => b;
      b.maybeSingle = async () => (state.beforeError
        ? { data: null, error: state.beforeError }
        : { data: { title: '예산편성기준', org_type: '지방공기업', edition_year: 2026, usage_terms: '공공누리 1유형' }, error: null });
      b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(
        table === 'organizations'
          ? { data: null, error: state.countError, count: state.countError ? null : 2 }
          : { data: [], error: null },
      ).then(ok, bad);
      return b;
    },
  },
}));

import { DELETE } from '@/app/api/super/common-documents/[id]/route';
import { GET as systemKeys } from '@/app/api/super/api-keys/system/route';

const ID = '11111111-1111-1111-1111-111111111111';
const remove = () => DELETE(new Request('http://x', { method: 'DELETE' }) as never, { params: { id: ID } });

beforeEach(() => {
  state.beforeError = null; state.countError = null; state.usageError = null; state.usage = [];
  del.mockClear(); audit.mockClear();
});

describe('DELETE /api/super/common-documents/[id]', () => {
  it('지우기 전 기록을 못 읽으면 지우지 않고 503', async () => {
    state.beforeError = { code: 'XX000' };
    const res = await remove();
    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toContain('지우지 않았습니다');
    expect(del).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
  it('읽으면 지우고 무엇을 지웠는지 남긴다', async () => {
    expect((await remove()).status).toBe(200);
    expect(del).toHaveBeenCalledOnce();
    expect((audit.mock.calls[0] as unknown[])[1]).toMatchObject({ after_data: { title: '예산편성기준', edition_year: 2026 } });
  });
});

describe('GET /api/super/api-keys/system 통계', () => {
  const stats = async () => (await (await systemKeys(new Request('http://x') as never)).json()).data.stats;
  it('못 읽으면 null', async () => {
    state.countError = { code: 'XX000' };
    state.usageError = { message: 'down' };
    expect(await stats()).toEqual({ systemKeyOrgCount: null, totalTokensThisMonth: null, estimatedCostUsd: null });
  });
  it('읽으면 수 그대로, 토큰은 숫자만', async () => {
    state.usage = [{ details: { input_tokens: 100, output_tokens: 20 } }, { details: { input_tokens: '5', output_tokens: 1 } }];
    const s = await stats();
    expect(s.systemKeyOrgCount).toBe(2);
    expect(s.totalTokensThisMonth).toBe(121);
  });
  it('화면이 못 읽음을 따로 보인다', () => {
    const page = readFileSync('src/app/super/api-keys/page.tsx', 'utf8');
    expect(page).toContain("stats.systemKeyOrgCount === null ? '읽지 못함'");
    expect(page).toContain("stats.totalTokensThisMonth === null ? '읽지 못함'");
    expect(page).toContain("stats.estimatedCostUsd === null ? '읽지 못함'");
  });
});
