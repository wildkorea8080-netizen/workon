import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * 대화 한 턴(streamTurn)의 저장·기록.
 *
 * 이 경로의 실패는 전부 조용하다. 답변은 이미 화면에 흘러간 뒤라, 메시지가
 * 저장되지 않거나 사용 기록이 빠져도 오류가 보이지 않는다 — 새로고침하면
 * 대화가 사라지고, 쓴 만큼 청구되지 않는다. 그래서 가짜 DB에 실제로 들어간
 * 행을 본다.
 */

type Write = { table: string; op: 'insert' | 'update'; rows: Record<string, unknown>[] };
const writes: Write[] = [];

vi.mock('@/lib/supabaseAdmin', () => {
  const result = { data: null, error: null };
  const thenable = (value: unknown) => ({
    eq: () => thenable(value),
    select: () => thenable(value),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve),
  });
  return {
    supabaseAdmin: {
      from(table: string) {
        return {
          insert(rows: Record<string, unknown> | Record<string, unknown>[]) {
            writes.push({ table, op: 'insert', rows: Array.isArray(rows) ? rows : [rows] });
            return thenable(result);
          },
          update(row: Record<string, unknown>) {
            writes.push({ table, op: 'update', rows: [row] });
            return thenable(result);
          },
        };
      },
    },
  };
});

import { setLlmAdapterForTests } from '@/lib/llm';
import { LlmApiError, LLM_MESSAGES } from '@/lib/llm/errors';
import type { LlmAdapter, LlmStreamEvent } from '@/lib/llm/types';
import { streamTurn, type VerifyFn } from '@/lib/assistant/stream';
import { NodaError, nodaTenant, VERIFY_TIMEOUT_MS, type NodaVerifyResult } from '@/lib/noda';
import { storedUserContent, buildUserContent } from '@/lib/assistant/prompt';
import type { PreparedTurn, TurnEvent } from '@/lib/assistant/types';

const MODEL = 'claude-haiku-4-5';
const IMAGE_DATA = 'SU1BR0VCWVRFU19TSE9VTERfTk9UX0JFX1NUT1JFRA==';

function turn(overrides: Partial<PreparedTurn> = {}): PreparedTurn {
  return {
    ctx: {
      organizationId: 'o', departmentId: 'd', userId: 'u', agentId: 'a', agentVersion: 7, capabilities: {}, message: '질문', conversationId: 'c1', attachments: [], preflight: {}, skipDocuments: false,
    },
    modelId: MODEL,
    modelSubstituted: false,
    systemPrompt: 'S',
    messages: [{ role: 'user', content: '질문' }],
    tools: [],
    capabilities: [],
    conversationId: 'c1',
    isNewConversation: true,
    chunks: [],
    storedUserContent: '질문',
    documentsSkipped: false,
    docDropped: null,
    verifySources: [],
    ...overrides,
  };
}

/** 스트림은 정해 둔 사건을, 제목 호출은 정해 둔 글을 낸다 */
function adapter(opts: { stream?: () => AsyncGenerator<LlmStreamEvent>; title?: () => Promise<string> } = {}): LlmAdapter {
  return {
    stream:
      opts.stream ??
      async function* () {
        yield { type: 'text', text: '답' };
        yield { type: 'done', stopReason: 'end_turn', usage: { model: 'IGNORED', input_tokens: 10, output_tokens: 5 } };
      },
    async complete(req) {
      const text = opts.title ? await opts.title() : '여비 문의';
      return { text, usage: { model: req.model, input_tokens: 3, output_tokens: 2 } };
    },
  };
}

const inserted = (table: string) =>
  writes.filter((w) => w.table === table && w.op === 'insert').flatMap((w) => w.rows);
const details = (row: Record<string, unknown>) => row.details as Record<string, unknown>;
const keySet = (row: Record<string, unknown>) => Object.keys(row).sort().join(',');

async function run(t: PreparedTurn, send?: (e: TurnEvent) => void, deps?: { verify?: VerifyFn }) {
  const events: TurnEvent[] = [];
  await streamTurn(t, send ?? ((e) => events.push(e)), deps);
  return events;
}

