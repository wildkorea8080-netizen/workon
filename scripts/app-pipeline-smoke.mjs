/** Actual model smoke using only synthetic inputs. No DB writes or existing prompts. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const env = readFileSync('.env.local', 'utf8').split(/\r?\n/).find(line => line.startsWith('ANTHROPIC_API_KEY='));
if (!process.env.ANTHROPIC_API_KEY && env) process.env.ANTHROPIC_API_KEY = env.slice(env.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
assert(process.env.ANTHROPIC_API_KEY, 'Model key is required');
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXTAUTH_URL', 'NEXTAUTH_SECRET']) process.env[key] = key.includes('URL') ? 'http://127.0.0.1:9' : 'pipeline-smoke-disabled';
const { complete } = await import('../src/lib/llm/index.ts');
const { runToolLoop } = await import('../src/lib/assistant/stream.ts');
const { runAppIntermediateSteps } = await import('../src/lib/apps/pipeline.ts');
const { renderAppInput, appOutputInstruction } = await import('../src/lib/apps/definition.ts');
const model = 'claude-sonnet-4-6';
const definition = { schemaVersion: 1, fields: [{ key: 'source', label: '원문', type: 'textarea', required: true }], output: 'bullets', steps: [
  { name: '사실 정리', instruction: '원문 사실을 2개 항목으로 짧게 정리하세요. 숫자를 보존하세요.' },
  { name: '안내문 작성', instruction: '원문과 정리 결과를 바탕으로 3문장 이내의 행사 안내 초안을 작성하세요.' },
  { name: '대조·완성', instruction: '원문에 없는 사실을 제거하고 참석 인원과 장소를 보존해 최종 안내문만 작성하세요.' },
] };

const conditional = process.argv.includes('--conditional');
if (conditional) {
  definition.fields.push({ key: 'review', label: '상세 정리 여부', type: 'select', required: true, options: ['예', '아니오'] });
  definition.steps[0].when = { field: 'review', equals: '예' };
}
const cases = [];
for (const choice of conditional ? ['예', '아니오'] : ['']) {
  const input = renderAppInput(definition, { source: '가상 행사 참석자는 30명이며 장소는 새빛회의실입니다. 개최일은 미정입니다.', ...(conditional ? { review: choice } : {}) });
  assert(input.ok);
  const records = definition.steps.map(step => ({ name: step.name, status: 'pending' }));
  const progress = { usage: { model, input_tokens: 0, output_tokens: 0 }, capabilityUsage: [] };
  let intermediateCalls = 0;
  const staged = await runAppIntermediateSteps({ steps: definition.steps, records, inputs: input.inputs, model, system: `원문 사실만 사용해 간결한 안내문을 작성하세요.\n${appOutputInstruction(definition)}`, messages: [{ role: 'user', content: input.message }], usage: progress.usage, complete: async request => { intermediateCalls++; return complete(request); }, guard: async () => {}, update: index => console.log(`STEP ${index + 1}: ${records[index].status}`) });
  const result = await runToolLoop({ modelId: model, systemPrompt: staged.system, messages: staged.messages, tools: [], owners: new Map(), ctx: {}, maxRounds: 1, progress }, () => {});
  assert(result.text.includes('30')); assert(result.text.includes('새빛'));
  assert.equal(intermediateCalls, conditional && choice === '아니오' ? 1 : 2);
  records[2].status = 'completed'; records[2].output = result.text;
  cases.push({ choice: choice || null, intermediateCalls, records, usage: progress.usage });
  console.log(`PASS ${choice || 'unconditional'}: ${intermediateCalls + 1} model calls, final facts preserved`);
}
mkdirSync('docs/benchmarks/allganize/evidence', { recursive: true });
const file = conditional ? 'app-conditional-smoke.json' : 'app-pipeline-smoke.json';
writeFileSync(`docs/benchmarks/allganize/evidence/${file}`, JSON.stringify({ checkedAt: new Date().toISOString(), scope: 'Synthetic input, actual model stages and final stream; no DB or browser E2E', cases }, null, 2));
