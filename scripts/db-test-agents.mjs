/**
 * save_agent · 트리거를 실제 DB에서 확인한다.
 *
 *   npm run db:test-agents
 *
 * 한 트랜잭션 안에서 만들고 확인한 뒤 ROLLBACK한다. 아무것도 남지 않는다.
 * 단위 테스트로는 이 프로젝트에서 실제로 난 버그(트리거 부재 등)를 못
 * 잡는다 — CLAUDE.md '검증 장치'.
 *
 * DATABASE_URL이 필요하다 (db:migrate와 같다).
 */
import { readFileSync, existsSync } from 'fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.trimStart().startsWith('#')) {
      const k = line.slice(0, eq).trim();
      if (!process.env[k]) process.env[k] = line.slice(eq + 1).trim();
    }
  }
}

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_DB_URL;
if (!url) {
  console.error('DATABASE_URL이 없습니다. npm run db:migrate 안내를 참고하세요.');
  process.exit(1);
}

const { default: pg } = await import('pg');
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

let failures = 0;
function check(label, pass, extra = '') {
  if (!pass) failures += 1;
  console.log(`${pass ? 'OK  ' : 'FAIL'}  ${label}${extra ? `  → ${extra}` : ''}`);
}

/** 오류가 나야 하는 문장. 세이브포인트로 감싸 트랜잭션을 살린다. */
async function expectError(label, sql, params, code) {
  await client.query('SAVEPOINT sp');
  try {
    await client.query(sql, params);
    check(label, false, '오류가 나지 않음');
  } catch (err) {
    check(label, err.code === code, `${err.code} ${err.message}`);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT sp');
  }
}

const tag = `db-test-${Date.now()}`;

