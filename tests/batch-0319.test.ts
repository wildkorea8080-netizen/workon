// tests/batch-0319.test.ts
// 대화의 적용 기준일(2026-11-26) — 입력창에서 날짜를 고르면 그날 시행 중인 판으로 찾는다.
// 미래면 시행일을 예약한 새 판, 과거면 그날 시행 중이던 지난 판의 원본을 다시 읽어 낱말로 찾은 문단을 근거로 더한다.
import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { basisDateNote, basisDatePromptLine, isBasisDate, parseChatBasisDate } from '@/lib/chat-basis-date';
import { createDocSearch, pastContextHead, type AgentDocument, type DocSearchDeps } from '@/lib/capabilities/doc-search';
import type { NodaContextResult } from '@/lib/noda';
import type { TurnContext } from '@/lib/capabilities/types';
import { kstToday } from '@/lib/edition-dates';
import { buildMessageRows } from '@/lib/assistant/persist';

const AGENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OLD = '11111111-2222-4333-8444-555555555555';
const NEW = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const RET = '77777777-7777-4777-8777-777777777777';

describe('적용 기준일 받기', () => {
  it('있는 날만 — 비면 오늘 기준, 틀리면 거절', () => {
    expect(parseChatBasisDate(undefined)).toEqual({ ok: true, date: null });
    expect(parseChatBasisDate('')).toEqual({ ok: true, date: null });
    expect(parseChatBasisDate('2024-02-29')).toEqual({ ok: true, date: '2024-02-29' });
    expect(parseChatBasisDate('2026-02-29').ok).toBe(false);
    expect(parseChatBasisDate('2026-13-01').ok).toBe(false);
    expect(parseChatBasisDate('1900-01-01').ok).toBe(false);
    expect(parseChatBasisDate(20260101).ok).toBe(false);
    expect(isBasisDate('2026-1-1')).toBe(false);
    expect(basisDateNote('2025-06-01')).toBe('적용 기준일 2025-06-01로 찾은 답');
    expect(basisDatePromptLine('2025-06-01', true)).toContain('지난 판');
  });
});

function deps(docs: AgentDocument[], context: NodaContextResult, over: Partial<DocSearchDeps> = {}) {
  const d: DocSearchDeps = {
    documentsOf: async () => docs,
    fetchContext: vi.fn(async () => context),
    findDocuments: async () => [],
    deleteOrphan: async () => {},
    orgTypeOf: async () => null,
    commonDocumentsOf: async () => [],
    fetchCommonContext: async () => ({ context: '', sources: [], dropped: 0 }),
    findCommonDocuments: async () => [],
    deleteCommonOrphan: async () => {},
    log: vi.fn(async () => {}),
    ...over,
  };
  return d;
}
const ctx = (preflight: unknown, message: string): TurnContext => ({
  organizationId: 'org', departmentId: 'dept', userId: 'u', agentId: AGENT, agentVersion: 1, conversationId: 'c', attachments: [],
  capabilities: { doc_search: {} }, message, preflight: { doc_search: preflight }, skipDocuments: false,
});
async function turn(d: DocSearchDeps, message: string, basisDate?: string) {
  const cap = createDocSearch(d);
  const pre = await cap.preflight!({ organizationId: 'org', agentId: AGENT, message, skipDocuments: false, ...(basisDate ? { basisDate } : {}) });
  if (!pre.ok) throw new Error('거절됨');
  return cap.prepare!(ctx(pre.carry, message));
}

describe('미래 기준일 — 시행일을 예약한 새 판', () => {
  // 옛 판(지금 시행) → 새 판(2099-01-01 시행 예약). 둘 다 보관소에 있다
  const docs: AgentDocument[] = [
    { id: OLD, title: '여비 규정(옛 판)', file_name: 'old.hwpx', noda_status: 'ready' },
    { id: NEW, title: '여비 규정(새 판)', file_name: 'new.hwpx', noda_status: 'ready', replaces_id: OLD, effective_from: '2099-01-01' },
  ];
  const context: NodaContextResult = {
    context: `[1] ${OLD}__old.hwpx\n일비 2만원\n[2] ${NEW}__new.hwpx\n일비 3만원`,
    sources: [
      { n: 1, chunk_id: 'a', doc_id: 'x', filename: `${OLD}__old.hwpx`, similarity: 0.9 },
      { n: 2, chunk_id: 'b', doc_id: 'y', filename: `${NEW}__new.hwpx`, similarity: 0.9 },
    ],
    dropped: 0,
  };
  it('기준일이 없으면 옛 판, 시행일 뒤의 기준일이면 새 판 — 모델에게 기준일을 밝히게', async () => {
    const today = await turn(deps(docs, context), '일비');
    expect(today.chunks?.map((c) => c.documentId)).toEqual([OLD]);
    expect(today.basisDate).toBeUndefined();
    const future = await turn(deps(docs, context), '일비', '2099-06-01');
    expect(future.chunks?.map((c) => c.documentId)).toEqual([NEW]);
    expect(future.basisDate).toBe('2099-06-01');
    expect(future.systemAddendum).toContain('적용 기준일 2099-06-01로 물었다');
  });
});

