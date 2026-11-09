import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/** 사람 판정과 AI 채점 맞대기(2026-11-09) — 평가 뒤 관리자가 답마다 맞음·일부·틀림을 매겨 채점자를 잰다 */

const AGENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const RUN = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const state = vi.hoisted(() => ({
  admin: true,
  agent: null as Record<string, unknown> | null,
  row: null as Record<string, unknown> | null,
  updates: [] as Array<{ value: Record<string, unknown>; filters: unknown[][] }>,
  conflicts: 0,
}));
vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => ({ user: { id: 'u1' } }), isAdminSession: () => state.admin }));
vi.mock('@/lib/actor-scope', () => ({ getActorScope: async () => ({ userId: 'u1', departmentId: 'd1', organizationId: 'o1', managedDepartmentIds: ['d1'] }) }));
vi.mock('@/lib/agent-store', () => ({ loadAgentAccess: async () => state.agent }));
vi.mock('@/lib/capabilities/doc-search', () => ({ prepareLikeChat: async () => null }));
vi.mock('@/lib/logger', () => ({ logSystem: async () => {} }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from() {
      const filters: unknown[][] = [];
      let update: Record<string, unknown> | null = null;
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (...a: unknown[]) => { filters.push(['eq', ...a]); return q; };
      q.is = (...a: unknown[]) => { filters.push(['is', ...a]); return q; };
      q.update = (v: Record<string, unknown>) => { update = v; return q; };
      q.maybeSingle = async () => ({ data: state.row, error: null });
      q.then = (resolve: (v: unknown) => unknown) => {
        if (!update) return Promise.resolve({ data: [], error: null }).then(resolve);
        state.updates.push({ value: update, filters });
        if (state.conflicts > 0) {
          // 그 사이 다른 관리자가 매겼다 — 기록이 바뀌어 조건이 맞지 않는다
          state.conflicts--;
          state.row = { ...state.row!, summary: { ...(state.row!.summary as object), labelRevision: 7 } };
          return Promise.resolve({ data: [], error: null }).then(resolve);
        }
        state.row = { ...state.row!, ...update };
        return Promise.resolve({ data: [{ id: RUN, ...state.row }], error: null }).then(resolve);
      };
      return q;
    },
  },
}));

import { RAG_EVAL_JUDGE_LABELS, agreementNote, applyHumanLabel, isJudgeGrade, judgeAgreement, type RagEvalJudge, type RagEvalJudgeGrade } from '@/lib/rag-eval-judge';
import { summarizeAnswers } from '@/lib/rag-eval-answer';
import { ragEvalCsv, type RagEvalResult } from '@/lib/rag-eval';
import { PATCH } from '@/app/api/admin/rag-eval/route';
import { summaryLine } from '@/components/admin/RagEvalPanel';

const judge = (grade: RagEvalJudgeGrade): RagEvalJudge => ({ grade, faithful: true, reason: '이유' });
const human = (grade: RagEvalJudgeGrade) => ({ grade, at: '2026-11-09T05:00:00.000Z' });
const result = (line: number, over: Record<string, unknown> = {}): RagEvalResult => ({
  line, question: `질문 ${line}`, expected: '여비 규정', page: null, verdict: 'hit', rank: 1, pageMatch: null, chunkCount: 1, topSimilarity: 0.9, topDocuments: ['여비 규정'],
  answer: { verdict: 'grounded', passed: true, text: `답 ${line}`, cited: ['여비 규정'], unverifiedNumbers: [], costKrw: 1, ...over },
} as unknown as RagEvalResult);

