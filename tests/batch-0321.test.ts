// tests/batch-0321.test.ts
// 나만의 비서·앱 함께 쓰기(2026-11-26, 0128) — 주인이 같은 기관 동료를 골라 함께 쓰게 한다(쓰기만, 고치기는 주인만).
import { readFileSync } from 'fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { AGENT_ACCESS_COLUMNS, canDeleteAgent, canEditAgent, canUseAgent, isSharedWith, type ActorScope, type AgentAccessInfo } from '@/lib/agent-permissions';
import { AGENT_SHARES_MAX, canManageShares, getAgentShares, parseShareEmails, setAgentShares, type AgentSharesIo } from '@/lib/agent-shares';
import { splitShareEmails } from '@/components/agents/SharesPanel';

const OWNER = '11111111-1111-4111-8111-111111111111';
const MATE = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';
const ORG = 'org-1';

const agent = (over: Partial<AgentAccessInfo> = {}): AgentAccessInfo => ({
  id: AGENT, tier: 'personal', department_id: 'd-owner', organization_id: ORG, visibility: 'department', owner_id: OWNER, created_by: OWNER,
  is_active: true, is_published: true, deleted_at: null, approval_status: null, version: 1, approval_version: null, shared_user_ids: [MATE], ...over,
});
const actor = (userId: string, over: Partial<ActorScope> = {}): ActorScope => ({
  userId, isAdmin: false, departmentId: 'd-other', organizationId: ORG, visibleDepartmentIds: ['d-other'], managedDepartmentIds: [], managesWholeOrganization: false, ...over,
});

describe('권한 — 쓰기만', () => {
  it('함께 쓰는 동료는 쓸 수 있고 고치기·지우기는 못 한다', () => {
    expect(canUseAgent(agent(), actor(MATE))).toBe(true);
    expect(canEditAgent(agent(), actor(MATE))).toBe(false);
    expect(canDeleteAgent(agent(), actor(MATE))).toBe(false);
    expect(isSharedWith(agent(), actor(MATE.toUpperCase()))).toBe(true);
    expect(isSharedWith(agent(), actor(OWNER))).toBe(false);
  });
  it('다른 사람·다른 기관·꺼진 비서·지운 비서·부서 비서의 칸은 아니다', () => {
    expect(canUseAgent(agent(), actor(OTHER))).toBe(false);
    expect(canUseAgent(agent(), actor(MATE, { organizationId: 'org-2' }))).toBe(false);
    expect(canUseAgent(agent({ is_active: false }), actor(MATE))).toBe(false);
    expect(canUseAgent(agent({ deleted_at: '2026-11-26T00:00:00Z' }), actor(MATE))).toBe(false);
    expect(canUseAgent(agent({ tier: 'department' }), actor(MATE))).toBe(false);
    // 칸을 읽지 않은 곳(없음)은 주인만
    expect(canUseAgent(agent({ shared_user_ids: undefined }), actor(MATE))).toBe(false);
    expect(AGENT_ACCESS_COLUMNS).toContain('shared_user_ids');
  });
});

describe('이메일 받기', () => {
  it('다듬어 소문자·한 번·20명까지, 틀린 꼴은 거절', () => {
    expect(parseShareEmails([' A@X.go.kr', 'a@x.go.kr', '', 'b@y.kr'])).toEqual(['a@x.go.kr', 'b@y.kr']);
    expect(parseShareEmails([])).toEqual([]);
    expect(parseShareEmails(['nope'])).toBeNull();
    expect(parseShareEmails('a@x.kr')).toBeNull();
    expect(parseShareEmails(Array.from({ length: AGENT_SHARES_MAX + 1 }, (_, i) => `u${i}@x.kr`))).toBeNull();
    expect(splitShareEmails('a@x.kr, B@x.kr\nc@x.kr a@x.kr')).toEqual(['a@x.kr', 'b@x.kr', 'c@x.kr']);
  });
});

function io(over: Partial<AgentSharesIo> = {}) {
  const users = [
    { id: MATE, email: 'mate@x.kr', full_name: '김동료', is_active: true, deleted_at: null, is_super_admin: false, department_id: 'd-other' },
    { id: OTHER, email: 'far@y.kr', full_name: '다른기관', is_active: true, deleted_at: null, is_super_admin: false, department_id: 'd-far' },
    { id: '55555555-5555-4555-8555-555555555555', email: 'off@x.kr', full_name: '중지', is_active: false, deleted_at: null, is_super_admin: false, department_id: 'd-other' },
    { id: OWNER, email: 'me@x.kr', full_name: '주인', is_active: true, deleted_at: null, is_super_admin: false, department_id: 'd-owner' },
  ];
  const depts = new Map([['d-other', { organization_id: ORG, name: '총무과' }], ['d-owner', { organization_id: ORG, name: '기획과' }], ['d-far', { organization_id: 'org-2', name: '남의과' }]]);
  const save = vi.fn(async () => true);
  const log = vi.fn(async () => {});
  const d: AgentSharesIo = {
    loadAgent: async () => agent({ shared_user_ids: [] }),
    usersByEmail: async (emails) => users.filter((u) => emails.includes(u.email)),
    usersById: async (ids) => users.filter((u) => ids.includes(u.id)),
    departments: async (ids) => new Map([...depts].filter(([k]) => ids.includes(k))),
    save, log, orgDepartments: async () => [], saveDepartments: async () => true, ...over,
  };
  return { d, save, log };
}

