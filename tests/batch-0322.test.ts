// tests/batch-0322.test.ts
// 나만의 비서 함께 고치기(2026-11-26, 0129) — 함께 쓰는 사람 가운데 주인이 고른 사람은 설정·문서·양식까지 고친다.
// 지우기·공유 바꾸기·부서 비서로 올리기·공식 신청은 주인만.
import { readFileSync } from 'fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'crypto';
import {
  AGENT_ACCESS_COLUMNS, canDeleteAgent, canEditAgent, canPromoteToDepartment, canRequestOfficial, canUseAgent, isSharedEditor, type ActorScope, type AgentAccessInfo,
} from '@/lib/agent-permissions';
import { canManageShares, setAgentShares, type AgentSharesIo } from '@/lib/agent-shares';
import { sharesBody } from '@/components/agents/SharesPanel';

const OWNER = '11111111-1111-4111-8111-111111111111';
const EDITOR = '22222222-2222-4222-8222-222222222222';
const VIEWER = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';
const ORG = 'org-1';
const agent = (over: Partial<AgentAccessInfo> = {}): AgentAccessInfo => ({
  id: AGENT, tier: 'personal', department_id: 'd1', organization_id: ORG, visibility: 'department', owner_id: OWNER, created_by: OWNER,
  is_active: true, is_published: true, deleted_at: null, approval_status: null, version: 3, approval_version: null,
  shared_user_ids: [EDITOR, VIEWER], shared_editor_ids: [EDITOR], ...over,
});
const actor = (userId: string): ActorScope => ({ userId, isAdmin: false, departmentId: 'd2', organizationId: ORG, visibleDepartmentIds: ['d2'], managedDepartmentIds: [], managesWholeOrganization: false });

describe('권한 — 고치기까지, 주인 일은 주인만', () => {
  it('함께 고치는 사람은 쓰고 고친다 — 지우기·올리기·신청·공유 바꾸기는 못 한다', () => {
    expect(canUseAgent(agent(), actor(EDITOR))).toBe(true);
    expect(canEditAgent(agent(), actor(EDITOR))).toBe(true);
    expect(canDeleteAgent(agent(), actor(EDITOR))).toBe(false);
    expect(canPromoteToDepartment(agent(), actor(EDITOR))).toBe(false);
    expect(canRequestOfficial(agent(), actor(EDITOR))).toBe(false);
    expect(canManageShares(agent(), actor(EDITOR))).toBe(false);
  });
  it('쓰기만 하는 사람은 고치지 못하고, 주인은 예전 그대로', () => {
    expect(canEditAgent(agent(), actor(VIEWER))).toBe(false);
    expect(canEditAgent(agent(), actor(OWNER))).toBe(true);
    expect(canPromoteToDepartment(agent(), actor(OWNER))).toBe(true);
    expect(canRequestOfficial(agent(), actor(OWNER))).toBe(true);
    expect(canDeleteAgent(agent(), actor(OWNER))).toBe(true);
  });
  it('함께 쓰는 사람에서 빠졌거나 칸을 안 읽은 곳·부서 비서면 고치지 못한다', () => {
    expect(isSharedEditor(agent({ shared_user_ids: [VIEWER] }), actor(EDITOR))).toBe(false);
    expect(canEditAgent(agent({ shared_editor_ids: undefined }), actor(EDITOR))).toBe(false);
    expect(isSharedEditor(agent({ tier: 'department' }), actor(EDITOR))).toBe(false);
    expect(AGENT_ACCESS_COLUMNS).toContain('shared_editor_ids');
  });
});