describe('맞대기', () => {
  it('일치·후하게·짜게와 표 — AI 채점이 없는 답은 매겨도 맞대지 않는다', () => {
    const a = judgeAgreement([
      { judge: judge('correct'), human: human('correct') },
      { judge: judge('correct'), human: human('incorrect') }, // 후하게
      { judge: judge('partial'), human: human('correct') }, // 짜게
      { human: human('partial') },
      { judge: judge('incorrect') },
      undefined,
    ]);
    expect(a).toMatchObject({ labeled: 4, compared: 3, agree: 1, agreeRate: 0.333, lenient: 1, strict: 1 });
    expect(a!.matrix.incorrect.correct).toBe(1);
    expect(a!.matrix.correct.partial).toBe(1);
    expect(agreementNote(a!)).toBe('사람 판정 4개 · AI 채점 일치 1/3(33%) · AI가 후하게 본 답 1 · AI가 짜게 본 답 1');
    expect(judgeAgreement([{ judge: judge('correct') }])).toBeUndefined();
    expect(agreementNote(judgeAgreement([{ human: human('correct') }])!)).toBe('사람 판정 1개(AI 채점과 맞대 본 답 없음)');
    // 꼴이 틀린 저장 값은 세지 않는다
    expect(judgeAgreement([{ human: { grade: 'great' as never, at: 'x' } }])).toBeUndefined();
    expect(isJudgeGrade('partial')).toBe(true);
    expect(isJudgeGrade('great')).toBe(false);
  });

  it('한 줄에 매기고 지운다 — 입력은 그대로, 답이 없거나 오류인 질문은 거절', () => {
    const results = [result(1, { judge: judge('correct') }), result(2, { text: '', error: '답을 만들지 못했습니다.' }), { ...result(3), answer: undefined }];
    const set = applyHumanLabel(results, 1, 'partial', '2026-11-09T05:00:00.000Z');
    expect(set.ok && set.results[0].answer?.human).toEqual({ grade: 'partial', at: '2026-11-09T05:00:00.000Z' });
    expect(results[0].answer?.human).toBeUndefined();
    if (!set.ok) return;
    const cleared = applyHumanLabel(set.results, 1, null, 'x');
    expect(cleared.ok && cleared.results[0].answer).not.toHaveProperty('human');
    expect(cleared.ok && cleared.results[0].answer?.judge).toEqual(judge('correct'));
    expect(applyHumanLabel(results, 2, 'correct', 'x')).toMatchObject({ ok: false });
    expect(applyHumanLabel(results, 3, 'correct', 'x')).toMatchObject({ ok: false });
    expect(applyHumanLabel(results, 9, 'correct', 'x')).toMatchObject({ ok: false, message: expect.stringContaining('찾을 수 없습니다') });
  });

  it('요약·화면 한 줄·CSV — 사람 판정이 있을 때만', () => {
    const results = [result(1, { judge: judge('correct'), human: human('incorrect') }), result(2, { judge: judge('partial') })];
    const answers = summarizeAnswers(results);
    expect(answers?.agreement).toMatchObject({ labeled: 1, compared: 1, agree: 0, lenient: 1 });
    expect(summarizeAnswers([result(1, { judge: judge('correct') })])).not.toHaveProperty('agreement');
    const line = summaryLine({ hits: 2, expected: 2, hitRate: 1, withPage: 0, pageHits: 0, pageHitRate: null, mrr: 1, offTopic: 0, offTopicRejected: 0, offTopicRejectRate: null, errors: 0, searchScope: 'chat', answers } as never);
    expect(line).toContain('사람 판정 1개 · AI 채점 일치 0/1(0%) · AI가 후하게 본 답 1');
    const csv = ragEvalCsv(results);
    expect(csv.split('\n')[0]).toContain('사람 판정');
    expect(csv.split('\n')[1].endsWith(RAG_EVAL_JUDGE_LABELS.incorrect)).toBe(true);
    expect(ragEvalCsv([result(1)]).split('\n')[0]).not.toContain('사람 판정');
  });
});