describe('과거 기준일 — 그날의 지난 판을 원문에서', () => {
  // 지난 판(내림, 2026-01-01 새 판 시행 전까지) → 지금 판
  const docs: AgentDocument[] = [
    { id: RET, title: '여비 규정(2025)', file_name: 'r.hwpx', noda_status: 'retired', storage_path: 'orig/r.hwpx', effective_from: '2025-01-01' },
    { id: NEW, title: '여비 규정(2026)', file_name: 'n.hwpx', noda_status: 'ready', replaces_id: RET, effective_from: '2026-01-01' },
  ];
  const context: NodaContextResult = {
    context: `[1] ${NEW}__n.hwpx\n제5조 출장 숙박비는 하루 7만원`,
    sources: [{ n: 1, chunk_id: 'a', doc_id: 'x', filename: `${NEW}__n.hwpx`, similarity: 0.9 }],
    dropped: 0,
  };
  const read = vi.fn(async () => ({ ok: true as const, text: '제5조(숙박비) 출장 숙박비는 하루 6만원으로 한다.\n\n제6조(식비) 하루 2만원.' }));

  it('지금 판 근거는 그대로, 지난 판 문단을 다음 번호로 더하고 검증은 부르지 않는다', async () => {
    const out = await turn(deps(docs, context, { readOriginal: read }), '출장 숙박비 하루', '2025-06-01');
    expect(read).toHaveBeenCalledWith('orig/r.hwpx', 'r.hwpx');
    expect(out.chunks?.map((c) => [c.documentId, c.n])).toEqual([[NEW, 1], [RET, 2]]);
    const past = out.chunks![1];
    expect(past).toMatchObject({ text: '제5조(숙박비) 출장 숙박비는 하루 6만원으로 한다.', effectiveFrom: '2025-01-01' });
    expect(past.section).toContain('지난 판 · 2025-06-01에 시행 중이던 판');
    expect(out.systemAddendum).toContain(pastContextHead('2025-06-01'));
    expect(out.systemAddendum).toContain('[2] 여비 규정(2025)');
    expect(out.systemAddendum).toContain("'지난 판' 근거가 그날의 판");
    expect(out.verifySources).toEqual([]);
  });
  it('기준일이 없거나 오늘 뒤면 지난 판을 읽지 않는다', async () => {
    read.mockClear();
    await turn(deps(docs, context, { readOriginal: read }), '출장 숙박비 하루');
    await turn(deps(docs, context, { readOriginal: read }), '출장 숙박비 하루', '2099-01-01');
    expect(read).not.toHaveBeenCalled();
    expect('2025-06-01' < kstToday()).toBe(true);
  });
  it('원본을 못 읽으면 지금 판 근거만(검증 근거도 예전처럼)', async () => {
    const out = await turn(deps(docs, context, { readOriginal: async () => ({ ok: false }) }), '출장 숙박비 하루', '2025-06-01');
    expect(out.chunks?.map((c) => c.documentId)).toEqual([NEW]);
    expect(out.verifySources).toEqual([{ doc_id: 'x', chunk_id: 'a' }]);
  });
});

describe('저장·화면', () => {
  it('답변 행에 basis_date — 두 행의 칸 집합은 같다', () => {
    const rows = buildMessageRows({ conversationId: 'c', userId: 'u', userContent: 'q', assistantText: 'a', chunks: [], links: [], files: [], attachments: [], agentVersion: 1, documentsSkipped: false, basisDate: '2025-06-01' } as never);
    const [user, assistant] = rows as Array<{ source_references: Record<string, unknown> }>;
    expect(assistant.source_references.basis_date).toBe('2025-06-01');
    expect(user.source_references.basis_date).toBeUndefined();
    expect(Object.keys(user).sort()).toEqual(Object.keys(assistant).sort());
  });
  it('요청을 받고·보내고·말풍선에 보인다', () => {
    expect(readFileSync('src/lib/assistant/prepare.ts', 'utf8')).toContain('const basisParsed = parseChatBasisDate(body.basis_date);');
    const chat = readFileSync('src/components/chat/ChatInterface.tsx', 'utf8');
    expect(chat).toContain("basis_date: !skipDocuments && req.basisDate ? req.basisDate : undefined,");
    expect(chat).toContain('aria-label="적용 기준일"');
    expect(readFileSync('src/components/chat/MessageBubble.tsx', 'utf8')).toContain('{basisDateNote(basisDate)}');
    expect(readFileSync('src/lib/capabilities/doc-search.ts', 'utf8')).toContain(".select('id, title, file_name, noda_status, replaces_id, effective_from, tags, storage_path')");
  });
});
