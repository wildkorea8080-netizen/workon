// tests/batch-0323.test.ts
// 나만의 비서를 부서 단위로 함께 쓰기(2026-11-26, 0130) — 고른 부서와 그 하위 부서 사람 모두 쓰기만.
import { readFileSync } from 'fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { AGENT_ACCESS_COLUMNS, canEditAgent, canUseAgent, isSharedByDepartment, type ActorScope, type AgentAccessInfo } from '@/lib/agent-permissions';
import { getShareDepartments, parseShareDepartments, setShareDepartments, type AgentSharesIo } from '@/lib/agent-shares';

const OWNER = '11111111-1111-4111-8111-111111111111';
const AGENT = '44444444-4444-4444-8444-444444444444';
const D_PARENT = 'aaaaaaaa-0000-4000-8000-000000000001';
const D_CHILD = 'aaaaaaaa-0000-4000-8000-000000000002';
const D_OTHER = 'aaaaaaaa-0000-4000-8000-000000000003';
const ORG = 'org-1';
const agent = (over: Partial<AgentAccessInfo> = {}): AgentAccessInfo => ({
  id: AGENT, tier: 'personal', department_id: 'd-owner', organization_id: ORG, visibility: 'department', owner_id: OWNER, created_by: OWNER,
  is_active: true, is_published: true, deleted_at: null, approval_status: null, version: 1, approval_version: null,
  shared_user_ids: [], shared_editor_ids: [], shared_department_ids: [D_PARENT], ...over,
});
const actor = (userId: string, visible: string[]): ActorScope => ({ userId, isAdmin: false, departmentId: visible[0], organizationId: ORG, visibleDepartmentIds: visible, managedDepartmentIds: [], managesWholeOrganization: false });
const U = '22222222-2222-4222-8222-222222222222';

describe('권한 — 부서와 하위 부서는 쓰기만', () => {
  it('고른 부서·하위 부서 사람은 쓰고, 다른 부서는 못 쓰며, 아무도 고치지 못한다', () => {
    expect(canUseAgent(agent(), actor(U, [D_PARENT]))).toBe(true);
    expect(canUseAgent(agent(), actor(U, [D_CHILD, D_PARENT]))).toBe(true);
    expect(canUseAgent(agent(), actor(U, [D_OTHER]))).toBe(false);
    expect(canEditAgent(agent(), actor(U, [D_PARENT]))).toBe(false);
    // 하위 부서를 고르면 상위 부서는 못 쓴다(방향은 부서 비서와 같다)
    expect(canUseAgent(agent({ shared_department_ids: [D_CHILD] }), actor(U, [D_PARENT]))).toBe(false);
    expect(isSharedByDepartment(agent(), actor(OWNER, [D_PARENT]))).toBe(false);
    expect(isSharedByDepartment(agent({ tier: 'department' }), actor(U, [D_PARENT]))).toBe(false);
    expect(AGENT_ACCESS_COLUMNS).toContain('shared_department_ids');
  });
});

describe('부서 정하기', () => {
  const choices = [{ id: D_PARENT, name: '기획본부', parent_id: null }, { id: D_CHILD, name: '기획과', parent_id: D_PARENT }];
  const io = (over: Partial<AgentSharesIo> = {}) => {
    const saveDepartments = vi.fn(async () => true);
    const log = vi.fn(async () => {});
    const d: AgentSharesIo = {
      loadAgent: async () => agent({ shared_department_ids: [D_PARENT] }),
      usersByEmail: async () => [], usersById: async () => [], departments: async () => new Map(), save: async () => true,
      orgDepartments: async () => choices, saveDepartments, log, ...over,
    };
    return { d, saveDepartments, log };
  };
  const owner = actor(OWNER, ['d-owner']);
  it('이 기관 부서만 — 바꾼 부서를 보안 로그에', async () => {
    const { d, saveDepartments, log } = io();
    expect(await setShareDepartments(d, owner, AGENT, [D_CHILD])).toEqual({ ok: true, selected: [choices[1]] });
    expect(saveDepartments).toHaveBeenCalledWith(AGENT, OWNER, [D_CHILD]);
    expect((log.mock.calls[0] as unknown[])[1]).toMatchObject({ departments_added: [D_CHILD], departments_removed: [D_PARENT], department_count: 1 });
    expect(await getShareDepartments(d, owner, AGENT)).toEqual({ ok: true, selected: [choices[0]], choices });
  });
  it('거절 — 다른 기관 부서 400·주인 아님 403·그 사이 바뀜 409·목록 못 읽음 503', async () => {
    expect(await setShareDepartments(io().d, owner, AGENT, [D_OTHER])).toMatchObject({ ok: false, status: 400 });
    expect(await setShareDepartments(io().d, actor(U, [D_PARENT]), AGENT, [])).toMatchObject({ ok: false, status: 403 });
    expect(await setShareDepartments(io({ saveDepartments: async () => false }).d, owner, AGENT, [])).toMatchObject({ ok: false, status: 409 });
    expect(await setShareDepartments(io({ orgDepartments: async () => { throw new Error('x'); } }).d, owner, AGENT, [])).toMatchObject({ ok: false, status: 503 });
  });
  it('요청 몸 — uuid만·한 번·20곳까지', () => {
    expect(parseShareDepartments([D_PARENT.toUpperCase(), D_PARENT])).toEqual([D_PARENT]);
    expect(parseShareDepartments(['x'])).toBeNull();
    expect(parseShareDepartments('x')).toBeNull();
    expect(parseShareDepartments(Array.from({ length: 21 }, (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`))).toBeNull();
  });
});

describe('연결', () => {
  it('목록이 내 부서 계통으로 찾고, 라우트가 사람·부서를 따로 바꾼다', () => {
    const list = readFileSync('src/app/api/agents/route.ts', 'utf8');
    expect(list).toContain('shared_department_ids.ov.{${depts.join');
    expect(list).toContain('isSharedByDepartment(info, actor)');
    const route = readFileSync('src/app/api/agents/[id]/shares/route.ts', 'utf8');
    expect(route).toContain('if (body.emails === undefined && body.departments === undefined)');
    expect(route).toContain('setShareDepartments(io, actor, params.id, departments)');
    expect(readFileSync('src/components/agents/SharesPanel.tsx', 'utf8')).toContain('aria-label="함께 쓸 부서 더하기"');
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0130 — 칸·CHECK(시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('20곳까지·두 번 적용해도 안전', async () => {
    const sql = readFileSync('supabase/migrations/0130_agent_share_departments.sql', 'utf8');
    await db.query('BEGIN');
    try {
      await db.query(sql); await db.query(sql);
      const chk = await db.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='agents_shared_department_ids_check'`);
      expect(chk.rows[0].d).toContain('20');
      const idx = await db.query(`SELECT indexdef FROM pg_indexes WHERE indexname='agents_shared_department_ids_idx'`);
      expect(idx.rows[0].indexdef).toContain('gin');
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
