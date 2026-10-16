// tests/prepare-attachments.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * prepareTurn의 첨부 갈래. 실패가 조용한 곳이다 — 묶기에 실패한 새 대화가 남으면
 * 목록에 빈 대화가 쌓이고, 이미 묶인 파일을 '방금 붙임'으로 다시 적으면 저장 글이 틀린다.
 * DB와 첨부 저장소는 흉내 내고 호출 순서를 본다.
 */

const NEW_CONV = 'c0000000-0000-4000-8000-0000000000aa';
const OLD_CONV = 'c0000000-0000-4000-8000-0000000000bb';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

const calls: string[] = [];

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
          return { data: { id: 'agent', deleted_at: null, is_active: true, tier: 'official', version: 3, name: '비서', system_prompt: null, model_id: null, capabilities: { file_read: {} }, agent_type: null }, error: null };
        }
        if (table === 'conversations') return { data: eqs.id === OLD_CONV ? { id: OLD_CONV } : null, error: null };
        return { data: null, error: null };
      },
      single: async () => {
        calls.push(`insert:${table}`);
        return { data: { id: NEW_CONV }, error: null };
      },
      then: (resolve: (v: unknown) => unknown) => {
        if (op === 'delete') calls.push(`delete:${table}:${String(eqs.id ?? eqs.conversation_id)}`);
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    };
    return q;
  }
  return { supabaseAdmin: { from } };
});

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

const store = {
  check: { ok: true } as { ok: true } | { ok: false; message: string },
  bind: null as null | { ok: false; message: string } | { ok: true; rows: unknown[]; newlyBound: string[] },
  listed: [] as unknown[],
  listFails: false,
};
vi.mock('@/lib/attachments/store', () => ({
  checkAttachable: vi.fn(async (_u: string, _ids: string[], conv: string | null) => {
    calls.push(`check:${conv}`);
    return store.check;
  }),
  bindAttachments: vi.fn(async (_u: string, conv: string) => {
    calls.push(`bind:${conv}`);
    return store.bind;
  }),
  listConversationAttachments: vi.fn(async (_u: string, _c: string, opts?: { onError?: (m: string) => void }) => {
    if (store.listFails) {
      opts?.onError?.('boom');
      return [];
    }
    return store.listed;
  }),
  deleteConversationAttachments: vi.fn(async (conv: string) => {
    calls.push(`cleanup:${conv}`);
  }),
  loadExtract: vi.fn(async () => null),
}));

import { prepareTurn } from '@/lib/assistant/prepare';

const session = { user: { id: 'u1' } } as never;
const summary = { kind: 'text', chars: 3, tables: [], warnings: [] };
const record = (id: string, name: string, created_at: string) => ({
  id, user_id: 'u1', conversation_id: OLD_CONV, file_name: name, size_bytes: 1, status: 'ready', summary, error: null,
  created_at, storage_path: 'p', extract_path: 'p.json',
});

beforeEach(() => {
  calls.length = 0;
  store.check = { ok: true };
  store.bind = null;
  store.listed = [];
  store.listFails = false;
});

describe('prepareTurn — 첨부', () => {
  it('묶기 전 확인에 걸리면 대화를 만들지 않는다', async () => {
    store.check = { ok: false, message: '쓸 수 없는 첨부가 있습니다.' };
    const out = await prepareTurn(session, { agent_id: 'agent', message: '질문', attachment_ids: [A] });
    expect(out).toMatchObject({ ok: false, status: 400, message: '쓸 수 없는 첨부가 있습니다.' });
    expect(calls).toEqual(['check:null']);
  });

  it('새 대화에서 묶기가 실패하면 첨부 정리 → 대화 삭제 뒤 400', async () => {
    store.bind = { ok: false, message: '한 대화에 첨부는 30개까지입니다.' };
    const out = await prepareTurn(session, { agent_id: 'agent', message: '질문', attachment_ids: [A] });
    expect(out).toMatchObject({ ok: false, status: 400, message: '한 대화에 첨부는 30개까지입니다.' });
    expect(calls).toEqual([
      'check:null',
      'insert:conversations',
      `bind:${NEW_CONV}`,
      `cleanup:${NEW_CONV}`,
      `delete:conversations:${NEW_CONV}`,
    ]);
  });

  it('이어지는 대화에서 묶기가 실패하면 대화는 지우지 않는다', async () => {
    store.bind = { ok: false, message: '쓸 수 없는 첨부가 있습니다.' };
    const out = await prepareTurn(session, { agent_id: 'agent', message: '질문', conversation_id: OLD_CONV, attachment_ids: [A] });
    expect(out.ok).toBe(false);
    expect(calls).toEqual([`check:${OLD_CONV}`, `bind:${OLD_CONV}`]);
  });

  it('이미 이 대화에 묶여 있던 첨부는 방금 붙인 것으로 치지 않는다', async () => {
    store.listed = [record(A, '지난.xlsx', '2026-10-17T01:00:00Z'), record(B, '예산.xlsx', '2026-10-17T02:00:00Z')];
    store.bind = { ok: true, rows: store.listed, newlyBound: [B] };
    const out = await prepareTurn(session, { agent_id: 'agent', message: '질문', conversation_id: OLD_CONV, attachment_ids: [A, B] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.turn.ctx.attachments.map((a) => [a.ref, a.isNew])).toEqual([['a1', false], ['a2', true]]);
    expect(out.turn.storedUserContent).toBe('[첨부 파일: 예산.xlsx]\n질문');
    expect(out.turn.systemPrompt).not.toMatch(/지난\.xlsx[^\n]*방금 붙임/);
  });

  it('목록 조회가 실패하면 이번 턴이 첨부 없이 돈다는 것을 남긴다', async () => {
    store.listFails = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await prepareTurn(session, { agent_id: 'agent', message: '질문', conversation_id: OLD_CONV });
    expect(out.ok).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('첨부'))).toBe(true);
    warn.mockRestore();
  });
});
