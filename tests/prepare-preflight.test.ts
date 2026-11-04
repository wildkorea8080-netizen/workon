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
  appDefinition: null as unknown,
  appDraft: null as unknown,
  canEdit: true,
  savedMessage: null as unknown,
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
      eq: (col: string, v: unknown) => { eqs[col] = v; if (table === 'messages') calls.push(`resume-filter:${col}:${String(v)}`); return q; },
      order: () => q,
      limit: () => q,
      range: () => q,
      maybeSingle: async () => {
        if (table === 'messages') return { data: state.savedMessage, error: null };
        if (table === 'agents') {
          return { data: { id: AGENT, deleted_at: null, is_active: true, tier: 'official', version: 3, name: '비서', system_prompt: null, model_id: null, capabilities: state.capabilities, agent_type: null, app_definition: state.appDefinition, app_draft: state.appDraft }, error: null };
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
vi.mock('@/lib/agent-permissions', () => ({ canUseAgent: () => true, canEditAgent: () => state.canEdit, AGENT_ACCESS_COLUMNS: 'id' }));
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
  state.appDefinition = null;
  state.appDraft = null;
  state.canEdit = true;
  state.savedMessage = null;
  calls.length = 0;
  state.capabilities = { doc_search: {}, file_read: {} };
  state.docs = [{ id: DOC, title: '여비 규정', file_name: '규정.hwp', noda_status: 'ready' }];
  noda.getContext.mockReset();
  noda.getContext.mockImplementation(async () => {
    throw new NodaError('HTTP 503', 'http', 503);
  });
});

