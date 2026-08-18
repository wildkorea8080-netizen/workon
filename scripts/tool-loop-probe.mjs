/**
 * 툴 실행 루프 검증 스크립트.
 *
 *   npm run tool:probe
 *
 * /api/chat 라우트 전체가 아니라 그 안의 루프 로직(streamClaudeAPI +
 * executeTool 왕복)만 떼어 확인합니다. DB·인증 없이 돌릴 수 있습니다.
 * ANTHROPIC_API_KEY가 필요합니다.
 */
import { existsSync, readFileSync } from 'fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.trimStart().startsWith('#')) {
      const key = line.slice(0, eq).trim();
      if (!process.env[key]) process.env[key] = line.slice(eq + 1).trim();
    }
  }
}
for (const key of [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'NEXTAUTH_URL',
  'NEXTAUTH_SECRET',
  'VOYAGE_API_KEY',
]) {
  if (!process.env[key]) process.env[key] = 'probe-placeholder';
}

const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
if (!hasApiKey) process.env.ANTHROPIC_API_KEY = 'offline-parser-test';

const { streamClaudeAPI } = await import('../src/lib/claude.ts');
const { availableTools, executeTool } = await import('../src/lib/connectors/index.ts');

/**
 * API 키 없이 스트림 파서만 검증한다.
 *
 * tool_use 블록의 input은 input_json_delta로 잘게 쪼개져 오므로, 조각을 모아
 * 다시 JSON으로 파싱하는 부분이 가장 깨지기 쉽다. 실제 Anthropic 이벤트
 * 시퀀스를 그대로 재현해 fetch를 가로채 확인한다.
 */
async function runParserSelfTest() {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 120 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '법령을 ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '찾아볼게요.' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_01', name: 'law_search' },
    },
    // JSON이 조각으로 쪼개져 오는 상황을 그대로 재현
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"que' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ry":"개인정보' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ' 보호법","limit":3}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 45 } },
  ];

  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(new TextEncoder().encode(body), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });

  try {
    let text = '';
    const toolCalls = [];
    let done = null;

    for await (const event of streamClaudeAPI([{ role: 'user', content: 'x' }], undefined, 100, tools)) {
      if (event.type === 'text') text += event.text;
      else if (event.type === 'tool_use') toolCalls.push(event);
      else done = event;
    }

    const textOk = text === '법령을 찾아볼게요.';
    const callOk =
      toolCalls.length === 1 &&
      toolCalls[0].name === 'law_search' &&
      toolCalls[0].id === 'toolu_01' &&
      toolCalls[0].input.query === '개인정보 보호법' &&
      toolCalls[0].input.limit === 3;
    const stopOk = done?.stopReason === 'tool_use';
    const usageOk = done?.usage.input_tokens === 120 && done?.usage.output_tokens === 45;

    console.log('\n────────── 스트림 파서 자체 검증 (API 키 불필요) ──────────');
    console.log(`텍스트 델타 조립      : ${textOk ? 'PASS' : 'FAIL'} (${JSON.stringify(text)})`);
    console.log(`tool_use 조각 JSON 조립: ${callOk ? 'PASS' : 'FAIL'} (${JSON.stringify(toolCalls[0]?.input)})`);
    console.log(`stop_reason 전달       : ${stopOk ? 'PASS' : 'FAIL'} (${done?.stopReason})`);
    console.log(`토큰 사용량 집계       : ${usageOk ? 'PASS' : 'FAIL'} (in ${done?.usage.input_tokens} / out ${done?.usage.output_tokens})`);

    return textOk && callOk && stopOk && usageOk;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const MAX_ROUNDS = 4;

const tools = availableTools().map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.inputSchema,
}));

const question =
  process.argv[2] ??
  '개인정보 보호법 제15조에서 개인정보를 수집할 수 있는 경우를 근거와 함께 알려줘.';

const messages = [{ role: 'user', content: question }];
const systemPrompt =
  '당신은 공공기관 직원을 돕는 AI 비서입니다. 법령 질문에는 반드시 제공된 도구로 원문을 확인한 뒤 답하세요.';

console.log('노출 도구:', tools.map((t) => t.name).join(', '));

const parserOk = await runParserSelfTest();

if (!hasApiKey) {
  console.log('\nANTHROPIC_API_KEY가 없어 실제 모델 호출 검증은 건너뜁니다.');
  console.log('전체 루프를 확인하려면 .env.local에 ANTHROPIC_API_KEY를 넣고 다시 실행하세요.');
  process.exit(parserOk ? 0 : 1);
}

console.log('\n────────── 실제 모델 호출 ──────────');
console.log('질문:', question);

let answer = '';
let toolCallCount = 0;
const usedTools = [];
const sources = [];

for (let round = 0; round < MAX_ROUNDS; round++) {
  const assistantBlocks = [];
  const pendingCalls = [];
  let roundText = '';
  let stopReason = null;

  for await (const event of streamClaudeAPI(messages, systemPrompt, 4096, tools)) {
    if (event.type === 'text') {
      roundText += event.text;
      answer += event.text;
      process.stdout.write(event.text);
    } else if (event.type === 'tool_use') {
      pendingCalls.push(event);
    } else {
      stopReason = event.stopReason;
    }
  }

  if (stopReason !== 'tool_use' || pendingCalls.length === 0) break;

  if (roundText) assistantBlocks.push({ type: 'text', text: roundText });
  for (const call of pendingCalls) {
    assistantBlocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
  }
  messages.push({ role: 'assistant', content: assistantBlocks });

  const resultBlocks = [];
  for (const call of pendingCalls) {
    toolCallCount++;
    usedTools.push(call.name);
    console.log(`\n[도구 호출 ${toolCallCount}] ${call.name} ${JSON.stringify(call.input)}`);
    const result = await executeTool(call.name, call.input);
    sources.push(...result.sources);
    console.log(
      `[도구 결과] ${result.isError ? '오류' : '성공'} / ${result.content.length}자 / 출처 ${result.sources.length}건`
    );
    resultBlocks.push({
      type: 'tool_result',
      tool_use_id: call.id,
      content: result.content,
      is_error: result.isError,
    });
  }
  messages.push({ role: 'user', content: resultBlocks });
}

console.log('\n\n────────── 검증 ──────────');
const calledTool = toolCallCount > 0;
const gotSources = sources.length > 0;
const gotAnswer = answer.trim().length > 50;

console.log(`도구 호출 발생        : ${calledTool ? 'PASS' : 'FAIL'} (${toolCallCount}회: ${usedTools.join(', ')})`);
console.log(`출처 수집             : ${gotSources ? 'PASS' : 'FAIL'} (${sources.length}건)`);
console.log(`최종 답변 생성        : ${gotAnswer ? 'PASS' : 'FAIL'} (${answer.trim().length}자)`);
if (sources.length) {
  console.log('출처:');
  for (const s of sources.slice(0, 5)) console.log(`  - ${s.title}: ${s.url}`);
}

if (!parserOk || !calledTool || !gotSources || !gotAnswer) process.exit(1);
