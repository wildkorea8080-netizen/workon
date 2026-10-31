/** Existing agents: read-only settings audit; --live checks each published active
 * chat agent's configured prompt/model with a synthetic request. This is not an
 * authenticated /api/chat or browser E2E test. No conversations/usage rows written.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
}
const { createClient } = await import('@supabase/supabase-js');
const { complete } = await import('../src/lib/llm/index.ts');
const { enabledModels, DEFAULT_MODEL_ID } = await import('../src/lib/models.ts');
const { normalizeCapabilities } = await import('../src/lib/capabilities/settings.ts');
const { connectorCatalog } = await import('../src/lib/connectors/index.ts');
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const results = await Promise.all([
  db.from('agents').select('id,name,agent_type,is_active,is_published,deleted_at,organization_id,model_id,system_prompt,capabilities,link_url').order('name'),
  db.from('organizations').select('id,allowed_models'),
  db.from('documents').select('agent_id,noda_status'),
]);
if (results.some(r => r.error)) throw new Error('Audit metadata query failed');
const [agents, organizations, documents] = results.map(r => r.data);
const enabled = new Set(enabledModels().map(m => m.id));
const rows = agents.filter(a => !a.deleted_at).map(a => {
  const org = organizations.find(o => o.id === a.organization_id);
  const allowed = (org?.allowed_models ?? []).filter(id => enabled.has(id));
  if (!allowed.length) allowed.push(DEFAULT_MODEL_ID);
  const model = allowed.includes(a.model_id) ? a.model_id : allowed[0];
  const caps = normalizeCapabilities(a.capabilities, { knownConnectorIds: connectorCatalog().map(c => c.id) });
  const docs = documents.filter(d => d.agent_id === a.id);
  return { name: a.name, published: a.is_published, active: a.is_active, kind: a.agent_type === 'link' ? 'link' : 'chat', model,
    settingsValid: caps.ok, capabilities: caps.ok ? Object.keys(caps.value) : [], documents: docs.length,
    documentStates: docs.reduce((acc,d) => { const k=d.noda_status ?? 'unset'; acc[k]=(acc[k]??0)+1; return acc; }, {}),
    live: 'not_run', _agent: a };
});
const live = process.argv.includes('--live');
let cursor = 0;
async function worker() {
  while (cursor < rows.length) {
    const row = rows[cursor++];
    if (!row.published || !row.active) { row.live = 'not_available'; continue; }
    if (row.kind === 'link') {
      try {
        const url = new URL(row._agent.link_url);
        if (!['https:', 'http:'].includes(url.protocol)) throw Error('Invalid URL');
        if (live) { const response = await fetch(url, { signal: AbortSignal.timeout(15000) }); row.httpStatus = response.status; row.live = response.ok ? 'link_reachable' : 'link_http_error'; }
      } catch { row.live = 'link_failed'; }
    } else if (live && row.settingsValid) {
      try {
        const response = await complete({ model: row.model, system: row._agent.system_prompt || undefined, maxTokens: 180,
          messages: [{ role: 'user', content: '기능 연결 점검용 가상 요청입니다. 실제 문서나 도구 조회 없이, 당신이 도울 수 있는 업무 한 가지와 제가 준비할 입력자료 한 가지를 한국어 두 문장으로 안내해 주세요.' }] });
        row.live = response.text.trim().length > 0 ? 'model_response_ok' : 'empty_response';
        row.responseChars = response.text.trim().length;
        row.tokens = { input: response.usage.input_tokens, output: response.usage.output_tokens };
      } catch { row.live = 'model_request_failed'; }
    }
    console.log(JSON.stringify({name:row.name,kind:row.kind,settings:row.settingsValid,live:row.live}));
  }
}
await Promise.all([worker(), worker()]);
const report = { checkedAt: new Date().toISOString(), scope: 'Local adapter using connected DB settings; not authenticated production E2E', live,
  agents: rows.map(({ _agent, ...safe }) => safe) };
mkdirSync('docs/benchmarks/allganize/evidence', { recursive: true });
writeFileSync('docs/benchmarks/allganize/evidence/legacy-app-audit.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({total:rows.length,liveResults:rows.reduce((acc,r)=>{acc[r.live]=(acc[r.live]??0)+1;return acc;},{})}));
if (rows.some(r => !r.settingsValid || ['model_request_failed','empty_response','link_failed','link_http_error'].includes(r.live))) process.exitCode = 1;