describe('prepareTurn — 참고 문서 preflight', () => {
  it('rejects missing required files and disabled file inputs before creating a conversation', async () => {
    state.appDefinition = { schemaVersion: 1, fields: [{ key: 'source', label: '내용', type: 'text', required: true }], output: 'bullets', attachments: { required: true } };
    const request = { agent_id: AGENT, message: '앱 실행', app_version: 3, app_inputs: { source: '요약' } };
    expect(await prepareTurn(session, request)).toMatchObject({ ok: false, status: 400, message: '이 앱은 파일 첨부가 필요합니다.' });
    delete (state.appDefinition as Record<string, unknown>).attachments;
    expect(await prepareTurn(session, { ...request, attachment_ids: [A] })).toMatchObject({ ok: false, status: 400, message: '이 앱은 파일 입력을 받지 않습니다.' });
    expect(calls).toEqual([]);
  });
  it('rejects more than three app files on the server even if the screen check is bypassed', async () => {
    state.appDefinition = { schemaVersion: 1, fields: [{ key: 'source', label: '내용', type: 'text', required: true }], output: 'bullets', attachments: { required: false } };
    const ids = [1, 2, 3, 4].map(n => `00000000-0000-4000-8000-00000000000${n}`);
    expect(await prepareTurn(session, { agent_id: AGENT, message: '앱 실행', app_version: 3, app_inputs: { source: '요약' }, attachment_ids: ids })).toMatchObject({ ok: false, status: 400, message: '앱에는 파일을 최대 3개 첨부할 수 있습니다.' });
    expect(calls).toEqual([]);
  });
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


describe('입력형 앱의 서버 실행 계약', () => {
  const form = { schemaVersion: 1, fields: [{ key: 'source', label: '원문', type: 'textarea', required: true }], output: 'bullets' };
  it('설정 판이 다르면 대화 생성 전에 거절한다', async () => {
    state.appDefinition = form;
    const out = await prepareTurn(session, { agent_id: AGENT, message: '앱 실행', app_version: 2, app_inputs: { source: '가상 자료' } });
    expect(out).toMatchObject({ ok: false, status: 409 }); expect(calls).toEqual([]);
  });
  it('필수 항목 누락과 입력 폼 우회는 대화 생성 전에 거절한다', async () => {
    state.appDefinition = form;
    for (const extra of [{ app_version: 3, app_inputs: {} }, {}]) {
      expect(await prepareTurn(session, { agent_id: AGENT, message: '앱 실행', ...extra })).toMatchObject({ ok: false });
      expect(calls).toEqual([]);
    }
  });
  it('검증한 입력으로 메시지를 만들고 서버 응답 형식을 추가한다', async () => {
    state.appDefinition = form; state.capabilities = {};
    const out = await prepareTurn(session, { agent_id: AGENT, message: '무시되는 임의 메시지', app_version: 3, app_inputs: { source: '가상 자료 30건' } });
    expect(out.ok).toBe(true); if (!out.ok) return;
    expect(out.turn.storedUserContent).toContain('가상 자료 30건');
    expect(out.turn.storedUserContent).not.toContain('무시되는 임의 메시지');
    expect(out.turn.systemPrompt).toContain('글머리 목록');
    expect(calls).toContain('insert:conversations');
  });
});


describe('시험 판 실행(0053)', () => {
  const live = { schemaVersion: 1, fields: [{ key: 'source', label: '원문', type: 'textarea', required: true }], output: 'bullets' };
  const SAVED = '2026-11-04T12:00:00.000Z';
  const draft = (over: Record<string, unknown> = {}) => ({
    settings: { name: '시험 비서', description: null, category: null, system_prompt: '시험 판 지시문입니다', app_definition: { schemaVersion: 1, fields: [{ key: 'memo', label: '메모', type: 'text', required: true }], output: 'checklist' }, capabilities: {} },
    base_version: 3, saved_by: 'u1', saved_at: SAVED, ...over,
  });
  const body = (extra: Record<string, unknown> = {}) => ({ agent_id: AGENT, message: '앱 실행', app_version: 3, app_inputs: { memo: '시험 입력' }, app_draft: SAVED, ...extra });
  beforeEach(() => { state.appDefinition = live; state.capabilities = {}; });

  it('고칠 수 있는 사람이 본 그 시험 판이면 시험 판의 지시문·입력 설정으로 준비하고 표시를 남긴다', async () => {
    state.appDraft = draft();
    const out = await prepareTurn(session, body());
    expect(out.ok).toBe(true); if (!out.ok) return;
    expect(out.turn.systemPrompt).toContain('시험 판 지시문입니다');
    expect(out.turn.systemPrompt).toContain('체크리스트');
    expect(out.turn.storedUserContent).toContain('시험 입력');
    expect(out.turn.appDraftSavedAt).toBe(SAVED);
  });
  it('시험 판 표시 없이 부르면 지금 판 그대로(예약·연동·일반 실행)', async () => {
    state.appDraft = draft();
    const out = await prepareTurn(session, { agent_id: AGENT, message: '앱 실행', app_version: 3, app_inputs: { source: '지금 판 입력' } });
    expect(out.ok).toBe(true); if (!out.ok) return;
    expect(out.turn.systemPrompt).not.toContain('시험 판 지시문입니다');
    expect(out.turn).not.toHaveProperty('appDraftSavedAt');
  });
  it('고칠 수 없으면 403, 시험 판이 없거나 바뀌었거나 그 사이 배포됐으면 409, 이어 쓰기·재개는 400 — 모두 대화를 만들기 전에', async () => {
    state.appDraft = draft(); state.canEdit = false;
    expect(await prepareTurn(session, body())).toMatchObject({ ok: false, status: 403 });
    state.canEdit = true;
    state.appDraft = null;
    expect(await prepareTurn(session, body())).toMatchObject({ ok: false, status: 409 });
    state.appDraft = draft({ saved_at: '2026-11-04T13:00:00.000Z' });
    expect(await prepareTurn(session, body())).toMatchObject({ ok: false, status: 409 });
    state.appDraft = draft({ base_version: 2 });
    expect(await prepareTurn(session, body())).toMatchObject({ ok: false, status: 409, message: expect.stringContaining('새로 배포') });
    state.appDraft = draft();
    expect(await prepareTurn(session, body({ conversation_id: NEW_CONV }))).toMatchObject({ ok: false, status: 400 });
    expect(await prepareTurn(session, body({ resume_message_id: '11111111-1111-4111-8111-111111111111' }))).toMatchObject({ ok: false, status: 400 });
    expect(await prepareTurn(session, body({ app_draft: 1 }))).toMatchObject({ ok: false, status: 400 });
    expect(calls).toEqual([]);
  });
});


describe('조건 평가 입력의 신뢰 경계', () => {
  it('검증한 선택값만 정규화하고 요청의 내부 단계 입력은 무시한다', async () => {
    state.appDefinition = { schemaVersion: 1, fields: [{ key: 'review', label: '검토 여부', type: 'select', required: true, options: ['예', '아니오'] }], output: 'bullets', steps: [{ name: '검토', instruction: '검토하세요.', when: { field: 'review', equals: '예' } }, { name: '작성', instruction: '최종 작성' }] };
    state.capabilities = {};
    const out = await prepareTurn(session, { agent_id: AGENT, message: '앱 실행', app_version: 3, app_inputs: { review: ' 아니오 ' }, appStepInputs: { review: '예' } });
    expect(out.ok).toBe(true); if (!out.ok) return;
    expect(out.turn.appStepInputs).toEqual({ review: '아니오' });
    expect(out.turn.appSteps?.[0].when).toEqual({ all: [{ field: 'review', op: 'equals', value: '예' }] });
  });
});


describe('재개 기록의 소유권·판·입력 검사', () => {
  const resumeId = '11111111-1111-4111-8111-111111111111';
  const definition = { schemaVersion: 1, fields: [{ key: 'source', label: '자료', type: 'text', required: true }], output: 'bullets', steps: [{ name: '정리', instruction: '정리' }, { name: '작성', instruction: '작성' }] };
  const body = { agent_id: AGENT, message: '앱 실행', app_version: 3, app_inputs: { source: '가상 자료' }, resume_message_id: resumeId };
  beforeEach(() => {
    state.capabilities = {}; state.appDefinition = definition;
    state.savedMessage = { id: resumeId, agent_version: 3, conversation: { user_id: 'u1', agent_id: AGENT }, source_references: { app_inputs: { source: '가상 자료' }, app_steps: [{ name: '정리', status: 'completed', output: '서버에 저장된 결과' }, { name: '작성', status: 'failed' }] } };
  });
  it('서버 기록만 재사용하고 클라이언트가 보낸 중간 결과는 무시한다', async () => {
    const out = await prepareTurn(session, { ...body, appResumeRecords: [{ output: '위조 결과' }] });
    expect(out.ok).toBe(true); if (!out.ok) return;
    expect(out.turn.appResumeRecords?.[0]).toMatchObject({ output: '서버에 저장된 결과', reused: true });
    expect(out.turn.appResumeFrom).toBe(resumeId);
    expect(calls).toContain('resume-filter:conversation.user_id:u1'); expect(calls).toContain(`resume-filter:conversation.agent_id:${AGENT}`);
  });
  it.each([{ user_id: 'other', agent_id: AGENT }, { user_id: 'u1', agent_id: 'other' }])('다른 사용자/앱 기록은 대화 생성 전에 차단: %j', async owner => {
    (state.savedMessage as Record<string, unknown>).conversation = owner;
    expect(await prepareTurn(session, body)).toMatchObject({ ok: false, status: 404 }); expect(calls).not.toContain('insert:conversations');
  });
  it('판 또는 입력 변경은 거절한다', async () => {
    (state.savedMessage as Record<string, unknown>).agent_version = 2;
    expect(await prepareTurn(session, body)).toMatchObject({ ok: false, status: 409 });
    (state.savedMessage as Record<string, unknown>).agent_version = 3;
    expect(await prepareTurn(session, { ...body, app_inputs: { source: '바뀐 자료' } })).toMatchObject({ ok: false, status: 409 });
    expect(calls).not.toContain('insert:conversations');
  });
  it('근거가 바뀔 수 있는 자료 연결 앱은 재사용하지 않는다', async () => {
    state.capabilities = { doc_search: {} };
    expect(await prepareTurn(session, body)).toMatchObject({ ok: false, status: 409 }); expect(calls).not.toContain('insert:conversations');
  });
  it('파일 첨부만 받는 앱은 이번 실행에 파일이 없으면 재개한다', async () => {
    state.capabilities = { file_read: {} };
    state.appDefinition = { ...definition, attachments: { required: false } };
    const out = await prepareTurn(session, body);
    expect(out.ok).toBe(true); if (!out.ok) return;
    expect(out.turn.appResumeFrom).toBe(resumeId);
  });
  it('파일 첨부만 받는 앱이라도 재개 요청에 파일을 붙이면 거절한다', async () => {
    state.capabilities = { file_read: {} };
    state.appDefinition = { ...definition, attachments: { required: false } };
    expect(await prepareTurn(session, { ...body, attachment_ids: [A] })).toMatchObject({ ok: false, status: 409 }); expect(calls).not.toContain('insert:conversations');
  });
});
