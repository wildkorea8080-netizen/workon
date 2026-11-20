import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 슈퍼관리자 '기관 종료'(status='terminated').
 * 예전: 대화 한도 판정·문서 올리기·예산 알림이 'suspended'만 보아 **종료한 기관의 직원이 AI를 계속 쓰고 문서를 올리고
 * 예산 알림 메일을 받았다.** 종료해도 active 계약은 그대로라 매출·한도 판정에 남았다. 기관 PATCH는 깨진 요청이 500,
 * 기관을 못 읽으면 '없음'(404), 메모는 아무 값이나 받았다.
 */

type Chain = { table: string; ops: Array<[string, unknown[]]> };
const state = {
  chains: [] as Chain[],
  org: { id: 'org-1', name: '기관', status: 'active', plan: 'basic', monthly_token_limit: 0 } as Record<string, unknown> | null,
  orgError: null as unknown,
  audits: [] as Record<string, unknown>[],
};
const has = (c: Chain, op: string) => c.ops.some(([k]) => k === op);
const arg = (c: Chain, op: string) => c.ops.find(([k]) => k === op)?.[1];

vi.mock('@/lib/super-auth', () => ({ getSuperAdminFromRequest: () => ({ sub: 'sa' }) }));
vi.mock('@/lib/audit-write', () => ({ writeAuditRow: vi.fn(async (_t: string, row: Record<string, unknown>) => { state.audits.push(row); return true; }) }));
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn(async () => {}) }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    rpc: async () => ({ data: 0, error: null }),
    from: (table: string) => {
      const chain: Chain = { table, ops: [] };
      state.chains.push(chain);
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'in', 'is', 'update', 'order', 'limit', 'gte', 'lt', 'not', 'neq']) b[n] = (...a: unknown[]) => { chain.ops.push([n, a]); return b; };
      const respond = () => {
        if (table === 'departments') return { data: { organization_id: 'org-1' }, error: null };
        if (table === 'organizations') {
          if (has(chain, 'update')) return { data: state.org ? { ...state.org, ...(arg(chain, 'update')![0] as object) } : null, error: null };
          return { data: state.org, error: state.orgError };
        }
        if (table === 'contracts') return { data: [], error: null };
        return { data: null, error: null };
      };
      b.maybeSingle = async () => respond();
      b.single = async () => respond();
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(respond()).then(res);
      return b;
    },
  },
}));

import { isStoppedOrgStatus, STOPPED_ORG_STATUS_LIST } from '@/lib/org-status';
import { checkTokenLimit, limitMessage } from '@/lib/usage-limit';
import { isOrganizationSuspended } from '@/lib/document-upload';
import { PATCH, GET } from '@/app/api/super/organizations/[id]/route';

const req = (body?: unknown) => new Request('http://x/', {
  method: body === undefined ? 'GET' : 'PATCH', headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
}) as never;
const P = { params: { id: 'org-1' } };

beforeEach(() => {
  state.chains = [];
  state.org = { id: 'org-1', name: '기관', status: 'active', plan: 'basic', monthly_token_limit: 0 };
  state.orgError = null;
  state.audits = [];
});

describe('멈춘 기관 판정', () => {
  it('정지·종료만', () => {
    expect(isStoppedOrgStatus('suspended')).toBe(true);
    expect(isStoppedOrgStatus('terminated')).toBe(true);
    for (const s of ['active', 'trial', null, undefined, '']) expect(isStoppedOrgStatus(s)).toBe(false);
    expect(STOPPED_ORG_STATUS_LIST).toBe('(suspended,terminated)');
  });
  it('종료한 기관은 문서를 올리지 못함', async () => {
    expect(await isOrganizationSuspended('org-1', async () => 'terminated')).toBe(true);
  });
});

describe('대화 한도 판정', () => {
  it('종료한 기관은 막고 종료 안내', async () => {
    state.org = { ...state.org!, status: 'terminated' };
    const s = await checkTokenLimit('dept-1');
    expect(s.allowed).toBe(false);
    expect(s.reason).toBe('org_terminated');
    expect(limitMessage(s)).toContain('종료');
  });
  it('정지는 예전처럼', async () => {
    state.org = { ...state.org!, status: 'suspended' };
    const s = await checkTokenLimit('dept-1');
    expect(s).toMatchObject({ allowed: false, reason: 'org_suspended' });
  });
});

describe('PATCH /api/super/organizations/[id]', () => {
  it('깨진 요청·틀린 메모는 400 — DB를 부르지 않음', async () => {
    for (const b of ['{깨짐', '[1]', { notes: 5 }, { notes: 'x'.repeat(1001) }, { status: 5 }]) {
      state.chains = [];
      expect((await PATCH(req(b), P)).status).toBe(400);
      expect(state.chains).toHaveLength(0);
    }
  });
  it('기관을 못 읽으면 503, 없으면 404 — 바꾸지 않음', async () => {
    state.orgError = { code: 'XX000' };
    expect((await PATCH(req({ notes: '메모' }), P)).status).toBe(503);
    state.orgError = null; state.org = null;
    expect((await PATCH(req({ notes: '메모' }), P)).status).toBe(404);
    expect(state.chains.some((c) => has(c, 'update'))).toBe(false);
  });
  it('종료하면 active 계약도 해지하고 org_terminated로 기록', async () => {
    expect((await PATCH(req({ status: 'terminated' }), P)).status).toBe(200);
    const cancel = state.chains.find((c) => c.table === 'contracts' && has(c, 'update'));
    expect(cancel && arg(cancel, 'update')![0]).toEqual({ status: 'cancelled' });
    expect(state.audits[0]).toMatchObject({ action: 'org_terminated' });
  });
  it('빈 메모는 지움', async () => {
    await PATCH(req({ notes: '  ' }), P);
    const up = state.chains.find((c) => c.table === 'organizations' && has(c, 'update'))!;
    expect((arg(up, 'update')![0] as Record<string, unknown>).notes).toBeNull();
  });
});

describe('GET /api/super/organizations/[id]', () => {
  it('못 읽으면 503, 없으면 404', async () => {
    state.orgError = { code: 'XX000' };
    expect((await GET(req(), P)).status).toBe(503);
    state.orgError = null; state.org = null;
    expect((await GET(req(), P)).status).toBe(404);
  });
});

describe('원본 확인', () => {
  it('예산 알림은 정지·종료한 기관을 빼고 문서 올리기는 같은 판정', () => {
    expect(readFileSync('src/lib/budget-alerts.ts', 'utf8')).toContain(".not('status', 'in', STOPPED_ORG_STATUS_LIST)");
    expect(readFileSync('src/lib/document-upload.ts', 'utf8')).toContain('if (!isStoppedOrgStatus(status)) return null;');
  });
});