describe('함께 쓸 사람 정하기', () => {
  it('주인만 — 같은 기관의 사용 중인 직원으로, 더한 사람을 보안 로그에', async () => {
    const { d, save, log } = io();
    const out = await setAgentShares(d, actor(OWNER, { departmentId: 'd-owner' }), AGENT, ['mate@x.kr']);
    expect(out).toEqual({ ok: true, shares: [{ id: MATE, email: 'mate@x.kr', name: '김동료', department: '총무과', role: 'viewer' }] });
    expect(save).toHaveBeenCalledWith(AGENT, OWNER, [MATE], []);
    expect((log.mock.calls[0] as unknown[])[1]).toMatchObject({ agent_id: AGENT, added: [MATE], removed: [], count: 1 });
  });
  it('거절 — 주인 아님 403·다른 기관/사용 중지/모르는 이메일 400·본인 400·그 사이 바뀜 409·못 읽음 503', async () => {
    const owner = actor(OWNER, { departmentId: 'd-owner' });
    expect(await setAgentShares(io().d, actor(MATE), AGENT, ['far@y.kr'])).toMatchObject({ ok: false, status: 403 });
    expect(await setAgentShares(io().d, owner, AGENT, ['far@y.kr'])).toMatchObject({ ok: false, status: 400, message: expect.stringContaining('far@y.kr') });
    expect(await setAgentShares(io().d, owner, AGENT, ['off@x.kr'])).toMatchObject({ ok: false, status: 400 });
    expect(await setAgentShares(io().d, owner, AGENT, ['ghost@x.kr'])).toMatchObject({ ok: false, status: 400 });
    expect(await setAgentShares(io().d, owner, AGENT, ['me@x.kr'])).toMatchObject({ ok: false, status: 400, message: expect.stringContaining('본인') });
    expect(await setAgentShares(io({ save: async () => false }).d, owner, AGENT, ['mate@x.kr'])).toMatchObject({ ok: false, status: 409 });
    expect(await setAgentShares(io({ loadAgent: async () => { throw new Error('x'); } }).d, owner, AGENT, [])).toMatchObject({ ok: false, status: 503 });
    expect(await setAgentShares(io({ loadAgent: async () => agent({ tier: 'department' }) }).d, owner, AGENT, [])).toMatchObject({ ok: false, status: 403 });
    expect(await setAgentShares(io().d, owner, 'bad', [])).toMatchObject({ ok: false, status: 404 });
  });
  it('빈 목록이면 모두 빼고 뺀 사람을 남긴다, 목록은 주인만 본다', async () => {
    const { d, log } = io({ loadAgent: async () => agent() });
    const owner = actor(OWNER, { departmentId: 'd-owner' });
    expect(await setAgentShares(d, owner, AGENT, [])).toEqual({ ok: true, shares: [] });
    expect((log.mock.calls[0] as unknown[])[1]).toMatchObject({ added: [], removed: [MATE], count: 0 });
    expect(await getAgentShares(d, owner, AGENT)).toEqual({ ok: true, shares: [{ id: MATE, email: 'mate@x.kr', name: '김동료', department: '총무과', role: 'viewer' }] });
    expect(await getAgentShares(d, actor(MATE), AGENT)).toMatchObject({ ok: false, status: 403 });
    expect(canManageShares(agent(), actor(OWNER))).toBe(true);
  });
});

describe('연결', () => {
  it('목록에 함께 쓰는 비서를 권한으로 다시 걸러 싣고, 화면은 고치기를 숨긴다', () => {
    const route = readFileSync('src/app/api/agents/route.ts', 'utf8');
    expect(route).toContain('.or(`owner_id.eq.${me},shared_user_ids.cs.{${me}}');
    expect(route).toContain('if (!actor || !(isSharedWith(info, actor) || isSharedByDepartment(info, actor)) || !canUseAgent(info, actor)) return [];');
    expect(route).toContain('shared_with_me: true');
    const card = readFileSync('src/components/chat/AgentCard.tsx', 'utf8');
    expect(card).toContain("(agent.tier === 'personal' && !agent.shared_with_me)");
    expect(readFileSync('src/app/api/agents/[id]/shares/route.ts', 'utf8')).toContain('isImpersonating');
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0128 — 칸·CHECK(시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('기본 빈 배열·20명까지·두 번 적용해도 안전', async () => {
    const sql = readFileSync('supabase/migrations/0128_agent_shares.sql', 'utf8');
    await db.query('BEGIN');
    try {
      await db.query(sql); await db.query(sql);
      const col = await db.query(`SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name='agents' AND column_name='shared_user_ids'`);
      expect(col.rows[0]).toMatchObject({ is_nullable: 'NO' });
      const chk = await db.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='agents_shared_user_ids_check'`);
      expect(chk.rows[0].d).toContain('20');
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
