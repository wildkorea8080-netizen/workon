import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { APP_LOOKUP_TOOLS, APP_WEB_LOOKUP_MAX_USES, appLookupConnectors, appUsesWebSearchLookup, researchToolAllowed, validateAppDefinition, type AppField, type AppStep } from '@/lib/apps/definition';
import { appLookupRunner, runAppIntermediateSteps, stageMessages, type AppStepRecord } from '@/lib/apps/pipeline';
import { APP_WEB_LOOKUP_GAP, APP_WEB_LOOKUP_NO_CAPABILITY, APP_WEB_LOOKUP_OFF, APP_WEB_LOOKUP_SYSTEM, appWebSearchRunner } from '@/lib/apps/app-web-lookup';
import { splitAgentBody } from '@/lib/agent-patch';
import { describeAppCalls, estimateAppCalls } from '@/lib/apps/call-estimate';
import { estimateRunCostKrw } from '@/lib/usage-reservation';
import { LlmApiError } from '@/lib/llm/errors';
import type { LlmRequest, LlmStreamEvent, LlmUsage } from '@/lib/llm/types';
import { AppInputError } from '@/lib/apps/long-input';

/** 입력형 앱의 웹 검색 조회(2026-11-26) — 조회 단계·AI 조사 단계가 기관이 켠 웹 검색으로 찾아 간추린 사실을 출처와 함께 다음 단계로 */

const fields: AppField[] = [{ key: 'topic', label: '주제', type: 'text', required: true }];
const webStep: AppStep = { name: '웹에서 찾기', instruction: '', lookup: { tool: 'web_search', query: '{{topic}} 최신 지침' } };
const finalStep: AppStep = { name: '작성', instruction: '찾은 자료로 정리하세요.' };
const def = (steps: unknown[]) => validateAppDefinition({ schemaVersion: 1, fields, output: 'bullets', steps });

const on = { preflight: { web_search: true }, capabilities: { web_search: { allowed_domains: ['go.kr'] } } };

function fakeStream(rounds: LlmStreamEvent[][]) {
  const calls: LlmRequest[] = [];
  const stream = (req: LlmRequest) => {
    calls.push(JSON.parse(JSON.stringify(req)));
    const events = rounds[calls.length - 1] ?? [];
    return (async function* () { for (const e of events) yield e; })();
  };
  return { stream: stream as unknown as typeof import('@/lib/llm').streamChat, calls };
}
const done = (usage: Partial<LlmUsage>, stopReason: string | null = 'end_turn', content?: Record<string, unknown>[]): LlmStreamEvent =>
  ({ type: 'done', usage: { model: 'claude-sonnet-4-6', input_tokens: 0, output_tokens: 0, ...usage }, stopReason, ...(content ? { content } : {}) });

describe('정의·저장 검사', () => {
  it('웹 검색은 커넥터가 아닌 능력 조회 — 조회 단계·조사 단계에 둘 수 있다', () => {
    expect(APP_LOOKUP_TOOLS.web_search).toMatchObject({ connector: null, capability: 'web_search', appOnly: true });
    expect(researchToolAllowed('web_search')).toBe(true);
    const plain = def([webStep, finalStep]);
    expect(plain.ok).toBe(true);
    expect(def([{ ...webStep, lookup: { ...webStep.lookup!, refine: 1 } }, finalStep]).ok).toBe(true);
    expect(def([{ name: '조사', instruction: '제도 변화를 조사', research: { tools: ['web_search', 'law_search'], rounds: 2 } }, finalStep]).ok).toBe(true);
    // 조문 번호·태그·다른 비서는 웹 검색에 없다
    expect(def([{ ...webStep, lookup: { ...webStep.lookup!, article: '{{topic}}' } }, finalStep]).ok).toBe(false);
    expect(def([{ ...webStep, lookup: { ...webStep.lookup!, tags: ['예산'] } }, finalStep]).ok).toBe(false);
  });
  it('쓰면 앱 능력의 웹 검색이 있어야 저장된다 — 공공 데이터 커넥터는 요구하지 않는다', () => {
    const parsed = def([webStep, finalStep]);
    if (!parsed.ok) throw new Error('정의');
    expect(appUsesWebSearchLookup(parsed.value)).toBe(true);
    expect(appLookupConnectors(parsed.value)).toEqual([]);
    const research = def([{ name: '조사', instruction: '조사', research: { tools: ['web_search'], rounds: 1 } }, finalStep]);
    if (!research.ok) throw new Error('정의');
    expect(appUsesWebSearchLookup(research.value)).toBe(true);
    const opts = { currentType: 'chat' as const, knownConnectorIds: ['law', 'kosis', 'g2b', 'dart'], knownModelIds: [] };
    const app_definition = { schemaVersion: 1, fields, output: 'bullets', steps: [webStep, finalStep] };
    expect(splitAgentBody({ app_definition, capabilities: {} }, opts).error).toContain('웹 검색');
    expect(splitAgentBody({ app_definition, capabilities: { web_search: {} } }, opts).error).toBeUndefined();
  });
  it('빌더가 웹 검색 능력을 켜되 이미 정한 찾을 곳은 그대로 둔다', () => {
    const src = readFileSync('src/app/apps/builder/page.tsx', 'utf8');
    expect(src).toMatch(/appUsesWebSearchLookup\(checked\.value\) && !capabilities\.web_search\) capabilities\.web_search = \{\}/);
  });
});

