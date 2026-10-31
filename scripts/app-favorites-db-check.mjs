/** Exercise the deployed SQL function inside a transaction and always roll back. */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query('BEGIN');
  const { rows: [user] } = await client.query('SELECT id, favorite_agent_ids, favorite_workflow_keys FROM users LIMIT 1 FOR UPDATE');
  assert(user, 'A test user is required');
  // Isolate this test's workflow inputs in the transaction. Nothing commits.
  await client.query("UPDATE users SET favorite_workflow_keys = '{}' WHERE id = $1", [user.id]);
  const set = async (kind, key, favorite) => (await client.query('SELECT set_user_app_favorite($1,$2,$3,$4) AS value', [user.id, kind, key, favorite])).rows[0].value;
  const a = await set('workflow', 'document-summary', true);
  assert.deepEqual(a.workflowKeys, ['document-summary']);
  assert.deepEqual(a.agentIds, user.favorite_agent_ids ?? []);
  assert.deepEqual((await set('workflow', 'document-summary', true)).workflowKeys, ['document-summary']);
  assert.deepEqual((await set('workflow', 'document-faq', true)).workflowKeys, ['document-summary', 'document-faq']);
  assert.deepEqual((await set('workflow', 'document-summary', false)).workflowKeys, ['document-faq']);
  const agentId = randomUUID();
  const agent = await set('agent', agentId, true);
  assert(agent.agentIds.includes(agentId));
  assert.deepEqual(agent.workflowKeys, ['document-faq']);
  assert.deepEqual((await set('agent', agentId, false)).agentIds, user.favorite_agent_ids ?? []);
  const { rows: [access] } = await client.query("SELECT has_function_privilege('anon','public.set_user_app_favorite(uuid,text,text,boolean)','EXECUTE') AS anon, has_function_privilege('authenticated','public.set_user_app_favorite(uuid,text,text,boolean)','EXECUTE') AS authenticated, has_function_privilege('service_role','public.set_user_app_favorite(uuid,text,text,boolean)','EXECUTE') AS service");
  assert.deepEqual(access, { anon: false, authenticated: false, service: true });
  console.log('PASS workflow add/remove/idempotency; agent preservation; shared favorites; service-only RPC');
} finally {
  await client.query('ROLLBACK');
  await client.query("NOTIFY pgrst, 'reload schema'");
  await client.end();
  console.log('ROLLBACK: no test preferences persisted');
}
