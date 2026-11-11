import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import pg from 'pg';

/** 답변 평가(2026-11-05, 0064) — 대화 주인만, 정해 둔 이유만, 관리자는 비서별 숫자만 */

const state = vi.hoisted(() => ({
  session: { user: { id: 'me', role: 'USER' } } as unknown,
  admin: false,
  results: {} as Record<string, { data?: unknown; error?: { message: string } | null; count?: number | null }[]>,
  calls: [] as unknown[][],
}));
vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => state.session, isAdminSession: () => state.admin }));
vi.mock('@/lib/actor-scope', () => ({
  getActorScope: async () => ({ userId: 'me', isAdmin: state.admin, organizationId: 'org', departmentId: 'dept', visibleDepartmentIds: ['dept'], managedDepartmentIds: ['dept', 'sub'], managesWholeOrganization: false }),
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'gte', 'lt', 'order', 'range', 'delete', 'upsert']) q[m] = (...args: unknown[]) => { state.calls.push([table, m, ...args]); return q; };
      const next = () => Promise.resolve({ data: null, error: null, ...(state.results[table]?.shift() ?? {}) });
      q.maybeSingle = () => next();
      q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => next().then(resolve, reject);
      return q;
    },
  },
}));

import { NextRequest } from 'next/server';
import { parseFeedback, summarizeFeedback } from '@/lib/message-feedback-spec';
import { feedbackPeriod, loadFeedbackSummary, saveMessageFeedback } from '@/lib/message-feedback';
import { PUT as putFeedback } from '@/app/api/messages/[id]/feedback/route';
import { GET as getSummary } from '@/app/api/admin/feedback-summary/route';
import AnswerFeedback from '@/components/chat/AnswerFeedback';
import { FeedbackSummaryTable } from '@/components/admin/FeedbackSummary';

const MSG = '33333333-0000-4000-8000-00000000000a';
const actor = { userId: 'me', organizationId: 'org' };

beforeEach(() => { state.session = { user: { id: 'me', role: 'USER' } }; state.admin = false; state.results = {}; state.calls = []; });

describe('평가 값', () => {
  it('도움됨·아쉬움(+정해 둔 이유)·지우기만 받는다', () => {
    expect(parseFeedback({ rating: 'up' })).toEqual({ rating: 'up', reason: null });
    expect(parseFeedback({ rating: 'down', reason: 'no_evidence' })).toEqual({ rating: 'down', reason: 'no_evidence' });
    expect(parseFeedback({ rating: 'down' })).toEqual({ rating: 'down', reason: null });
    expect(parseFeedback({ rating: null })).toEqual({ rating: null });
    for (const bad of [null, [], {}, { rating: 'meh' }, { rating: 'up', reason: 'wrong' }, { rating: 'down', reason: '자유 글' }, { rating: null, reason: 'wrong' }]) expect(parseFeedback(bad)).toBeNull();
  });
});

