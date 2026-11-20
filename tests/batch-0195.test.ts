import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * 2026-11-19 — 옛 비서 즐겨찾기 길(`POST /api/agents/favorite`, 대화 화면의 별)을 행을 잠그는 DB 함수(0042 `set_user_app_favorite`)로.
 * 예전: 지금 목록을 읽어 고친 뒤 통째로 저장해, 거의 동시에 다른 비서 둘을 누르면 나중 저장이 앞 것을 지웠다.
 * uuid가 아닌 id는 즐겨찾기 칸(uuid 배열)에 못 들어가 DB 오류 500이었다 — 이제 400.
 */

describe('원본 확인', () => {
  const s = readFileSync('src/app/api/agents/favorite/route.ts', 'utf8');
  it('통째로 저장하지 않고 DB 함수로', () => {
    expect(s).toContain("supabaseAdmin.rpc('set_user_app_favorite', {");
    expect(s).toContain("p_kind: 'agent', p_key: agentId, p_favorite: !isFavorite");
    expect(s).not.toContain('.update({ favorite_agent_ids: updated })');
  });
  it('uuid가 아니면 400, 상한(22023)은 400, 그 밖의 저장 실패는 503', () => {
    expect(s).toContain("if (!UUID.test(agentId)) return jsonError('비서 형식이 올바르지 않습니다.', 400);");
    expect(s).toContain("if (error.code === '22023') return jsonError(`즐겨찾기는 ${MAX_FAVORITES}개까지 등록할 수 있습니다.`, 400);");
    expect(s).toContain("return jsonError('즐겨찾기를 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);");
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;

describe.skipIf(!url)('set_user_app_favorite — 동시에 눌러도 둘 다 남음(시험 DB)', () => {
  let a: pg.Client; let b: pg.Client;
  const orgId = randomUUID(); const deptId = randomUUID(); const userId = randomUUID();
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    a = new pg.Client({ connectionString: url }); b = new pg.Client({ connectionString: url });
    await a.connect(); await b.connect();
    await a.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, `기관-${orgId.slice(0, 6)}`]);
    await a.query('INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)', [deptId, '총무과', `d-${deptId.slice(0, 8)}`, orgId]);
    await a.query('INSERT INTO users (id, email, department_id) VALUES ($1, $2, $3)', [userId, `${userId}@test.local`, deptId]);
  });
  afterAll(async () => {
    await a?.query('DELETE FROM users WHERE id = $1', [userId]);
    await a?.query('DELETE FROM departments WHERE id = $1', [deptId]);
    await a?.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    await a?.end(); await b?.end();
  });
  it('다른 비서 둘을 거의 동시에 더하면 둘 다', async () => {
    const x = randomUUID(); const y = randomUUID();
    await Promise.all([
      a.query('SELECT public.set_user_app_favorite($1, $2, $3, true)', [userId, 'agent', x]),
      b.query('SELECT public.set_user_app_favorite($1, $2, $3, true)', [userId, 'agent', y]),
    ]);
    const { rows: [row] } = await a.query('SELECT favorite_agent_ids FROM users WHERE id = $1', [userId]);
    expect([...row.favorite_agent_ids].sort()).toEqual([x, y].sort());
    // 빼기
    await a.query('SELECT public.set_user_app_favorite($1, $2, $3, false)', [userId, 'agent', x]);
    const { rows: [after] } = await a.query('SELECT favorite_agent_ids FROM users WHERE id = $1', [userId]);
    expect(after.favorite_agent_ids).toEqual([y]);
  });
});
