import { readFileSync } from 'fs';
import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * 2026-11-17 — 계약·API 키·공지·초대 링크·기관 종료도 슈퍼관리자 조작 기록에. 예전엔 돈과 한도를 정하는 계약 등록·변경·해지,
 * 시스템·기관 API 키 교체, 공지 작성·수정·삭제, 관리자 초대 링크 만들기가 어디에도 남지 않았다.
 * 같은 묶음: 초대 링크 라우트가 역할을 아무 글이나 받고(→ ADMIN·USER만), 순서 없이 아무 부서 하나를 골랐으며(→ 최상위 부서 중 먼저 만든 것),
 * 부서가 없으면 가입에서 거절될 소속 없는 초대를 만들었다(→ 400). 기관 상태도 아무 글이나 받았고, '기관 삭제' 단추는 응답을 보지 않고
 * 늘 '삭제됐습니다'라고 알렸다.
 */

const state: { depts: { data: unknown; error: unknown }; inserted: unknown[]; audits: unknown[]; calls: unknown[][] } = {
  depts: { data: [], error: null }, inserted: [], audits: [], calls: [],
};

function builder(table: string) {
  const b: Record<string, unknown> = {};
  const chain = (n: string) => (...a: unknown[]) => { state.calls.push([`${table}.${n}`, ...a]); return b; };
  for (const n of ['select', 'eq', 'is', 'order', 'limit', 'single']) b[n] = chain(n);
  b.insert = (row: unknown) => { state.inserted.push(row); state.calls.push([`${table}.insert`]); return b; };
  b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
    Promise.resolve(table === 'departments' ? state.depts : { data: { id: 'inv-1', ...(state.inserted.at(-1) as object) }, error: null }).then(ok, bad);
  return b;
}

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: { from: (t: string) => builder(t) } }));
vi.mock('@/lib/super-auth', () => ({ getSuperAdminFromRequest: () => ({ sub: 'admin-1' }) }));
vi.mock('@/lib/audit-write', () => ({ writeAuditRow: async (_t: string, row: unknown) => { state.audits.push(row); return true; } }));
vi.mock('@/lib/config', () => ({ APP_URL: 'https://app.example' }));

import { ADMIN_LOG_ACTIONS, adminLogSummary, changedFields, contractAudit } from '@/lib/super-admin-log-spec';
import { POST as inviteOrgAdmin } from '@/app/api/super/organizations/[id]/invitations/route';

const read = (p: string) => readFileSync(p, 'utf8');
const inviteReq = (body: unknown) => new Request('http://x', { method: 'POST', body: JSON.stringify(body) }) as never;
const ORG = { params: { id: 'org-1' } };

beforeEach(() => {
  state.depts = { data: [{ id: 'dept-top' }], error: null };
  state.inserted = []; state.audits = []; state.calls = [];
});

describe('계약 기록 — 남길 칸·달라진 칸·요약', () => {
  it('계약 행에서 정해 둔 칸만, 날짜는 날만', () => {
    expect(contractAudit({ id: 'c', plan: 'basic', status: 'active', price_per_month: 990000, notes: '비공개 메모', created_by: 'u', started_at: '2026-04-27T03:00:00+00:00', expires_at: null }))
      .toEqual({ plan: 'basic', status: 'active', price_per_month: 990000, started_at: '2026-04-27', expires_at: null });
    expect(contractAudit(null)).toEqual({});
  });
  it('달라진 칸만 전·후로', () => {
    expect(changedFields({ plan: 'basic', status: 'active', price_per_month: 1 }, { plan: 'enterprise', status: 'active', price_per_month: 1 }))
      .toEqual({ before: { plan: 'basic' }, after: { plan: 'enterprise' } });
  });
  it('요약 — 등록은 값, 변경·해지는 전 → 후', () => {
    expect(adminLogSummary('contract_created', null, { plan: 'basic', billing_type: 'annual_fixed', annual_budget_krw: 12000000 }))
      .toBe('요금제 basic · 과금 연간 정액 · 연간 예산 12,000,000원');
    expect(adminLogSummary('contract_updated', { price_per_month: 500000 }, { price_per_month: 990000 })).toBe('월 이용료 500,000원 → 990,000원');
    expect(adminLogSummary('contract_cancelled', { status: 'active' }, { status: 'cancelled' })).toBe('상태 active → cancelled');
    expect(adminLogSummary('contract_updated', { expires_at: null }, { expires_at: '2027-04-26' })).toBe('종료 없음 → 2027-04-26');
  });
  it('요약 — API 키·공지·초대', () => {
    expect(adminLogSummary('api_key_changed', null, { scope: 'system', provider: 'anthropic' })).toBe('시스템 키 교체 · anthropic');
    expect(adminLogSummary('api_key_changed', null, { scope: 'organization', use_system_default: true })).toBe('기관 키 끔 — 시스템 기본 키 사용');
    expect(adminLogSummary('notice_deleted', { title: '점검 안내', is_published: true }, null)).toBe('점검 안내 · 발행');
    expect(adminLogSummary('invitation_created', null, { email: 'a@b.kr', role: 'ADMIN' })).toBe('a@b.kr · ADMIN');
  });
  it('새 종류에 화면 이름', () => {
    for (const a of ['contract_created', 'contract_updated', 'contract_cancelled', 'api_key_changed', 'notice_created', 'notice_updated', 'notice_deleted', 'invitation_created', 'org_terminated']) {
      expect(ADMIN_LOG_ACTIONS[a], a).toBeTruthy();
    }
  });
});