describe('웹 검색 조회 실행기', () => {
  it('기관 스위치·앱 능력이 아니면 부르지 않고 실패로 알린다', async () => {
    const { stream, calls } = fakeStream([]);
    const usage = { model: 'claude-sonnet-4-6', input_tokens: 0, output_tokens: 0 };
    const off = await appWebSearchRunner({ ctx: { preflight: {}, capabilities: on.capabilities }, model: 'claude-sonnet-4-6', usage, stream })('q');
    expect(off).toMatchObject({ isError: true, content: APP_WEB_LOOKUP_OFF });
    const noCap = await appWebSearchRunner({ ctx: { preflight: { web_search: true }, capabilities: {} }, model: 'claude-sonnet-4-6', usage, stream })('q');
    expect(noCap).toMatchObject({ isError: true, content: APP_WEB_LOOKUP_NO_CAPABILITY });
    expect(calls).toHaveLength(0);
  });
  it('조회어만 보내고(앱 지시문과 따로) 찾을 곳·검색 횟수를 싣고, 간추린 글과 인용한 곳을 출처로, 토큰·검색 횟수를 실행 사용량에 더한다', async () => {
    const { stream, calls } = fakeStream([[
      { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: '여비 지침' } },
      { type: 'server_tool_result', toolUseId: 's1', name: 'web_search', ok: true, sources: [{ title: '인사혁신처', url: 'https://www.mpm.go.kr/a' }, { title: '나쁜', url: 'javascript:x' }] },
      { type: 'text', text: '- 2026년 여비 지침 개정(인사혁신처, 2026-03)' },
      { type: 'citation', source: { title: '인사혁신처 공지', url: 'https://www.mpm.go.kr/b', citedText: '2026년 3월 개정' } },
      done({ input_tokens: 900, output_tokens: 120, web_search_requests: 2 }),
    ]]);
    const usage: LlmUsage = { model: 'claude-sonnet-4-6', input_tokens: 10, output_tokens: 5 };
    const guard = vi.fn(async () => {});
    const result = await appWebSearchRunner({ ctx: on, model: 'claude-sonnet-4-6', usage, guard, stream })('여비 최신 지침');
    expect(guard).toHaveBeenCalledTimes(1);
    expect(calls[0].system).toBe(APP_WEB_LOOKUP_SYSTEM);
    expect(calls[0].messages).toEqual([{ role: 'user', content: '조회어: 여비 최신 지침' }]);
    expect(calls[0].serverTools).toEqual({ webSearch: { maxUses: APP_WEB_LOOKUP_MAX_USES, allowedDomains: ['go.kr'] } });
    expect(calls[0].tools).toBeUndefined();
    expect(result).toEqual({ content: '- 2026년 여비 지침 개정(인사혁신처, 2026-03)', sources: [{ title: '인사혁신처 공지', url: 'https://www.mpm.go.kr/b' }] });
    expect(usage).toEqual({ model: 'claude-sonnet-4-6', input_tokens: 910, output_tokens: 125, web_search_requests: 2 });
  });
  it('인용이 없으면 찾은 곳(웹 주소만)을 출처로, pause_turn은 받은 블록 그대로 이어 부른다', async () => {
    const raw = [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } }];
    const { stream, calls } = fakeStream([
      [{ type: 'server_tool_result', toolUseId: 's1', name: 'web_search', ok: true, sources: [{ title: '가', url: 'https://a.go.kr' }, { title: '나', url: 'ftp://b' }] }, done({ input_tokens: 100, web_search_requests: 1 }, 'pause_turn', raw)],
      [{ type: 'text', text: '정리한 사실' }, done({ input_tokens: 50, output_tokens: 20 })],
    ]);
    const usage: LlmUsage = { model: 'claude-sonnet-4-6', input_tokens: 0, output_tokens: 0 };
    const result = await appWebSearchRunner({ ctx: on, model: 'claude-sonnet-4-6', usage, stream })('x');
    expect(calls).toHaveLength(2);
    expect(calls[1].messages[1]).toEqual({ role: 'assistant', content: [{ type: 'provider_raw', block: raw[0] }] });
    expect(result).toEqual({ content: '정리한 사실', sources: [{ title: '가', url: 'https://a.go.kr' }] });
    expect(usage.web_search_requests).toBe(1);
  });
  it("못 찾으면(찾은 곳 없음·'찾지 못했습니다') 멈추지 않고 정보 공백, 검색 자체가 실패하면 실패", async () => {
    const notFound = fakeStream([[{ type: 'server_tool_result', toolUseId: 's', name: 'web_search', ok: true, sources: [{ title: 'a', url: 'https://a' }] }, { type: 'text', text: '찾지 못했습니다. 2026년 개정 소식은 없습니다.' }, done({})]]);
    const gap = await appWebSearchRunner({ ctx: on, model: 'claude-sonnet-4-6', usage: { model: 'm', input_tokens: 0, output_tokens: 0 }, stream: notFound.stream })('x');
    expect(gap.gap).toBe(true); expect(gap.isError).toBeUndefined(); expect(gap.content.startsWith(APP_WEB_LOOKUP_GAP)).toBe(true); expect(gap.sources).toEqual([]);
    const empty = fakeStream([[done({})]]);
    expect(await appWebSearchRunner({ ctx: on, model: 'claude-sonnet-4-6', usage: { model: 'm', input_tokens: 0, output_tokens: 0 }, stream: empty.stream })('x')).toEqual({ content: APP_WEB_LOOKUP_GAP, sources: [], gap: true });
    const failed = fakeStream([[{ type: 'server_tool_result', toolUseId: 's', name: 'web_search', ok: false, sources: [], errorCode: 'too_many_requests' }, { type: 'text', text: '검색하지 못했습니다' }, done({})]]);
    const err = await appWebSearchRunner({ ctx: on, model: 'claude-sonnet-4-6', usage: { model: 'm', input_tokens: 0, output_tokens: 0 }, stream: failed.stream })('x');
    expect(err).toMatchObject({ isError: true }); expect(err.content).toContain('too_many_requests');
  });
  it('모델 호출이 던지면 원문 없이 안내로 실패(쓴 토큰은 이미 더함)', async () => {
    const stream = (() => (async function* () { throw new LlmApiError(429, 'rate_limit_error: secret detail'); })()) as unknown as typeof import('@/lib/llm').streamChat;
    const result = await appWebSearchRunner({ ctx: on, model: 'claude-sonnet-4-6', usage: { model: 'm', input_tokens: 0, output_tokens: 0 }, stream })('x');
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain('secret');
  });
  it('조회 도구 부르기는 웹 검색을 그 실행기로 보낸다(없으면 실패)', async () => {
    const run = vi.fn();
    const web = vi.fn(async () => ({ content: 'ok', sources: [] }));
    const ctx = { capabilities: {} };
    expect(await appLookupRunner(ctx, run, undefined, undefined, web)('web_search', '조회어')).toEqual({ content: 'ok', sources: [] });
    expect(web).toHaveBeenCalledWith('조회어');
    expect((await appLookupRunner(ctx, run)('web_search', '조회어')).isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
});

function setup(steps: AppStep[]) {
  const records: AppStepRecord[] = steps.map(s => ({ name: s.name, status: 'pending' }));
  return {
    steps, records, model: 'model', system: '역할', messages: [{ role: 'user' as const, content: '원문' }],
    usage: { model: 'model', input_tokens: 0, output_tokens: 0 }, guard: vi.fn(async () => {}), update: vi.fn(),
    complete: vi.fn(async () => ({ text: '작업 결과', usage: { model: 'model', input_tokens: 10, output_tokens: 5 } })),
  };
}

describe('단계 실행', () => {
  it('웹에서 찾은 자료는 출처와 함께 외부 자료로, 못 찾은 조회는 정보 공백(found:false)으로 넘긴다', async () => {
    const args = setup([webStep, finalStep]);
    const lookup = vi.fn(async () => ({ content: '- 지침 개정', sources: [{ title: '인사혁신처', url: 'https://www.mpm.go.kr/b' }] }));
    const result = await runAppIntermediateSteps({ ...args, inputs: { topic: '여비' }, lookup });
    expect(lookup).toHaveBeenCalledWith('web_search', '여비 최신 지침', undefined);
    expect(args.records[0]).toMatchObject({ kind: 'lookup', status: 'completed', output: '- 지침 개정', sources: [{ title: '인사혁신처', url: 'https://www.mpm.go.kr/b' }] });
    expect(args.records[0].gap).toBeUndefined();
    expect(JSON.stringify(result.messages)).toContain('웹 검색 단계는 AI가 웹에서 찾아 간추린 자료');

    const gapArgs = setup([webStep, finalStep]);
    const gapped = await runAppIntermediateSteps({ ...gapArgs, inputs: { topic: '여비' }, lookup: async () => ({ content: APP_WEB_LOOKUP_GAP, sources: [], gap: true }) });
    expect(gapArgs.records[0]).toMatchObject({ status: 'completed', gap: true });
    expect(String(gapped.messages.at(-1)!.content)).toContain('"found":false');
  });
  it('웹 검색이 꺼져 실패면 조회 단계는 그 자리에서 멈춘다(직원이 고칠 수 있는 안내)', async () => {
    const args = setup([webStep, finalStep]);
    await expect(runAppIntermediateSteps({ ...args, inputs: { topic: '여비' }, lookup: async () => ({ content: APP_WEB_LOOKUP_OFF, sources: [], isError: true }) })).rejects.toBeInstanceOf(AppInputError);
  });
  it('공공 데이터 조회 자료에는 found 칸을 싣지 않는다(실패면 멈추므로)', () => {
    const messages = stageMessages([{ role: 'user', content: 'x' }], [{ name: '법령', status: 'completed', kind: 'lookup', query: 'q', output: 'o', sources: [] }]);
    expect(String(messages.at(-1)!.content)).not.toContain('"found"');
  });
});

describe('예상 호출·사용량 예약', () => {
  it('웹 검색 조회는 AI 호출로 센다(공공 데이터 조회로 세지 않음)', () => {
    const parsed = def([webStep, finalStep]);
    if (!parsed.ok) throw new Error('정의');
    const e = estimateAppCalls(parsed.value!, { topic: '여비' }, 0);
    expect(e).toEqual({ min: 2, max: 2, lookups: 0, webSearches: 1, mayDigest: false });
    expect(describeAppCalls(e)).toContain('웹 검색 조회는 많으면 1번');
    const research = def([{ name: '조사', instruction: '조사', research: { tools: ['web_search'], rounds: 2 } }, finalStep]);
    if (!research.ok) throw new Error('정의');
    expect(estimateAppCalls(research.value!, {}, 0).webSearches).toBe(10);
  });
  it('예약 금액에 검색 요금이 들어간다', () => {
    const base = { modelId: 'claude-sonnet-4-6', calls: 3, baseChars: 2000 };
    expect(estimateRunCostKrw({ ...base, webSearches: 5 })).toBeGreaterThan(estimateRunCostKrw(base));
  });
});

describe('잇기', () => {
  it('대화 실행기가 이 턴의 기관 스위치·모델·사용량·guard로 웹 검색 조회를 잇는다', () => {
    const src = readFileSync('src/lib/assistant/stream.ts', 'utf8');
    expect(src).toContain('appWebSearchRunner({ ctx: turn.ctx, model: turn.modelId, usage: progress.usage, guard })');
  });
  it('앱 실행에는 대화용 웹 검색 지시문을 싣지 않는다', () => {
    const src = readFileSync('src/lib/assistant/prepare.ts', 'utf8');
    expect(src).toContain("definition.value && capabilities[i]?.id === 'web_search' ? undefined : p.systemAddendum");
  });
});
