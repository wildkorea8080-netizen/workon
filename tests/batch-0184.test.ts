import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 슈퍼관리자 '새 기관 등록'(`POST /api/super/organizations`)·기관 목록.
 * 예전: 요금제·유형·한도·이용료·날짜·이메일을 보지 않았다 — 틀린 날짜는 기관을 만든 뒤 계약을 넣다 던져 500(반쪽 기관),
 * 계약 넣기 실패는 `console.warn` 한 줄뿐(계약 없는 기관이 '등록됨'), 표 밖 요금제·유형도 그대로 저장.
 * 목록의 예비 길은 읽기 실패를 빈 목록으로 답했다.
 */

type Chain = { table: string; ops: Array<[string, unknown[]]> };
const state = {
  chains: [] as Chain[],
  contractError: null as unknown,
  viewError: null as unknown,
  fallbackError: null as unknown,
  syncStages: [] as string[],
};
const has = (c: Chain, op: string) => c.ops.some(([k]) => k === op);
const arg = (c: Chain, op: string) => c.ops.find(([k]) => k === op)?.[1];

vi.mock('@/lib/super-auth', () => ({ getSuperAdminFromRequest: () => ({ sub: 'sa' }) }));
vi.mock('@/lib/audit-write', () => ({ writeAuditRow: vi.fn(async () => true) }));
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn(async () => {}) }));
vi.mock('@/lib/install-presets', () => ({ installPresetAgents: vi.fn(async () => ({ installed: 0, skipped: 0, categories: 0 })) }));
vi.mock('@/lib/org-chat-tokens', () => ({ orgChatTokens: vi.fn(async () => new Map()) }));
vi.mock('@/lib/contract-sync', () => ({
  reportContractSync: vi.fn(async (stage: string) => { state.syncStages.push(stage); return `경고:${stage}`; }),
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Chain = { table, ops: [] };
      state.chains.push(chain);
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'insert', 'ilike', 'order', 'range']) b[n] = (...a: unknown[]) => { chain.ops.push([n, a]); return b; };
      const respond = () => {
        if (table === 'v_organization_summary') return { data: state.viewError ? null : [], count: 0, error: state.viewError };
        if (table === 'organizations' && has(chain, 'range')) return { data: state.fallbackError ? null : [], count: 0, error: state.fallbackError };
        if (has(chain, 'insert')) {
          if (table === 'contracts') return { data: null, error: state.contractError };
          return { data: { id: `${table}-1`, name: '새 기관', type: '공공기관', ...(arg(chain, 'insert')![0] as object) }, error: null };
        }
        return { data: null, error: null }; // slug 겹침 확인: 없음
      };
      b.maybeSingle = async () => respond();
      b.single = async () => respond();
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(respond()).then(res);
      return b;
    },
  },
}));

import { parseOrgCreateInput } from '@/lib/org-create-input';
import { GET, POST } from '@/app/api/super/organizations/route';

const ok = { name: ' 새 기관 ', slug: 'new-org', adminEmail: ' Admin@Org.go.kr ' };
const req = (body?: unknown, url = 'http://x/') => new Request(url, {
  method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
}) as never;
const inserted = (table: string) => state.chains.filter((c) => c.table === table && has(c, 'insert')).map((c) => arg(c, 'insert')![0] as Record<string, unknown>);

beforeEach(() => {
  state.chains = []; state.contractError = null; state.viewError = null; state.fallbackError = null; state.syncStages = [];
});

describe('parseOrgCreateInput', () => {
  it('틀린 값은 거절', () => {
    for (const b of [
      null, [], {}, { ...ok, name: ' ' }, { ...ok, name: 'x'.repeat(101) }, { ...ok, slug: 'A B' }, { ...ok, adminEmail: 'not-mail' },
      { ...ok, type: '외계 기관' }, { ...ok, plan: 'platinum' }, { ...ok, plan: '__proto__' },
      { ...ok, contractStart: '2026-02-30' }, { ...ok, contractStart: '2026-12-01', contractEnd: '2026-11-01' },
      { ...ok, maxUsers: 0 }, { ...ok, maxAgents: 1.5 }, { ...ok, maxTokensPerMonth: -1 },
      { ...ok, monthlyFee: 100_000_000 }, { ...ok, monthlyFee: 'abc' }, { ...ok, notes: 5 }, { ...ok, notes: 'x'.repeat(1001) },
    ]) expect(parseOrgCreateInput(b).ok).toBe(false);
  });
  it('다듬고 빈 칸은 예전 기본값', () => {
    const r = parseOrgCreateInput({ ...ok, notes: '  ', contractStart: '' });
    expect(r).toEqual({ ok: true, value: {
      name: '새 기관', slug: 'new-org', type: '공공기관', plan: 'basic', contractStart: null, contractEnd: null,
      maxUsers: 20, maxAgents: 10, maxTokensPerMonth: 2_000_000, monthlyFee: 0, adminEmail: 'admin@org.go.kr', notes: null,
    } });
  });
});

describe('POST /api/super/organizations', () => {
  it('틀린 입력은 400 — 아무것도 만들지 않음', async () => {
    for (const b of ['{깨짐', { ...ok, contractEnd: '내일' }, { ...ok, plan: 'platinum' }, { ...ok, monthlyFee: 100_000_000 }]) {
      state.chains = [];
      expect((await POST(req(b))).status).toBe(400);
      expect(state.chains).toHaveLength(0);
    }
  });
  it('다듬은 값으로 기관·계약·초대를 만든다', async () => {
    const res = await POST(req({ ...ok, plan: 'pro', type: '지방공기업', monthlyFee: 300000, contractStart: '2026-12-01' }));
    expect(res.status).toBe(200);
    expect(inserted('organizations')[0]).toMatchObject({ name: '새 기관', slug: 'new-org', plan: 'pro', type: '지방공기업' });
    expect(inserted('contracts')[0]).toMatchObject({ plan: 'pro', price_per_month: 300000, started_at: '2026-12-01T00:00:00.000Z' });
    expect(inserted('invitations')[0]).toMatchObject({ email: 'admin@org.go.kr', role: 'ADMIN' });
  });
  it('계약을 못 넣으면 경고로 알림(기관은 남음)', async () => {
    state.contractError = { code: '22003' };
    const res = await POST(req(ok));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(state.syncStages).toContain('org_contract_create');
    expect(body.warning).toContain('경고:org_contract_create');
    expect(body.data.inviteUrl).toEqual(expect.any(String));
  });
});

describe('GET /api/super/organizations', () => {
  it('뷰도 예비 길도 못 읽으면 빈 목록이 아니라 500', async () => {
    state.viewError = { code: '42P01' }; state.fallbackError = { code: 'XX000' };
    expect((await GET(req(undefined))).status).toBe(500);
  });
  it('숫자가 아닌 쪽·개수는 기본값', async () => {
    const res = await GET(req(undefined, 'http://x/?page=abc&limit=xyz'));
    expect((await res.json()).meta).toEqual({ total: 0, page: 1, limit: 20 });
  });
});

describe('원본 확인 — 등록 화면', () => {
  it('실패 응답을 알린다', () => {
    expect(readFileSync('src/app/super/organizations/page.tsx', 'utf8')).toContain("'기관을 등록하지 못했습니다.'");
  });
});
