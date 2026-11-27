// tests/batch-0344.test.ts
// 시민용 민원 상담 창(2026-11-27) — 0136(시민 전용 비서 tier·설정·기록·하루 횟수 함수·부서 사용액 제외)과 시민 전용 비서 권한.
// 설계 docs/superpowers/specs/2026-11-27-public-ask-design.md
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canDeleteAgent, canEditAgent, canUseAgent } from '@/lib/agent-permissions';

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe.skipIf(!dbUrl)('0136 — 시민 상담 표와 함수(시험 DB)', () => {
  let db: pg.Client;
  const org = randomUUID();
  const dept = randomUUID();
  beforeAll(async () => {
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });

  async function inTx(fn: () => Promise<void>) {
    await db.query('BEGIN');
    try {
      await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [org, '0136 기관']);
      await db.query('INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)', [dept, '총무팀', `d-${dept.slice(0, 8)}`, org]);
      await fn();
    } finally {
      await db.query('ROLLBACK');
    }
  }

  it('시민 전용 비서 — tier public을 받고 기관마다 하나만', async () => {
    await inTx(async () => {
      await db.query("INSERT INTO agents (name, department_id, organization_id, tier, visibility) VALUES ('시민 상담', $1, $2, 'public', 'organization')", [dept, org]);
      await db.query('SAVEPOINT s');
      await expect(db.query("INSERT INTO agents (name, department_id, organization_id, tier, visibility) VALUES ('시민 상담 2', $1, $2, 'public', 'organization')", [dept, org])).rejects.toThrow();
      await db.query('ROLLBACK TO SAVEPOINT s');
      await expect(db.query("INSERT INTO agents (name, department_id, organization_id, tier, visibility) VALUES ('엉뚱', $1, $2, 'visitor', 'organization')", [dept, org])).rejects.toThrow();
    });
  });

  it('하루 횟수 — IP 상한은 모든 시도, 기관 상한은 모델을 부른 시도만, 마감·거절 줄엔 글이 없음', async () => {
    await inTx(async () => {
      const day = new Date(Date.now() - 60_000).toISOString();
      const claim = async (ip: string, ipCap: number, orgCap: number) => (await db.query('SELECT public_ask_claim($1, $2, $3, $4, $5) AS r', [org, ip, day, ipCap, orgCap])).rows[0].r;
      expect((await claim(HASH_A, 2, 10)).status).toBe('ok');
      const second = await claim(HASH_A, 2, 10);
      expect(second.status).toBe('ok');
      // 개인정보로 거절한 줄은 기관 상한에서 빠진다
      await db.query("UPDATE public_ask_logs SET result = 'rejected_pii' WHERE id = $1", [second.id]);
      expect((await claim(HASH_A, 2, 10)).status).toBe('capped_ip');
      expect((await claim(HASH_B, 5, 1)).status).toBe('capped_org');
      const rows = (await db.query("SELECT result, question FROM public_ask_logs WHERE organization_id = $1 ORDER BY created_at", [org])).rows;
      expect(rows.map((r: { result: string }) => r.result).sort()).toEqual(['answering', 'capped_ip', 'capped_org', 'rejected_pii']);
      await db.query('SAVEPOINT s');
      await expect(db.query("INSERT INTO public_ask_logs (organization_id, ip_hash, result, question) VALUES ($1, $2, 'capped_ip', '글')", [org, HASH_A])).rejects.toThrow();
      await db.query('ROLLBACK TO SAVEPOINT s');
    });
  });

  it('설정 — 켤 때는 켠 때·사유가 있어야, 상한은 범위 안', async () => {
    await inTx(async () => {
      await db.query('SAVEPOINT s');
      await expect(db.query('INSERT INTO public_ask_settings (organization_id, enabled) VALUES ($1, true)', [org])).rejects.toThrow();
      await db.query('ROLLBACK TO SAVEPOINT s');
      await expect(db.query('INSERT INTO public_ask_settings (organization_id, ip_daily_cap) VALUES ($1, 101)', [org])).rejects.toThrow();
      await db.query('ROLLBACK TO SAVEPOINT s');
      await db.query("INSERT INTO public_ask_settings (organization_id, enabled, enabled_at, enabled_reason) VALUES ($1, true, now(), '시민 상담 시작')", [org]);
    });
  });

  it('부서 사용액은 시민 상담(public_ask)을 세지 않는다', async () => {
    await inTx(async () => {
      await db.query("INSERT INTO usage_logs (department_id, action, details) VALUES ($1, 'chat_message', '{\"cost_krw\": 100}'), ($1, 'public_ask', '{\"cost_krw\": 50}')", [dept]);
      const r = await db.query("SELECT department_spend_krw($1, now() - interval '1 day', now() + interval '1 day') AS s", [dept]);
      expect(Number(r.rows[0].s)).toBe(100);
    });
  });
});

describe('시민 전용 비서 권한', () => {
  const actor = (whole: boolean) => ({ userId: 'u1', organizationId: 'o1', departmentId: 'd1', visibleDepartmentIds: ['d1'], managedDepartmentIds: ['d1'], isAdmin: true, managesWholeOrganization: whole }) as never;
  const agent = { id: 'a1', tier: 'public', organization_id: 'o1', department_id: 'd1', owner_id: null, visibility: 'organization', is_active: true, is_published: true, deleted_at: null } as never;
  it('직원은 쓰지 못하고(기관 전체 관리자도 대화로는 못 씀), 고치기·지우기는 기관 전체 관리자만', () => {
    expect(canUseAgent(agent, actor(true))).toBe(false);
    expect(canUseAgent(agent, actor(false))).toBe(false);
    expect(canEditAgent(agent, actor(true))).toBe(true);
    expect(canEditAgent(agent, actor(false))).toBe(false);
    expect(canDeleteAgent(agent, actor(true))).toBe(true);
    expect(canDeleteAgent(agent, actor(false))).toBe(false);
    expect(canEditAgent({ ...(agent as object), organization_id: 'o2' } as never, actor(true))).toBe(false);
  });
  it('마이그레이션 — 부서 사용액에서 public_ask를 뺀다', () => {
    expect(readFileSync('supabase/migrations/0136_public_ask.sql', 'utf8')).toContain("AND action <> 'public_ask'");
  });
});

describe('시민 전용 비서는 직원 목록·기관 API에 나오지 않는다', () => {
  const read = (p: string) => readFileSync(p, 'utf8');
  it('비서 목록(직원·즐겨찾기·관리)·카테고리 수·대시보드 수가 public을 뺀다', () => {
    const agents = read('src/app/api/agents/route.ts');
    expect(agents.match(/neq\('tier', 'public'\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(read('src/app/api/admin/agent-categories/route.ts')).toContain(".neq('tier', 'public')");
    expect(read('src/app/api/stats/route.ts')).toContain(".neq('tier', 'public')");
  });
  it('앱 목록과 기관 API의 쓸 수 있는 비서에서 빠진다', async () => {
    expect(read('src/lib/apps/catalog.ts')).toContain("a.tier !== 'public'");
    const { writableAgent } = await import('@/lib/org-api/spec');
    expect(writableAgent({ id: 'a', tier: 'public', organization_id: 'o1', deleted_at: null } as never, 'o1')).toBe(false);
    expect(writableAgent({ id: 'a', tier: 'official', organization_id: 'o1', deleted_at: null } as never, 'o1')).toBe(true);
  });
});