describe('요약', () => {
  it('비서별로 세고, 나만의 비서는 이름 없이·지운 비서·비서 없음은 따로, 많은 순', () => {
    const agents = new Map([['a1', { name: '여비 도우미', personal: false }], ['p1', { name: '홍길동의 비서', personal: true }], ['p2', { name: '다른 개인', personal: true }]]);
    const s = summarizeFeedback([
      { agent_id: 'a1', rating: 'up', reason: null }, { agent_id: 'a1', rating: 'down', reason: 'wrong' }, { agent_id: 'a1', rating: 'up', reason: null },
      { agent_id: 'p1', rating: 'down', reason: 'format' }, { agent_id: 'p2', rating: 'up', reason: null },
      { agent_id: 'gone', rating: 'down', reason: 'other' }, { agent_id: null, rating: 'up', reason: null }, { agent_id: 'a1', rating: 'weird', reason: null },
    ], agents);
    expect(s.total).toEqual({ up: 4, down: 3, helpfulPercent: 57.1, savedMinutes: 0, savedReports: 0 });
    expect(s.agents.map((a) => [a.agentName, a.up, a.down, a.helpfulPercent])).toEqual([
      ['여비 도우미', 2, 1, 66.7], ['나만의 비서', 1, 1, 50], ['비서 없음', 1, 0, 100], ['지운 비서', 0, 1, 0],
    ]);
    expect(s.agents[0].reasons.wrong).toBe(1);
    expect(JSON.stringify(s)).not.toContain('홍길동');
  });

  it('기간 — 기본 최근 30일(KST), 끝 날 포함, 꼴·순서·1년 상한', () => {
    expect(feedbackPeriod(null, null, new Date('2026-11-05T16:00:00Z'))).toEqual({ from: '2026-10-08', to: '2026-11-06', fromIso: '2026-10-08T00:00:00+09:00', toIso: '2026-11-07T00:00:00+09:00' });
    expect(feedbackPeriod('2026-11-01', '2026-11-05')?.toIso).toBe('2026-11-06T00:00:00+09:00');
    expect(feedbackPeriod('2026-11-05', '2026-11-01')).toBeNull();
    expect(feedbackPeriod('2026-02-30', '2026-03-01')).toBeNull();
    expect(feedbackPeriod('2025-01-01', '2026-11-05')).toBeNull();
  });

  it('관리 범위·기간으로 읽고 비서 이름은 같은 기관에서만', async () => {
    state.results.message_feedback = [{ data: [{ message_id: 'm1', agent_id: 'a1', rating: 'up', reason: null }], count: 1 }];
    state.results.agents = [{ data: [{ id: 'a1', name: '여비 도우미', tier: 'official' }] }];
    const s = await loadFeedbackSummary({ organizationId: 'org', departmentIds: ['dept'] }, { fromIso: 'F', toIso: 'T' });
    expect(s.agents[0]).toMatchObject({ agentName: '여비 도우미', up: 1 });
    expect(state.calls).toContainEqual(['message_feedback', 'eq', 'organization_id', 'org']);
    expect(state.calls).toContainEqual(['message_feedback', 'in', 'department_id', ['dept']]);
    expect(state.calls).toContainEqual(['message_feedback', 'gte', 'updated_at', 'F']);
    expect(state.calls).toContainEqual(['agents', 'eq', 'organization_id', 'org']);
  });
});

describe('저장', () => {
  it('내 대화의 답변이면 덮어쓰기로 저장(판·부서·기관 함께), 지우기는 내 것만', async () => {
    state.results.messages = [{ data: { id: MSG, role: 'assistant', conversation_id: 'c1', agent_version: 4 } }, { data: { id: MSG, role: 'assistant', conversation_id: 'c1', agent_version: 4 } }];
    state.results.conversations = [{ data: { id: 'c1', agent_id: 'a1', department_id: 'dept' } }, { data: { id: 'c1', agent_id: 'a1', department_id: 'dept' } }];
    expect(await saveMessageFeedback(actor, MSG.toUpperCase(), { rating: 'down', reason: 'wrong' })).toEqual({ ok: true, feedback: { rating: 'down', reason: 'wrong' } });
    const upsert = state.calls.find((c) => c[0] === 'message_feedback' && c[1] === 'upsert');
    expect(upsert?.[2]).toMatchObject({ message_id: MSG, conversation_id: 'c1', user_id: 'me', agent_id: 'a1', department_id: 'dept', organization_id: 'org', agent_version: 4, rating: 'down', reason: 'wrong' });
    expect(upsert?.[3]).toEqual({ onConflict: 'message_id' });
    expect(state.calls).toContainEqual(['conversations', 'eq', 'user_id', 'me']);
    expect(await saveMessageFeedback(actor, MSG, { rating: null })).toEqual({ ok: true, feedback: null });
    expect(state.calls).toContainEqual(['message_feedback', 'eq', 'user_id', 'me']);
  });

  it('거절: 이상한 id·없는 메시지·사용자 질문 메시지·남의 대화 404, 조회 실패 503', async () => {
    expect(await saveMessageFeedback(actor, 'x', { rating: 'up', reason: null })).toMatchObject({ status: 404 });
    expect(await saveMessageFeedback(actor, MSG, { rating: 'up', reason: null })).toMatchObject({ status: 404 });
    state.results.messages = [{ data: { role: 'user', conversation_id: 'c1' } }];
    expect(await saveMessageFeedback(actor, MSG, { rating: 'up', reason: null })).toMatchObject({ status: 404 });
    state.results.messages = [{ data: { role: 'assistant', conversation_id: 'c1' } }];
    state.results.conversations = [{ data: null }];
    expect(await saveMessageFeedback(actor, MSG, { rating: 'up', reason: null })).toMatchObject({ status: 404 });
    state.results.messages = [{ error: { message: 'down' } }];
    expect(await saveMessageFeedback(actor, MSG, { rating: 'up', reason: null })).toMatchObject({ status: 503 });
    expect(state.calls.some((c) => c[0] === 'message_feedback')).toBe(false);
  });
});