beforeEach(() => {
  writes.length = 0;
});
afterEach(() => {
  setLlmAdapterForTests(null);
  vi.restoreAllMocks();
});

describe('streamTurn — 성공', () => {
  it('만든 파일을 답변 행의 source_references.files에 남긴다', async () => {
    const file = { id: 'f1', file_name: '회의록.hwpx', size_bytes: 10 };
    const tool = { name: 'fill_template', description: '', inputSchema: { type: 'object' as const, properties: {} } };
    const cap = {
      id: 'document', label: '', description: '', isAvailable: () => true,
      tools: () => [tool],
      execute: async () => ({ ok: true, text: 'ok', files: [file] }),
    } as never;
    let round = 0;
    setLlmAdapterForTests(
      adapter({
        stream: async function* () {
          round += 1;
          if (round === 1) {
            yield { type: 'tool_use', id: 't1', name: 'fill_template', input: {} };
            yield { type: 'done', stopReason: 'tool_use', usage: { model: 'IGNORED', input_tokens: 1, output_tokens: 1 } };
          } else {
            yield { type: 'text', text: '만들었습니다' };
            yield { type: 'done', stopReason: 'end_turn', usage: { model: 'IGNORED', input_tokens: 1, output_tokens: 1 } };
          }
        },
      })
    );
    const events = await run(turn({ capabilities: [cap], tools: [tool] }));
    const rows = inserted('messages');
    expect((rows[1].source_references as { files: unknown[] }).files).toEqual([file]);
    expect(keySet(rows[0])).toBe(keySet(rows[1]));
    expect(events.find((e) => e.event === 'tool_end')).toEqual({
      event: 'tool_end', data: { name: 'fill_template', ok: true, sources: [], files: [file] },
    });
  });

  it('메시지 두 행을 같은 키 집합으로, 판 번호와 함께 저장한다', async () => {
    setLlmAdapterForTests(adapter());
    await run(turn());
    const rows = inserted('messages');
    expect(rows).toHaveLength(2);
    expect(keySet(rows[0])).toBe(keySet(rows[1]));
    expect(rows.map((r) => r.agent_version)).toEqual([7, 7]);
    expect(rows.map((r) => r.content)).toEqual(['질문', '답']);
  });

  it('대화 사용량을 이번 턴 모델·원가와 함께 기록한다', async () => {
    setLlmAdapterForTests(adapter());
    await run(turn());
    const chat = inserted('usage_logs').filter((r) => r.action === 'chat_message');
    expect(chat).toHaveLength(1);
    expect(chat[0].department_id).toBe('d');
    expect(details(chat[0])).toMatchObject({ model: MODEL, input_tokens: 10, output_tokens: 5, agent_version: 7 });
    expect(details(chat[0]).cost_krw).toEqual(expect.any(Number));
    expect(details(chat[0])).not.toHaveProperty('aborted');
  });

  it('대화 사용 기록에 문서 찾기에서 뺀 조각 수(doc_dropped)를 남긴다 — 없으면 null', async () => {
    setLlmAdapterForTests(adapter());
    await run(turn({ docDropped: 3 }));
    expect(details(inserted('usage_logs').find((r) => r.action === 'chat_message')!).doc_dropped).toBe(3);
    writes.length = 0;
    await run(turn());
    const d = details(inserted('usage_logs').find((r) => r.action === 'chat_message')!);
    expect(d).toHaveProperty('doc_dropped');
    expect(d.doc_dropped).toBeNull();
  });

  it('문서 없이 답한 턴은 답변 행에 documents_skipped를 남긴다', async () => {
    setLlmAdapterForTests(adapter());
    await run(turn({ documentsSkipped: true }));
    const rows = inserted('messages');
    expect(keySet(rows[0])).toBe(keySet(rows[1]));
    expect((rows[1].source_references as Record<string, unknown>).documents_skipped).toBe(true);
  });

  it('새 대화면 제목 생성도 이번 턴 모델로 기록하고 제목을 바꾼다', async () => {
    // 기본 모델은 기관 허용 목록에 없을 수 있다
    setLlmAdapterForTests(adapter());
    const events = await run(turn());
    const title = inserted('usage_logs').filter((r) => r.action === 'conversation_title');
    expect(title).toHaveLength(1);
    expect(details(title[0])).toMatchObject({ model: MODEL, input_tokens: 3, output_tokens: 2 });
    expect(details(title[0]).cost_krw).toEqual(expect.any(Number));
    expect(writes.find((w) => w.table === 'conversations' && w.op === 'update')?.rows[0]).toEqual({ title: '여비 문의' });
    expect(events.at(-1)).toEqual({
      event: 'done',
      data: { usage: { model: MODEL, input_tokens: 10, output_tokens: 5 }, title: '여비 문의', number_check: null },
    });
  });

  it('이어지는 대화면 제목을 만들지 않는다', async () => {
    setLlmAdapterForTests(adapter());
    const events = await run(turn({ isNewConversation: false }));
    expect(inserted('usage_logs').some((r) => r.action === 'conversation_title')).toBe(false);
    expect(events[0].event).toBe('meta');
    expect(events.at(-1)?.event).toBe('done');
  });

  it('제목 생성이 실패해도 끝까지 가고 이유를 남긴다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setLlmAdapterForTests(adapter({ title: async () => { throw new Error('과부하'); } }));
    const events = await run(turn());
    expect(events.at(-1)).toMatchObject({ event: 'done', data: { title: null } });
    expect(warn).toHaveBeenCalledWith('[assistant] 제목 생성 실패', expect.anything());
  });
});

