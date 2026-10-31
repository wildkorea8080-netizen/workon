/** Real model checkpoint reuse with synthetic inputs and an injected transient failure. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const env = readFileSync('.env.local', 'utf8').split(/\r?\n/).find(line => line.startsWith('ANTHROPIC_API_KEY='));
if (!process.env.ANTHROPIC_API_KEY && env) process.env.ANTHROPIC_API_KEY = env.slice(env.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
assert(process.env.ANTHROPIC_API_KEY);
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXTAUTH_URL', 'NEXTAUTH_SECRET']) process.env[key] = key.includes('URL') ? 'http://127.0.0.1:9' : 'resume-smoke-disabled';
const { complete } = await import('../src/lib/llm/index.ts');
const { runToolLoop } = await import('../src/lib/assistant/stream.ts');
const { runAppIntermediateSteps } = await import('../src/lib/apps/pipeline.ts');
const { restoreAppSteps } = await import('../src/lib/apps/resume.ts');
const { renderAppInput, appOutputInstruction } = await import('../src/lib/apps/definition.ts');
const model = 'claude-sonnet-4-6';
const def = { schemaVersion: 1, fields: [{ key: 'source', label: '원문', type: 'textarea', required: true }], output: 'bullets', steps: [{ name: '정리', instruction: '원문 사실을 2문장으로 정리하세요.' }, { name: '초안', instruction: '원문과 정리 결과로 3문장 이내 안내문을 작성하세요.' }, { name: '검토', instruction: '원문과 대조해 사실만 남긴 최종 안내문을 작성하세요.' }] };
const input = renderAppInput(def, { source: '가상 행사 참석자는 30명이며 장소는 새빛회의실입니다. 개최일은 미정입니다.' }); assert(input.ok);
const records = def.steps.map(step => ({ name: step.name, status: 'pending' }));
const firstUsage = { model, input_tokens: 0, output_tokens: 0 }; let firstCalls = 0;
const system = `제공된 사실과 숫자를 보존하고 없는 사실은 만들지 마세요.\n${appOutputInstruction(def)}`;
try {
  await runAppIntermediateSteps({ steps: def.steps, records, inputs: input.inputs, model, system, messages: [{ role: 'user', content: input.message }], usage: firstUsage, guard: async () => {}, update: () => {}, complete: async request => { if (firstCalls === 1) throw new Error('synthetic transient failure'); firstCalls++; return complete(request); } });
  assert.fail('Expected injected failure');
} catch (error) { assert.equal(error.message, 'synthetic transient failure'); }
for (const record of records) { if (record.status === 'running') record.status = 'failed'; else if (record.status === 'pending') record.status = 'not_run'; }
const restored = restoreAppSteps(def, { app_inputs: input.inputs, app_steps: records }, input.message); assert(restored.ok);
let resumeCalls = 0; const progress = { usage: { model, input_tokens: 0, output_tokens: 0 }, capabilityUsage: [] };
const next = await runAppIntermediateSteps({ steps: def.steps, records: restored.records, inputs: input.inputs, model, system, messages: [{ role: 'user', content: input.message }], usage: progress.usage, guard: async () => {}, update: () => {}, complete: async request => { resumeCalls++; return complete(request); } });
assert.equal(resumeCalls, 1); assert.equal(restored.records[0].output, records[0].output); assert(restored.records[0].reused);
const result = await runToolLoop({ modelId: model, systemPrompt: next.system, messages: next.messages, tools: [], owners: new Map(), ctx: {}, maxRounds: 1, progress }, () => {});
assert(result.text.includes('30')); assert(result.text.includes('새빛'));
restored.records[2].status = 'completed'; restored.records[2].output = result.text;
mkdirSync('docs/benchmarks/allganize/evidence', { recursive: true });
writeFileSync('docs/benchmarks/allganize/evidence/app-resume-smoke.json', JSON.stringify({ checkedAt: new Date().toISOString(), scope: 'Synthetic model-only checkpoint, injected failure; no DB or browser E2E', firstCalls, firstUsage, firstRecords: records, newModelCallsOnResume: resumeCalls + 1, resumedUsage: progress.usage, resumedRecords: restored.records }, null, 2));
console.log('PASS actual first stage → injected failure → checkpoint reuse → remaining stages; final facts preserved; resumed model calls 2');