try {
  await client.query('BEGIN');

  const { rows: [dept] } = await client.query(
    'SELECT id, organization_id FROM departments WHERE organization_id IS NOT NULL LIMIT 1'
  );
  if (!dept) throw new Error('기관에 연결된 부서가 없습니다.');

  // ── 생성 트리거 ──
  const { rows: [created] } = await client.query(
    `INSERT INTO agents (department_id, name, tier, capabilities)
     VALUES ($1, $2, 'official', '{"image":{}}') RETURNING id, version`,
    [dept.id, `${tag}-a`]
  );
  const { rows: h1 } = await client.query(
    `SELECT kind, version FROM agent_history WHERE agent_id = $1`, [created.id]
  );
  check('새 비서는 판 1이 남는다', h1.length === 1 && h1[0].kind === 'created' && h1[0].version === 1);

  // ── 저장과 동시 수정 ──
  const { rows: [conflict] } = await client.query(
    `SELECT save_agent($1, 0, '{"name":"x"}', NULL, 'settings') AS r`, [created.id]
  );
  check('판이 다르면 거절한다', conflict.r.reason === 'conflict' && conflict.r.current_version === 1);

  const { rows: [saved] } = await client.query(
    `SELECT save_agent($1, 1, $2, NULL, 'settings') AS r`,
    [created.id, JSON.stringify({ name: `${tag}-b`, system_prompt: '새 지시' })]
  );
  check('저장하면 판이 오른다', saved.r.ok === true && saved.r.version === 2);

  const { rows: [v2] } = await client.query(
    `SELECT snapshot, detail FROM agent_history WHERE agent_id = $1 AND version = 2`, [created.id]
  );
  check('판 사본에 새 값이 있다', v2?.snapshot?.system_prompt === '새 지시');
  check('바뀐 칸을 기록한다', JSON.stringify(v2?.detail?.fields) === JSON.stringify(['name', 'system_prompt']));

  // ── 되돌리기 ──
  const { rows: [v1] } = await client.query(
    `SELECT snapshot FROM agent_history WHERE agent_id = $1 AND version = 1`, [created.id]
  );
  const { rows: [reverted] } = await client.query(
    `SELECT save_agent($1, 2, $2, NULL, 'revert', '{"reverted_from":1}') AS r`,
    [created.id, JSON.stringify(v1.snapshot)]
  );
  const { rows: [afterRevert] } = await client.query(
    `SELECT name, system_prompt, version FROM agents WHERE id = $1`, [created.id]
  );
  check('되돌리기도 새 판이다', reverted.r.version === 3 && afterRevert.version === 3);
  check('되돌리면 옛 값이 돌아온다', afterRevert.name === `${tag}-a` && afterRevert.system_prompt === null);

  // ── 양식 상한 ──
  for (let i = 0; i < 11; i += 1) {
    await client.query(
      `INSERT INTO agent_templates (agent_id, name, storage_path, file_name, size_bytes)
       VALUES ($1, $2, 'x', 'x.hwpx', 1)`, [created.id, `양식${i}`]
    );
  }
  const { rows: tpl } = await client.query(
    `SELECT id, retired_at FROM agent_templates WHERE agent_id = $1 ORDER BY name`, [created.id]
  );
  check('새 양식은 꺼진 채로 들어간다', tpl.every((t) => t.retired_at !== null));
  await expectError(
    '양식 11개는 거절한다',
    `SELECT save_agent($1, 3, $2, NULL, 'settings')`,
    [created.id, JSON.stringify({ template_ids: tpl.map((t) => t.id) })],
    '23514'
  );
  const { rows: [ten] } = await client.query(
    `SELECT save_agent($1, 3, $2, NULL, 'settings') AS r`,
    [created.id, JSON.stringify({ template_ids: tpl.slice(0, 10).map((t) => t.id) })]
  );
  check('양식 10개는 받는다', ten.r.ok === true);

  // ── 옛 코드 호환 트리거 ──
  const { rows: [legacy] } = await client.query(
    `INSERT INTO agents (department_id, name, is_personal, enabled_connectors)
     VALUES ($1, $2, true, '{law}') RETURNING tier, capabilities`,
    [dept.id, `${tag}-legacy`]
  );
  check('옛 코드가 만든 나만의 비서도 단계가 찬다', legacy.tier === 'personal');
  check('옛 코드의 커넥터가 능력으로 옮겨진다',
    JSON.stringify(legacy.capabilities.public_data) === '{"connectors":["law"]}' && 'image' in legacy.capabilities);

  const { rows: [approved] } = await client.query(
    `UPDATE agents SET is_personal = false WHERE name = $1 RETURNING tier`, [`${tag}-legacy`]
  );
  check('옛 승인 코드가 is_personal만 바꿔도 단계가 따라간다', approved.tier === 'official');

  const { rows: [conn] } = await client.query(
    `UPDATE agents SET capabilities = '{"public_data":{"connectors":["kosis"]}}' WHERE id = $1
     RETURNING enabled_connectors`, [created.id]
  );
  check('새 능력이 옛 커넥터 칸으로 따라간다', JSON.stringify(conn.enabled_connectors) === '["kosis"]');

  // ── 이름 유일성 ──
  await expectError(
    '같은 부서에 같은 이름의 공유 비서는 막는다',
    `INSERT INTO agents (department_id, name, tier) VALUES ($1, $2, 'official')`,
    [dept.id, `${tag}-a`],
    '23505'
  );
  const { rows: users } = await client.query(
    'SELECT id FROM users WHERE department_id = $1 LIMIT 2', [dept.id]
  );
  if (users.length === 2) {
    for (const u of users) {
      await client.query(
        `INSERT INTO agents (department_id, name, tier, owner_id) VALUES ($1, $2, 'personal', $3)`,
        [dept.id, `${tag}-mine`, u.id]
      );
    }
    check('같은 부서의 두 직원이 같은 이름의 나만의 비서를 만든다', true);
  } else {
    console.log('건너뜀  같은 부서 직원이 둘 이상 없어 나만의 비서 이름 검사를 못 함');
  }

  // ── 부서 비서 제약 ──
  await expectError(
    '부서 비서는 기관 전체 공개가 될 수 없다',
    `INSERT INTO agents (department_id, name, tier, visibility) VALUES ($1, $2, 'department', 'organization')`,
    [dept.id, `${tag}-dept`],
    '23514'
  );

  // ── 단계 변경 ──
  const { rows: [tierChange] } = await client.query(
    `SELECT change_agent_tier($1, 'department', NULL, $2, 'department') AS r`,
    [created.id, dept.id]
  );
  const { rows: [tierRow] } = await client.query(
    `SELECT kind, detail, version FROM agent_history WHERE agent_id = $1 AND kind = 'tier'`, [created.id]
  );
  check('단계 변경은 기록되고 판 번호는 없다',
    tierChange.r.ok === true && tierRow?.version === null && tierRow?.detail?.to === 'department');
} catch (err) {
  failures += 1;
  console.error('FAIL  예기치 못한 오류:', err.message);
} finally {
  await client.query('ROLLBACK');
  await client.end();
}

console.log(failures === 0 ? '\n전부 통과. (ROLLBACK — 남은 데이터 없음)' : `\n실패 ${failures}건.`);
process.exit(failures === 0 ? 0 : 1);