describe('streamTurn — 사진', () => {
  it('사진 바이트는 메시지 행에 들어가지 않고 첨부 표시만 남는다', async () => {
    // 이력 20개에 실어 되돌려 보내면 매 턴 사진 토큰이 다시 청구되고, 현장 사진·
    // 명단 같은 개인정보를 보관하게 된다.
    setLlmAdapterForTests(adapter());
    const images = [{ media_type: 'image/jpeg', data: IMAGE_DATA }] as never;
    await run(
      turn({
        messages: [{ role: 'user', content: buildUserContent('질문', images) }],
        storedUserContent: storedUserContent('질문', 1),
      })
    );
    const rows = inserted('messages');
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain(IMAGE_DATA);
    expect(rows[0].content).toContain('1장');
  });
});

describe('streamTurn — 첨부 파일', () => {
  it('이번에 보낸 첨부만 사용자 행에 id·이름으로 남긴다', async () => {
    setLlmAdapterForTests(adapter());
    const summary = { kind: 'text' as const, chars: 1, tables: [], warnings: [] };
    const base = turn();
    await run(
      turn({
        ctx: {
          ...base.ctx,
          attachments: [
            { ref: 'a1', id: 'old', fileName: '지난.xlsx', summary, isNew: false },
            { ref: 'a2', id: 'new', fileName: '예산.xlsx', summary, isNew: true },
          ],
        },
        storedUserContent: storedUserContent('질문', 0, ['예산.xlsx']),
      })
    );
    const rows = inserted('messages');
    expect(keySet(rows[0])).toBe(keySet(rows[1]));
    expect(rows[0].source_references).toEqual({ attachments: [{ id: 'new', file_name: '예산.xlsx' }] });
    expect(rows[0].content).toBe('[첨부 파일: 예산.xlsx]\n질문');
  });
});

