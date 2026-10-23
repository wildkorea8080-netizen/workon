// tests/prepare-preflight.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * prepareTurn의 능력 preflight(S4-a, 판정 R4). 참고 문서를 불러오지 못하면 **대화를 만들기 전에**
 * 거절한다 — 거절될 요청으로 빈 대화가 쌓이거나 새 대화의 첨부가 묶였다 지워지지 않게.
 * DB·NODA는 흉내 내고 호출 순서를 본다.
 */

const NEW_CONV = 'c0000000-0000-4000-8000-0000000000aa';
const AGENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const DOC = '11111111-2222-4333-8444-555555555555';
const A = '00000000-0000-4000-8000-00000000000a';

const calls: string[] = [];
const state = {
  capabilities: { doc_search: {}, file_read: {} } as Record<string, unknown>,
  docs: [{ id: DOC, title: '여비 규정', file_name: '규정.hwp', noda_status: 'ready' }] as unknown[],
};

vi.mock('@/lib/supabaseAdmin', () => {
  function from(table: string) {
    let op = 'select';
    const eqs: Record<string, unknown> = {};
    const q: Record<string, unknown> = {
      select: () => q,
      insert: () => { op = 'insert'; return q; },
      delete: () => { op = 'delete'; return q; },
      eq: (col: string, v: unknown) => { eqs[col] = v; return q; },
      maybeSingle: async () => {
        if (table === 'agents') {
          return { data: { id: AGENT, deleted_at: null, is_active: true, tier: 'official', version: 3, name: '비서', system_prompt: null, model_id: null, capabilities: state.capabilities, agent_type: null }, error: null };
        }
        return { data: null, error: null };
      },
      single: async () => {
        calls.push(`insert:${table}`);
        return { data: { id: NEW_CONV }, error: null };
      },
      then: (resolve: (v: unknown) => unknown) => {
        if (table === 'documents' && op === 'select') {
          calls.push(`documents:${String(eqs.agent_id)}`);
          return Promise.resolve({ data: state.docs, error: null }).then(resolve);
        }
        if (op === 'delete') calls.push(`delete:${table}:${String(eqs.id ?? eqs.conversation_id)}`);
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    };
    return q;
  }
  return { supabaseAdmin: { from } };
});

const noda = vi.hoisted(() => ({ getContext: vi.fn() }));
vi.mock('@/lib/noda', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/noda')>();
  return { ...actual, noda };
});
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn(async () => {}) }));
vi.mock('@/lib/actor-scope', () => ({
  getActorScope: async () => ({ userId: 'u1', departmentId: 'd1', organizationId: 'o1' }),
}));
vi.mock('@/lib/agent-permissions', () => ({ canUseAgent: () => true, AGENT_ACCESS_COLUMNS: 'id' }));
vi.mock('@/lib/connector-scope', () => ({ getCapabilityScope: async () => ({ publicDataConnectors: new Set() }) }));
vi.mock('@/lib/usage-limit', () => ({ checkTokenLimit: async () => ({ allowed: true }), limitMessage: () => '' }));
vi.mock('@/lib/filter', () => ({ filterUserInput: async () => ({ isValid: true }) }));
vi.mock('@/lib/model-policy', () => ({
  getAllowedModelIds: async () => ['claude-sonnet-4-6'],
  resolveModel: () => ({ modelId: 'claude-sonnet-4-6', substituted: false }),
}));
vi.mock('@/lib/assistant/history', () => ({ loadHistory: async () => [] }));
vi.mock('@/lib/attachments/store', () => ({
  checkAttachable: vi.fn(async (_u: string, _ids: string[], conv: string | null) => {
    calls.push(`check:${conv}`);
    return { ok: true };
  }),
  bindAttachments: vi.fn(async (_u: string, conv: string) => {
    calls.push(`bind:${conv}`);
    return { ok: true, rows: [], newlyBound: [] };
  }),
  listConversationAttachments: vi.fn(async () => []),
  deleteConversationAttachments: vi.fn(async (conv: string) => {
    calls.push(`cleanup:${conv}`);
  }),
  loadExtract: vi.fn(async () => null),
}));