describe('정하기', () => {
  const users = [
    { id: EDITOR, email: 'ed@x.kr', full_name: '고침', is_active: true, deleted_at: null, is_super_admin: false, department_id: 'd2' },
    { id: VIEWER, email: 'vw@x.kr', full_name: '씀', is_active: true, deleted_at: null, is_super_admin: false, department_id: 'd2' },
  ];
  const io = (): AgentSharesIo & { save: ReturnType<typeof vi.fn> } => ({
    loadAgent: async () => agent({ shared_user_ids: [], shared_editor_ids: [] }),
    usersByEmail: async (emails) => users.filter((u) => emails.includes(u.email)),
    usersById: async (ids) => users.filter((u) => ids.includes(u.id)),
    departments: async () => new Map([['d2', { organization_id: ORG, name: '총무과' }]]),
    save: vi.fn(async () => true),
    orgDepartments: async () => [],
    saveDepartments: async () => true,
    log: vi.fn(async () => {}),
  });
  it('함께 고칠 사람은 함께 쓸 사람 안에서만 — 역할과 함께 돌려준다', async () => {
    const d = io();
    const out = await setAgentShares(d, actor(OWNER), AGENT, ['ed@x.kr', 'vw@x.kr'], ['ed@x.kr']);
    expect(d.save).toHaveBeenCalledWith(AGENT, OWNER, [EDITOR, VIEWER], [EDITOR]);
    expect(out.ok && out.shares.map((s) => [s.id, s.role])).toEqual([[EDITOR, 'editor'], [VIEWER, 'viewer']]);
    expect(await setAgentShares(io(), actor(OWNER), AGENT, ['vw@x.kr'], ['ed@x.kr'])).toMatchObject({ ok: false, status: 400 });
  });
  it('화면 저장 몸 — 바꾼 줄만, 빼면 고치기도 빠진다', () => {
    const rows = [{ id: EDITOR, email: 'ed@x.kr', name: null, department: null, role: 'editor' as const }, { id: VIEWER, email: 'vw@x.kr', name: null, department: null, role: 'viewer' as const }];
    expect(sharesBody(rows)).toEqual({ emails: ['ed@x.kr', 'vw@x.kr'], editors: ['ed@x.kr'] });
    expect(sharesBody(rows, { editor: { id: VIEWER, on: true } }).editors).toEqual(['ed@x.kr', 'vw@x.kr']);
    expect(sharesBody(rows, { remove: EDITOR })).toEqual({ emails: ['vw@x.kr'], editors: [] });
    expect(sharesBody(rows, { add: ['new@x.kr', 'vw@x.kr'] }).emails).toEqual(['ed@x.kr', 'vw@x.kr', 'new@x.kr']);
  });
});

describe('연결', () => {
  it('함께 고치는 사람이 있으면 판 번호를 받아야 저장 — 목록·카드·라우트', () => {
    const route = readFileSync('src/app/api/agents/[id]/route.ts', 'utf8');
    expect(route).toContain("else if (agent.tier === 'personal' && !(agent.shared_editor_ids ?? []).length) baseVersion = agent.version;");
    expect(readFileSync('src/app/api/agents/route.ts', 'utf8')).toContain('shared_can_edit: isSharedEditor(info, actor)');
    expect(readFileSync('src/components/chat/AgentCard.tsx', 'utf8')).toContain('(canManage || (agent.shared_with_me && agent.shared_can_edit)) && onEdit');
    expect(readFileSync('src/app/api/agents/[id]/shares/route.ts', 'utf8')).toContain('setAgentShares(io, actor, params.id, emails, editors)');
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0129 — 함께 고치는 사람은 함께 쓰는 사람 안에서만(시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('CHECK·두 번 적용', async () => {
    const sql = readFileSync('supabase/migrations/0129_agent_share_editors.sql', 'utf8');
    await db.query('BEGIN');
    try {
      await db.query(sql); await db.query(sql);
      const org = randomUUID(); const dept = randomUUID(); const a = randomUUID(); const b = randomUUID();
      await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [org, '0129 기관']);
      await db.query("INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, '총무과', $2, $3)", [dept, `d-${dept.slice(0, 8)}`, org]);
      const ok = async (sql2: string, params: unknown[]) => { await db.query('SAVEPOINT s'); try { await db.query(sql2, params); await db.query('RELEASE SAVEPOINT s'); return true; } catch { await db.query('ROLLBACK TO SAVEPOINT s'); return false; } };
      const ins = "INSERT INTO agents (name, department_id, organization_id, tier, visibility, shared_user_ids, shared_editor_ids) VALUES ('함께', $1, $2, 'personal', 'department', $3, $4)";
      expect(await ok(ins, [dept, org, [a, b], [a]])).toBe(true);
      expect(await ok(ins, [dept, org, [b], [a]])).toBe(false);
      expect(await ok(ins, [dept, org, [], []])).toBe(true);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