describe('streamTurn — 숫자 확인', () => {
  const schema = { type: 'object' as const, properties: {} };
  type Outcome = { ok: boolean; text: string; shownValues?: number[] };

  /** 첫 라운드에 도구들을 부르고, 둘째 라운드에 answer를 쓰는 대화 */
  function toolTurn(calls: { tool: string; outcome: Outcome }[], answer: string, extra: Partial<PreparedTurn> = {}) {
    const tools = calls.map((c) => ({ name: c.tool, description: '', inputSchema: schema }));
    const capabilities = calls.map((c, i) => ({
      id: `cap${i}`, label: '', description: '', isAvailable: () => true,
      tools: () => [tools[i]],
      execute: async () => c.outcome,
    })) as never;
    let round = 0;
    setLlmAdapterForTests(
      adapter({
        stream: async function* () {
          round += 1;
          if (round === 1) {
            for (const [i, c] of calls.entries()) yield { type: 'tool_use', id: `t${i}`, name: c.tool, input: {} };
            yield { type: 'done', stopReason: 'tool_use', usage: { model: 'IGNORED', input_tokens: 1, output_tokens: 1 } };
          } else {
            yield { type: 'text', text: answer };
            yield { type: 'done', stopReason: 'end_turn', usage: { model: 'IGNORED', input_tokens: 1, output_tokens: 1 } };
          }
        },
      })
    );
    return turn({ capabilities, tools, ...extra });
  }
  const numberCheck = (events: TurnEvent[]) =>
    (events.find((e) => e.event === 'done') as { data: { number_check: unknown } }).data.number_check;
  const refs = (row: Record<string, unknown>) => row.source_references as Record<string, unknown>;

  it('첨부 도구를 쓴 턴은 대조해 done과 답변 행에 싣는다', async () => {
    const events = await run(toolTurn([{ tool: 'read_attachment', outcome: { ok: true, text: '표', shownValues: [100] } }], '합계 12,345'));
    expect(numberCheck(events)).toEqual({ unverified: ['12,345'] });
    const rows = inserted('messages');
    expect(refs(rows[1]).number_check).toEqual({ unverified: ['12,345'] });
    // source_references는 한 칸이라 두 행 칸 집합은 그대로다
    expect(keySet(rows[0])).toBe(keySet(rows[1]));
    expect(refs(rows[0])).not.toHaveProperty('number_check');
    // 답변 글은 고치지 않는다
    expect(rows[1].content).toBe('합계 12,345');
  });

  it('보여 준 숫자와 맞으면 null이고 행에 칸을 남기지 않는다', async () => {
    const events = await run(toolTurn([{ tool: 'combine_tables', outcome: { ok: true, text: '결과', shownValues: [12345] } }], '합계 12,345'));
    expect(numberCheck(events)).toBeNull();
    expect(refs(inserted('messages')[1])).not.toHaveProperty('number_check');
  });

  it('첨부 도구를 안 쓴 턴은 대조하지 않는다', async () => {
    setLlmAdapterForTests(adapter({
      stream: async function* () {
        yield { type: 'text', text: '합계 12,345' };
        yield { type: 'done', stopReason: 'end_turn', usage: { model: 'IGNORED', input_tokens: 1, output_tokens: 1 } };
      },
    }));
    const events = await run(turn());
    expect(numberCheck(events)).toBeNull();
    expect(refs(inserted('messages')[1])).not.toHaveProperty('number_check');
  });

  it('첨부 도구가 실패만 했으면 대조하지 않는다', async () => {
    const events = await run(toolTurn([{ tool: 'read_attachment', outcome: { ok: false, text: '없는 첨부입니다' } }], '합계 12,345'));
    expect(numberCheck(events)).toBeNull();
  });

  it('첨부 도구가 아닌 도구만 쓴 턴은 대조하지 않는다', async () => {
    const events = await run(toolTurn([{ tool: 'law_search', outcome: { ok: true, text: '법령' } }], '제12,345호'));
    expect(numberCheck(events)).toBeNull();
  });

  it('시스템 프롬프트·질문·shownValues 없는 도구 결과 글의 숫자도 본 숫자로 친다', async () => {
    // 개요의 행 수, 직원이 질문에 적은 금액, 다른 도구가 글로 보여 준 값은 AI가 본 숫자다
    const base = turn();
    const t = toolTurn(
      [
        { tool: 'read_attachment', outcome: { ok: true, text: '표', shownValues: [1] } },
        { tool: 'law_search', outcome: { ok: true, text: '통계 값 33,333' } },
      ],
      '11,111행 중 22,222원, 33,333건, 그리고 44,444',
      { systemPrompt: 'a1/t1 11,111행', ctx: { ...base.ctx, message: '예산 22,222원을' } }
    );
    expect(numberCheck(await run(t))).toEqual({ unverified: ['44,444'] });
  });
});