import { prepareTurn } from '@/lib/assistant/prepare';
import { NodaError } from '@/lib/noda';
import { DOCUMENTS_UNAVAILABLE_MESSAGE } from '@/lib/capabilities/doc-search';

const session = { user: { id: 'u1' } } as never;

beforeEach(() => {
  calls.length = 0;
  state.capabilities = { doc_search: {}, file_read: {} };
  state.docs = [{ id: DOC, title: '여비 규정', file_name: '규정.hwp', noda_status: 'ready' }];
  noda.getContext.mockReset();
  noda.getContext.mockImplementation(async () => {
    throw new NodaError('HTTP 503', 'http', 503);
  });
});

describe('prepareTurn — 참고 문서 preflight', () => {
  it('NODA를 부르지 못하면 대화를 만들지 않고 첨부도 묶지 않은 채 503 documents_unavailable', async () => {
    const out = await prepareTurn(session, { agent_id: AGENT, message: '여비 규정', attachment_ids: [A] });
    expect(out).toEqual({
      ok: false,
      status: 503,
      message: DOCUMENTS_UNAVAILABLE_MESSAGE,
      details: { code: 'documents_unavailable' },
    });
    expect(calls).toEqual([`documents:${AGENT}`]);
    expect(noda.getContext).toHaveBeenCalledTimes(1);
  });

  it('skip_documents가 정확히 true면 NODA 없이 일반 답변으로 준비한다', async () => {
    const out = await prepareTurn(session, { agent_id: AGENT, message: '여비 규정', skip_documents: true });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(noda.getContext).not.toHaveBeenCalled();
    expect(out.turn.documentsSkipped).toBe(true);
    expect(out.turn.docDropped).toBeNull();
    expect(out.turn.ctx.skipDocuments).toBe(true);
    expect(out.turn.systemPrompt).toContain('[참고 문서 없이 답함]');
    expect(calls).toContain('insert:conversations');
  });

  it('skip_documents가 true가 아닌 값이면 건너뛰지 않는다', async () => {
    for (const v of ['true', 1, 'yes']) {
      const out = await prepareTurn(session, { agent_id: AGENT, message: '여비 규정', skip_documents: v });
      expect(out).toMatchObject({ ok: false, status: 503 });
    }
  });

  it('근거를 찾으면 조각·뺀 수가 턴에 실리고 문서 id 앞부분은 프롬프트에 없다', async () => {
    noda.getContext.mockImplementation(async () => ({
      context: `[1] ${DOC}__규정.hwp p.3\n일비 2만원`,
      sources: [{ n: 1, chunk_id: 'c1', doc_id: 'd', filename: `${DOC}__규정.hwp`, anchors: [{ page: 3 }], similarity: 0.9 }],
      dropped: 4,
    }));
    const out = await prepareTurn(session, { agent_id: AGENT, message: '여비 규정' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.turn.chunks).toMatchObject([{ documentId: DOC, documentTitle: '여비 규정', page: 3 }]);
    expect(out.turn.docDropped).toBe(4);
    expect(out.turn.documentsSkipped).toBe(false);
    expect(out.turn.systemPrompt).toContain('일비 2만원');
    expect(out.turn.systemPrompt).not.toContain(`${DOC}__`);
  });

  it('ready 문서가 없는 비서는 NODA 장애 중에도 평소처럼 준비한다', async () => {
    state.docs = [{ id: DOC, title: null, file_name: '규정.hwp', noda_status: 'reading' }];
    const out = await prepareTurn(session, { agent_id: AGENT, message: '여비 규정' });
    expect(out.ok).toBe(true);
    expect(noda.getContext).not.toHaveBeenCalled();
  });

  it('문서 찾기가 꺼진 비서는 skip_documents가 와도 아무 일 없다', async () => {
    state.capabilities = { file_read: {} };
    const out = await prepareTurn(session, { agent_id: AGENT, message: '질문', skip_documents: true });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.turn.documentsSkipped).toBe(false);
    expect(out.turn.systemPrompt).not.toContain('참고 문서 없이');
    expect(calls).not.toContain(`documents:${AGENT}`);
  });
});
