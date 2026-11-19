import { readFileSync } from 'fs';
import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * 2026-11-18 — 사용량 화면의 '한도 증량'이 기관 PATCH에 `monthly_token_limit`을 보냈지만 라우트가 그 칸을 받지 않아(상태·요금제·메모만)
 * **한도가 바뀌지 않았는데도 화면은 저장된 척 닫혔다**. 요금제 값도 아무 글이나 받았다.
 */

const state: { updates: Record<string, unknown>[]; audits: Record<string, unknown>[] } = { updates: [], audits: [] };

function builder() {
  const b: Record<string, unknown> = {};
  let mode: 'read' | 'update' = 'read';
  for (const n of ['select', 'eq', 'in']) b[n] = () => b;
  b.update = (row: Record<string, unknown>) => { mode = 'update'; state.updates.push(row); return b; };
  b.single = () => Promise.resolve(mode === 'update'
    ? { data: { id: 'org-1', ...state.updates.at(-1) }, error: null }
    : { data: { id: 'org-1', name: '기관', status: 'active', plan: 'basic', monthly_token_limit: 2_000_000 }, error: null });
  b.maybeSingle = b.single; // 2026-11-19 — 라우트가 읽기 오류와 '없음'을 가르려 maybeSingle을 쓴다
  return b;
}

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: { from: () => builder() } }));
vi.mock('@/lib/super-auth', () => ({ getSuperAdminFromRequest: () => ({ sub: 'admin-1' }) }));
vi.mock('@/lib/audit-write', () => ({ writeAuditRow: async (_t: string, row: Record<string, unknown>) => { state.audits.push(row); return true; } }));
vi.mock('@/lib/contract-sync', () => ({ reportContractSync: async () => 'w', contractToRestore: () => null }));

import { PATCH } from '@/app/api/super/organizations/[id]/route';
import { adminLogSummary } from '@/lib/super-admin-log-spec';

const req = (body: unknown) => new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }) as never;
const P = { params: { id: 'org-1' } };

beforeEach(() => { state.updates = []; state.audits = []; });

describe('PATCH /api/super/organizations/[id] — 월 토큰 한도', () => {
  it('한도를 저장하고 기록에 전·후', async () => {
    const res = await PATCH(req({ monthly_token_limit: 3_000_000 }), P);
    expect(res.status).toBe(200);
    expect(state.updates[0]).toMatchObject({ monthly_token_limit: 3_000_000 });
    expect(state.audits[0]).toMatchObject({ action: 'org_updated', before_data: expect.objectContaining({ monthly_token_limit: 2_000_000 }) });
  });
  it('0은 무제한으로 받음', async () => {
    expect((await PATCH(req({ monthly_token_limit: 0 }), P)).status).toBe(200);
    expect(state.updates[0]).toMatchObject({ monthly_token_limit: 0 });
  });
  it('음수·소수·글·너무 큰 값은 400 — 아무것도 바꾸지 않음', async () => {
    for (const v of [-1, 1.5, '3000000', null, 1e13]) {
      const res = await PATCH(req({ monthly_token_limit: v }), P);
      expect(res.status, String(v)).toBe(400);
    }
    expect(state.updates).toEqual([]);
  });
  it('요금제는 정해 둔 것만', async () => {
    expect((await PATCH(req({ plan: 'platinum' }), P)).status).toBe(400);
    expect((await PATCH(req({ plan: '__proto__' }), P)).status).toBe(400);
    expect((await PATCH(req({ plan: 'enterprise' }), P)).status).toBe(200);
  });
});

describe('기록 요약·화면', () => {
  it('요약 — 월 토큰 한도 전 → 후, 0은 무제한', () => {
    expect(adminLogSummary('org_updated', { monthly_token_limit: 2000000 }, { monthly_token_limit: 0, updated_at: 'x' })).toBe('월 토큰 한도 2,000,000 → 무제한');
  });
  it('사용량 화면은 응답을 보고, 실패면 창에 이유', () => {
    const s = readFileSync('src/app/super/usage/page.tsx', 'utf8');
    expect(s).toContain('if (!data?.ok) return');
    expect(s).toContain('{error && <p className="text-xs text-red-400">{error}</p>}');
    expect(s).toContain('min={0}');
  });
  it('사용량 CSV는 칸을 감싸고 수식 주입을 막는다', () => {
    const s = readFileSync('src/app/super/usage/page.tsx', 'utf8');
    expect(s).toContain('.map(q).join(\',\')');
    // 수식 주입 막기는 한 곳(src/lib/csv-cell.ts — 2026-11-18 batch-0174)
    expect(s).toContain('const q = csvCell;');
    expect(s).toContain("from '@/lib/csv-cell'");
  });
});