describe('streamTurn — 문서 근거 턴의 숫자 확인(S4-b, 판정 R1)', () => {
  const chunk = { documentId: 'd1', documentTitle: '예산서', chunkIndex: 0, n: 1, text: '예산 12,345천원', similarity: 0.9 };
  const numberCheck = (events: TurnEvent[]) =>
    (events.find((e) => e.event === 'done') as { data: { number_check: unknown } }).data.number_check;
  const answering = (answer: string) =>
    adapter({
      stream: async function* () {
        yield { type: 'text', text: answer };
        yield { type: 'done', stopReason: 'end_turn', usage: { model: 'IGNORED', input_tokens: 1, output_tokens: 1 } };
      },
    });

  it('문서 근거가 있는 턴이면 첨부 도구가 없어도 숫자를 대조한다', async () => {
    setLlmAdapterForTests(answering('예산은 12,345천원이고 총액 98,765천원'));
    const events = await run(turn({ chunks: [chunk], systemPrompt: 'S\n참고 자료:\n[1] 예산서\n예산 12,345천원' }));
    expect(numberCheck(events)).toEqual({ unverified: ['98,765'] });
    const rows = inserted('messages');
    expect((rows[1].source_references as Record<string, unknown>).number_check).toEqual({ unverified: ['98,765'] });
    expect(keySet(rows[0])).toBe(keySet(rows[1]));
    // 답변 글은 고치지 않는다
    expect(rows[1].content).toBe('예산은 12,345천원이고 총액 98,765천원');
  });

  it('법령 도구가 보여 준 숫자는 근거 묶음에 없어도 확인된다', async () => {
    const tool = { name: 'law_search', description: '', inputSchema: { type: 'object' as const, properties: {} } };
    const cap = {
      id: 'public_data', label: '', description: '', isAvailable: () => true,
      tools: () => [tool],
      execute: async () => ({ ok: true, text: '법령', shownValues: [98765] }),
    } as never;
    let round = 0;
    setLlmAdapterForTests(
      adapter({
        stream: async function* () {
          round += 1;
          if (round === 1) {
            yield { type: 'tool_use', id: 't1', name: 'law_search', input: {} };
            yield { type: 'done', stopReason: 'tool_use', usage: { model: 'IGNORED', input_tokens: 1, output_tokens: 1 } };
          } else {
            yield { type: 'text', text: '예산은 12,345천원이고 총액 98,765천원' };
            yield { type: 'done', stopReason: 'end_turn', usage: { model: 'IGNORED', input_tokens: 1, output_tokens: 1 } };
          }
        },
      })
    );
    const events = await run(turn({ chunks: [chunk], systemPrompt: '예산 12,345천원', capabilities: [cap], tools: [tool] }));
    expect(numberCheck(events)).toBeNull();
    expect(inserted('messages')[1].source_references).not.toHaveProperty('number_check');
  });

  it('문서 근거도 첨부 도구도 없는 턴은 대조하지 않는다', async () => {
    setLlmAdapterForTests(answering('예산은 12,345천원이고 총액 98,765천원'));
    const events = await run(turn({ chunks: [], systemPrompt: 'S' }));
    expect(numberCheck(events)).toBeNull();
    expect(inserted('messages')[1].source_references).not.toHaveProperty('number_check');
  });
});