describe('라우트가 기록을 남긴다 — 비밀은 싣지 않고', () => {
  const block = (src: string, action: string) => {
    const i = src.indexOf(action);
    expect(i, action).toBeGreaterThan(-1);
    return src.slice(src.lastIndexOf('writeAuditRow(', i), src.indexOf(');', i) + 2);
  };
  it('계약 등록·변경·해지', () => {
    expect(read('src/app/api/super/contracts/route.ts')).toContain("action: 'contract_created'");
    const s = read('src/app/api/super/contracts/[id]/route.ts');
    expect(s).toContain("'contract_cancelled' : 'contract_updated'");
    expect(s).toContain('changedFields(contractAudit(before), contractAudit(contract))');
  });
  it('API 키 — 키 값·앞부분·암호문은 기록에 없음', () => {
    const sys = read('src/app/api/super/api-keys/system/route.ts');
    const org = read('src/app/api/super/organizations/[id]/api-keys/route.ts');
    for (const b of [block(sys, "'api_key_changed'"), block(org, "provider },"), block(org, 'use_system_default')]) {
      expect(b).not.toMatch(/keyValue|prefix|encrypted|key_value/);
    }
    expect(org.match(/action: 'api_key_changed'/g)?.length).toBe(2);
  });
  it('공지 — 본문은 남기지 않음', () => {
    const a = read('src/app/api/super/notices/route.ts');
    const b = read('src/app/api/super/notices/[id]/route.ts');
    expect(a).toContain("action: 'notice_created'");
    expect(b).toContain("action: 'notice_updated'");
    expect(b).toContain("action: 'notice_deleted'");
    for (const [src, act] of [[a, "'notice_created'"], [b, "'notice_updated'"], [b, "'notice_deleted'"]] as const) expect(block(src, act)).not.toMatch(/content/);
  });
  it('기관 종료는 org_terminated, 상태는 넷만', () => {
    const s = read('src/app/api/super/organizations/[id]/route.ts');
    expect(s).toContain("'org_terminated'");
    expect(s).toContain("['trial', 'active', 'suspended', 'terminated'].includes(status)");
  });
  it("'기관 삭제' 단추는 응답을 본다", () => {
    const s = read('src/app/super/organizations/[id]/page.tsx');
    const h = s.slice(s.indexOf('const handleDelete'), s.indexOf('const copyUrl'));
    expect(h).toContain('if (!data?.ok)');
  });
  it('초대 주소는 config 경유(process.env 직접 안 씀)', () => {
    for (const p of ['src/app/api/super/organizations/[id]/invitations/route.ts', 'src/app/api/super/organizations/route.ts']) {
      expect(read(p), p).not.toMatch(/process\.env\.NEXTAUTH_URL/);
    }
  });
});

describe('POST /api/super/organizations/[id]/invitations', () => {
  it('역할은 ADMIN·USER만', async () => {
    const res = await inviteOrgAdmin(inviteReq({ email: 'a@b.kr', role: 'SUPER' }), ORG);
    expect(res.status).toBe(400);
    expect(state.inserted).toEqual([]);
  });
  it('이메일 꼴', async () => {
    expect((await inviteOrgAdmin(inviteReq({ email: 'nope' }), ORG)).status).toBe(400);
    expect((await inviteOrgAdmin(inviteReq({}), ORG)).status).toBe(400);
  });
  it('최상위 부서 중 먼저 만든 것으로', async () => {
    const res = await inviteOrgAdmin(inviteReq({ email: ' Kim@B.kr ' }), ORG);
    expect(res.status).toBe(200);
    expect(state.calls).toContainEqual(['departments.is', 'parent_id', null]);
    expect(state.calls).toContainEqual(['departments.order', 'created_at', { ascending: true }]);
    expect(state.inserted[0]).toMatchObject({ email: 'kim@b.kr', department_id: 'dept-top', role: 'ADMIN' });
    const body = await res.json();
    expect(body.data.inviteUrl).toMatch(/^https:\/\/app\.example\/signup\?invite=[0-9a-f]{64}$/);
  });
  it('기록에는 이메일·역할만 — 초대 열쇠 없음', async () => {
    await inviteOrgAdmin(inviteReq({ email: 'a@b.kr', role: 'USER' }), ORG);
    expect(state.audits).toEqual([expect.objectContaining({ action: 'invitation_created', target_type: 'organization', target_id: 'org-1', after_data: { email: 'a@b.kr', role: 'USER' } })]);
    expect(JSON.stringify(state.audits)).not.toMatch(/token|invite=/);
  });
  it('부서가 없으면 소속 없는 초대를 만들지 않음(400)', async () => {
    state.depts = { data: [], error: null };
    const res = await inviteOrgAdmin(inviteReq({ email: 'a@b.kr' }), ORG);
    expect(res.status).toBe(400);
    expect(state.inserted).toEqual([]);
  });
});