describe('라우트', () => {
  const put = (body: unknown) => putFeedback(new NextRequest(`http://localhost/api/messages/${MSG}/feedback`, { method: 'PUT', body: JSON.stringify(body) }), { params: { id: MSG } });
  it('평가 — 로그인 없음 401, 꼴이 틀리면 400', async () => {
    state.session = null;
    expect((await put({ rating: 'up' })).status).toBe(401);
    state.session = { user: { id: 'me' } };
    expect((await put({ rating: 'down', reason: '자유 글' })).status).toBe(400);
  });

  it('요약 — 관리자만, 기간이 틀리면 400, 관리 범위로', async () => {
    expect((await getSummary(new NextRequest('http://localhost/api/admin/feedback-summary'))).status).toBe(403);
    state.admin = true;
    expect((await getSummary(new NextRequest('http://localhost/api/admin/feedback-summary?from=2026-11-05&to=2026-11-01'))).status).toBe(400);
    state.results.message_feedback = [{ data: [], count: 0 }];
    const res = await getSummary(new NextRequest('http://localhost/api/admin/feedback-summary?from=2026-11-01&to=2026-11-05'));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ from: '2026-11-01', to: '2026-11-05', agents: [] });
    expect(state.calls).toContainEqual(['message_feedback', 'in', 'department_id', ['dept', 'sub']]);
  });
});

describe('화면', () => {
  it('답변 아래 도움됨·아쉬움, 아쉬움이면 이유 단추', () => {
    const none = renderToStaticMarkup(createElement(AnswerFeedback, { messageId: MSG, initial: null }));
    expect(none).toContain('도움됨');
    expect(none).not.toContain('근거가 부족함');
    const down = renderToStaticMarkup(createElement(AnswerFeedback, { messageId: MSG, initial: { rating: 'down', reason: 'no_evidence' } }));
    expect(down).toContain('근거가 부족함');
    expect(down).toMatch(/aria-pressed="true"[^>]*>아쉬움/);
  });

  it('대화 화면이 저장된 답변 id(불러온 id·done의 message_id)로만 평가를 붙이고, 관리자 통계에 표', () => {
    const chat = readFileSync('src/components/chat/ChatInterface.tsx', 'utf8');
    expect(chat).toContain("if (bubbleShown && typeof payload.message_id === 'string') patchAssistant({ savedId: payload.message_id, feedback: null });");
    expect(chat).toContain('feedback: m.role === \'assistant\' ? (result.data.feedback?.[m.id] ?? null) : undefined');
    expect(readFileSync('src/app/api/conversations/[id]/route.ts', 'utf8')).toContain('loadConversationFeedback(session.user.id, conversationId)');
    expect(readFileSync('src/app/admin/stats/page.tsx', 'utf8')).toContain('<FeedbackSummary />');
    const table = renderToStaticMarkup(createElement(FeedbackSummaryTable, { data: { from: 'a', to: 'b', truncated: false, total: { up: 1, down: 1, helpfulPercent: 50, savedMinutes: 0, savedReports: 0 }, agents: [{ agentId: 'a1', agentName: '여비 도우미', up: 1, down: 1, helpfulPercent: 50, reasons: { wrong: 1, no_evidence: 0, incomplete: 0, format: 0, other: 0 }, savedMinutes: 0, savedReports: 0 }] } }));
    expect(table).toContain('여비 도우미');
    expect(table).toContain('50%');
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('답변 평가 표 (0064, 시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });

  it('다시 적용해도 안전, RLS 켜짐, 이유는 아쉬움에만·정해 둔 코드만', async () => {
    const sql = readFileSync('supabase/migrations/0064_message_feedback.sql', 'utf8');
    await db.query(sql);
    await db.query(sql);
    const rls = await db.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'message_feedback'");
    expect(rls.rows[0].relrowsecurity).toBe(true);
    const defs = (await db.query("SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.message_feedback'::regclass")).rows as { conname: string; def: string }[];
    expect(defs.find((d) => d.conname === 'message_feedback_reason_only_down')?.def).toContain("rating = 'down'");
    expect(defs.some((d) => d.def.includes("'no_evidence'"))).toBe(true);
  });
});