describe('streamTurn — NODA 답변 검증(S4-b)', () => {
  const AGENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const chunk = { documentId: 'd1', documentTitle: '예산서', chunkIndex: 0, n: 1, text: '예산 50', similarity: 0.9 };
  const sources = [
    { doc_id: 'doc-b', chunk_id: 'ch-9' },
    { doc_id: 'doc-a', chunk_id: 'ch-1' },
  ];
  const VERIFIED: NodaVerifyResult = { grounded: false, unsupported_numbers: ['50'], unknown_refs: [3] };
  const answering = (answer: string) =>
    adapter({
      stream: async function* () {
        if (answer) yield { type: 'text', text: answer };
        yield { type: 'done', stopReason: 'end_turn', usage: { model: 'IGNORED', input_tokens: 1, output_tokens: 1 } };
      },
    });
  const docTurn = (over: Partial<PreparedTurn> = {}) => {
    const base = turn();
    return turn({ ctx: { ...base.ctx, agentId: AGENT }, chunks: [chunk], systemPrompt: '예산 50', verifySources: sources, ...over });
  };
  const refs = (row: Record<string, unknown>) => row.source_references as Record<string, unknown>;

  it('NODA 검증 결과를 답변 행 source_references.verify에 저장한다', async () => {
    setLlmAdapterForTests(answering('예산은 50입니다 [1]'));
    const verify = vi.fn<VerifyFn>(async () => VERIFIED);
    await run(docTurn(), undefined, { verify });
    const rows = inserted('messages');
    expect(refs(rows[1]).verify).toEqual(VERIFIED);
    expect(refs(rows[0])).not.toHaveProperty('verify');
    expect(keySet(rows[0])).toBe(keySet(rows[1]));
    expect(rows[1].content).toBe('예산은 50입니다 [1]');
  });

  it('검증은 그 턴 sources를 받은 순서 그대로 보낸다', async () => {
    setLlmAdapterForTests(answering('예산은 50입니다 [1]'));
    let savedBefore = -1;
    const verify = vi.fn<VerifyFn>(async () => {
      savedBefore = inserted('messages').length;
      return VERIFIED;
    });
    await run(docTurn(), undefined, { verify });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith({ tenant: nodaTenant(AGENT), answer: '예산은 50입니다 [1]', sources });
    // 메시지 저장 전에 부른다 — 결과를 함께 저장하려고
    expect(savedBefore).toBe(0);
  });

  it('검증이 실패하면 답과 저장은 그대로, verify 칸이 없고 운영 기록만 남는다', async () => {
    setLlmAdapterForTests(answering('예산은 50입니다 [1]'));
    const verify = vi.fn<VerifyFn>(async () => {
      throw new NodaError('NODA 503', 'http', 503);
    });
    const events = await run(docTurn(), undefined, { verify });
    const rows = inserted('messages');
    expect(rows).toHaveLength(2);
    expect(rows[1].content).toBe('예산은 50입니다 [1]');
    expect(refs(rows[1])).not.toHaveProperty('verify');
    expect(keySet(rows[0])).toBe(keySet(rows[1]));
    expect(events.some((e) => e.event === 'error')).toBe(false);
    expect(events.at(-1)?.event).toBe('done');
    const logs = inserted('system_logs');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: 'warning', category: 'api', org_id: 'o' });
    expect(logs[0].details).toEqual({ agent_id: AGENT, code: 'http', status: 503 });
    // 답변 글은 운영 기록에 남기지 않는다
    expect(JSON.stringify(logs)).not.toContain('예산은');
  });

  it(`검증이 ${VERIFY_TIMEOUT_MS / 1000}초 넘게 걸리면 기다리지 않는다`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      setLlmAdapterForTests(answering('예산은 50입니다 [1]'));
      const verify = vi.fn<VerifyFn>(() => new Promise<NodaVerifyResult>(() => {}));
      let finished = false;
      const done = run(docTurn(), undefined, { verify }).then((events) => {
        finished = true;
        return events;
      });
      await vi.advanceTimersByTimeAsync(VERIFY_TIMEOUT_MS - 1);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const events = await done;
      expect(events.at(-1)?.event).toBe('done');
      const rows = inserted('messages');
      expect(rows).toHaveLength(2);
      expect(refs(rows[1])).not.toHaveProperty('verify');
      expect(inserted('system_logs')[0]).toMatchObject({
        level: 'warning', category: 'api', details: { agent_id: AGENT, code: 'timeout', status: null },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('verifySources가 비었으면 검증을 부르지 않는다', async () => {
    setLlmAdapterForTests(answering('예산은 50입니다'));
    const verify = vi.fn<VerifyFn>(async () => VERIFIED);
    await run(docTurn({ verifySources: [] }), undefined, { verify });
    expect(verify).not.toHaveBeenCalled();
    expect(refs(inserted('messages')[1])).not.toHaveProperty('verify');
  });

  it('답이 비었으면 검증을 부르지 않는다', async () => {
    setLlmAdapterForTests(answering(''));
    const verify = vi.fn<VerifyFn>(async () => VERIFIED);
    await run(docTurn(), undefined, { verify });
    expect(verify).not.toHaveBeenCalled();
  });

  it('턴이 오류로 끝나면 검증을 부르지 않는다', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setLlmAdapterForTests(
      adapter({
        // eslint-disable-next-line require-yield
        stream: async function* () {
          throw new Error('연결 오류');
        },
      })
    );
    const verify = vi.fn<VerifyFn>(async () => VERIFIED);
    await run(docTurn(), undefined, { verify });
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('streamTurn — 실패', () => {
  it('루프가 던지면 쓴 토큰을 aborted로 남기고 error를 보낸다', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setLlmAdapterForTests(
      adapter({
        stream: async function* () {
          yield { type: 'tool_use', id: 't1', name: 'nope', input: {} };
          yield { type: 'done', stopReason: 'tool_use', usage: { model: 'IGNORED', input_tokens: 8, output_tokens: 4 } };
          throw new Error('연결 오류');
        },
      })
    );
    const events = await run(turn());
    const chat = inserted('usage_logs').filter((r) => r.action === 'chat_message');
    expect(chat).toHaveLength(1);
    expect(details(chat[0])).toMatchObject({ aborted: true, model: MODEL, input_tokens: 8, output_tokens: 4 });
    expect(inserted('messages')).toHaveLength(0);
    // AI 오류가 아닌 내부 예외 원문도 직원에게 보이지 않는다
    expect(events.at(-1)).toEqual({
      event: 'error',
      data: { message: '응답 생성 중 오류가 발생했습니다. 잠시 뒤 다시 시도해 주세요.' },
    });
    expect(inserted('system_logs')[0]).toMatchObject({ level: 'error', category: 'api', org_id: 'o' });
  });

  it('크레딧 부족 같은 AI 오류는 원문 대신 관리자 문의 안내, 원문은 critical 운영 기록에', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setLlmAdapterForTests(
      adapter({
        // eslint-disable-next-line require-yield
        stream: async function* () {
          throw new LlmApiError(400, 'Your credit balance is too low to access the Anthropic API.');
        },
      })
    );
    const events = await run(turn());
    const last = events.at(-1) as { event: string; data: { message: string } };
    expect(last).toEqual({ event: 'error', data: { message: LLM_MESSAGES.unavailable } });
    expect(last.data.message).not.toMatch(/credit/i);
    const log = inserted('system_logs')[0];
    expect(log).toMatchObject({ level: 'critical', category: 'api', org_id: 'o' });
    expect(JSON.stringify(log.details)).toContain('credit balance');
  });

  it('보내기가 던져도(연결 끊김) 저장과 기록은 계속된다', async () => {
    // 라우트가 enqueue 실패를 삼키지만, 실행기 자신도 보내기 실패로 저장을 건너뛰면 안 된다
    setLlmAdapterForTests(adapter());
    await run(turn(), () => {
      throw new Error('클라이언트가 떠났다');
    });
    expect(inserted('messages')).toHaveLength(2);
    expect(inserted('usage_logs').map((r) => r.action).sort()).toEqual(['chat_message', 'conversation_title']);
    expect(details(inserted('usage_logs').find((r) => r.action === 'chat_message')!)).not.toHaveProperty('aborted');
  });
});