describe('라우트 PATCH', () => {
  const patch = (body: unknown) => PATCH(new NextRequest('http://x/api/admin/rag-eval', { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
  beforeEach(() => {
    state.admin = true; state.updates = []; state.conflicts = 0;
    state.agent = { id: AGENT, organization_id: 'o1', tier: 'official', department_id: 'd1', deleted_at: null, version: 3 };
    state.row = { id: RUN, agent_id: AGENT, summary: { hits: 1, answers: { evaluated: 2 } }, results: [result(1, { judge: judge('correct') }), result(2)] };
  });

  it('매기면 결과와 요약의 맞대기를 다시 쓰고, 첫 저장은 판 번호가 없을 때만', async () => {
    const res = await patch({ id: RUN, line: 1, grade: 'incorrect' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.summary).toMatchObject({ hits: 1, labelRevision: 1, answers: { agreement: { labeled: 1, compared: 1, lenient: 1 } } });
    expect(body.data.results[0].answer.human.grade).toBe('incorrect');
    expect(state.updates[0].filters).toEqual(expect.arrayContaining([['eq', 'id', RUN], ['eq', 'organization_id', 'o1'], ['is', 'summary->labelRevision', null]]));
    // 두 번째 저장은 그 판 번호일 때만
    await patch({ id: RUN, line: 2, grade: 'correct' });
    expect(state.updates[1].filters).toEqual(expect.arrayContaining([['eq', 'summary->>labelRevision', '1']]));
    expect(state.row!.summary).toMatchObject({ labelRevision: 2, answers: { agreement: { labeled: 2, compared: 1 } } });
  });

  it('그 사이 다른 관리자가 매겼으면 다시 읽어 얹고, 계속 어긋나면 409', async () => {
    state.conflicts = 1;
    expect((await patch({ id: RUN, line: 1, grade: 'correct' })).status).toBe(200);
    expect(state.updates).toHaveLength(2);
    expect(state.updates[1].filters).toEqual(expect.arrayContaining([['eq', 'summary->>labelRevision', '7']]));
    state.conflicts = 5; state.updates = [];
    expect((await patch({ id: RUN, line: 1, grade: 'partial' })).status).toBe(409);
    expect(state.updates).toHaveLength(3);
  });

  it('관리자만·꼴·없는 기록·볼 수 없는 비서·답 없는 질문', async () => {
    state.admin = false;
    expect((await patch({ id: RUN, line: 1, grade: 'correct' })).status).toBe(403);
    state.admin = true;
    expect((await patch({ id: 'x', line: 1, grade: 'correct' })).status).toBe(400);
    expect((await patch({ id: RUN, line: 0, grade: 'correct' })).status).toBe(400);
    expect((await patch({ id: RUN, line: 1, grade: 'great' })).status).toBe(400);
    expect((await patch({ id: RUN, line: 9, grade: 'correct' })).status).toBe(400);
    state.agent = { ...state.agent!, organization_id: 'o2' };
    expect((await patch({ id: RUN, line: 1, grade: 'correct' })).status).toBe(404);
    state.row = null;
    expect((await patch({ id: RUN, line: 1, grade: 'correct' })).status).toBe(404);
    expect(state.updates).toHaveLength(0);
  });

  it('지우기(null)도 받는다', async () => {
    await patch({ id: RUN, line: 1, grade: 'correct' });
    const res = await patch({ id: RUN, line: 1, grade: null });
    expect(res.status).toBe(200);
    expect((await res.json()).data.summary.answers).not.toHaveProperty('agreement');
  });
});

describe('화면', () => {
  it('판정 고르기와 안내 — 패널 원본', () => {
    const src = readFileSync('src/components/admin/RagEvalPanel.tsx', 'utf8');
    expect(src).toContain("method: 'PATCH'");
    expect(src).toContain('사람 판정');
    expect(src).toContain('AI 채점과 다름');
    // 화면용 모듈이 서버 모듈을 가져오지 않는다
    expect(readFileSync('src/lib/rag-eval-judge.ts', 'utf8')).not.toMatch(/^import /m);
    expect(renderToStaticMarkup(createElement('div', null, summaryLine({ hits: 0, expected: 0, hitRate: null, withPage: 0, pageHits: 0, pageHitRate: null, mrr: null, offTopic: 0, offTopicRejected: 0, offTopicRejectRate: null, errors: 0, searchScope: 'chat' } as never)))).not.toContain('사람 판정');
  });
});
