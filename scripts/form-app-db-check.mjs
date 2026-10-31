/** Bounded form/version integration check. All DB test rows are rolled back. */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) { const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2'); }
const { validateAppDefinition, renderAppInput, appOutputInstruction } = await import('../src/lib/apps/definition.ts');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query('BEGIN');
  const { rows: [dept] } = await client.query('SELECT id FROM departments WHERE organization_id IS NOT NULL LIMIT 1');
  assert(dept);
  const definition = { schemaVersion: 1, fields: [{ key: 'source', label: '원문', type: 'textarea', required: true }], output: 'bullets' };
  if (process.argv.includes('--conditional')) {
    definition.fields.push({ key: 'review', label: '검토 여부', type: 'select', required: false, options: ['예', '아니오'] });
    definition.steps = [{ name: '검토', instruction: '원문을 검토하세요.', when: { field: 'review', equals: '예' } }, { name: '최종 작성', instruction: '최종 초안을 작성하세요.' }];
  }
  assert(validateAppDefinition(definition).ok);
  const { rows: [agent] } = await client.query("INSERT INTO agents(department_id,name,tier,capabilities,app_definition) VALUES($1,$2,'official','{}',$3) RETURNING id,version", [dept.id, `form-check-${randomUUID()}`, definition]);
  const history = async version => (await client.query('SELECT snapshot FROM agent_history WHERE agent_id=$1 AND version=$2', [agent.id, version])).rows[0].snapshot;
  assert.deepEqual((await history(agent.version)).app_definition, definition);
  const changed = { ...definition, output: 'checklist' };
  const save = async (version, patch) => (await client.query("SELECT save_agent($1,$2,$3,NULL,'settings') AS value", [agent.id, version, patch])).rows[0].value;
  const updated = await save(agent.version, { app_definition: changed });
  assert(updated.ok); assert.deepEqual((await history(updated.version)).app_definition, changed);
  assert.equal((await save(agent.version, { app_definition: definition })).reason, 'conflict');
  const restored = await save(updated.version, { app_definition: definition });
  assert.deepEqual((await history(restored.version)).app_definition, definition);
  const cleared = await save(restored.version, { app_definition: null });
  assert.equal((await history(cleared.version)).app_definition, null);
  console.log('PASS created snapshot; versioned changes; conflict rejection; restore; clear');
  if (process.argv.includes('--live')) {
    const { complete } = await import('../src/lib/llm/index.ts');
    const input = renderAppInput(definition, { source: '가상 행사 참석자는 30명이며 장소는 새빛회의실입니다.' });
    assert(input.ok);
    const result = await complete({ model: 'claude-sonnet-4-6', system: `제공된 원문을 간결하게 정리하세요. 숫자는 그대로 보존하세요.\n${appOutputInstruction(definition)}`, maxTokens: 200, messages: [{ role: 'user', content: input.message }] });
    assert(result.text.includes('30')); assert(result.text.includes('새빛'));
    console.log(`PASS actual model form input → formatted result (${result.text.length} chars)`);
  }
} finally { await client.query('ROLLBACK'); await client.end(); console.log('ROLLBACK: no test agents or histories persisted'); }
