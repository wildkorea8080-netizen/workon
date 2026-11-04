import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/** 배치 문서 찾기 평가(0054) — 세트 읽기·판정·요약·비교·CSV와 관리자 라우트(DB·NODA는 가짜) */

const AGENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const RUN = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const state = vi.hoisted(() => ({
  admin: true,
  agent: null as Record<string, unknown> | null,
  search: vi.fn(),
  inserted: [] as unknown[],
  filters: [] as unknown[][],
  row: null as unknown,
  logs: [] as unknown[],
}));
vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => ({ user: { id: 'u1' } }), isAdminSession: () => state.admin }));
vi.mock('@/lib/actor-scope', () => ({ getActorScope: async () => ({ userId: 'u1', departmentId: 'd1', organizationId: 'o1', managedDepartmentIds: ['d1'] }) }));
vi.mock('@/lib/agent-store', () => ({ loadAgentAccess: async () => state.agent }));
vi.mock('@/lib/capabilities/doc-search', () => ({ searchAgentDocuments: (...a: unknown[]) => state.search(...a) }));
vi.mock('@/lib/logger', () => ({ logSystem: async (e: unknown) => { state.logs.push(e); } }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from() {
      const q: Record<string, unknown> = {};
      q.insert = (v: unknown) => { state.inserted.push(v); return q; };
      for (const m of ['select', 'order', 'limit']) q[m] = () => q;
      q.eq = (...a: unknown[]) => { state.filters.push(a); return q; };
      q.single = async () => ({ data: { id: RUN, ...(state.inserted.at(-1) as object) }, error: null });
      q.maybeSingle = async () => ({ data: state.row, error: null });
      q.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
      return q;
    },
  },
}));

import { NodaError } from '@/lib/noda';
import {
  compareRagEvalRuns, matchesExpected, parseRagEvalSet, ragEvalCsv, scoreRagEvalRow, summarizeRagEval, titleKey,
  type RagEvalResult, type RagEvalRow,
} from '@/lib/rag-eval';
import { GET, POST } from '@/app/api/admin/rag-eval/route';

const row = (over: Partial<RagEvalRow> = {}): RagEvalRow => ({ line: 1, question: '출장 일비는?', expected: '여비 규정', page: null, ...over });
const chunk = (title: string, page: number | null = null, similarity = 0.85) => ({ documentTitle: title, page, similarity });

describe('세트 읽기', () => {
  it('엑셀 탭·CSV 쉼표 모두, 첫 줄 머리글은 건너뛰고 기대 문서를 비우면 엉뚱한 질문', () => {
    const tab = parseRagEvalSet('질문\t기대 문서\t기대 쪽\n출장 일비는?\t여비 규정\t12\n점심 메뉴\t\t');
    expect(tab).toEqual({ ok: true, rows: [{ line: 2, question: '출장 일비는?', expected: '여비 규정', page: 12 }, { line: 3, question: '점심 메뉴', expected: null, page: null }] });
    const csv = parseRagEvalSet('"연가, 언제 내나요?",복무 규정,p.3\n반차는?,복무 규정,4쪽');
    expect(csv).toMatchObject({ ok: true, rows: [{ line: 1, question: '연가, 언제 내나요?', page: 3 }, { line: 2, page: 4 }] });
  });
  it('잘못된 줄은 줄 번호와 함께 모두 알리고, 50개를 넘으면 거절', () => {
    const bad = parseRagEvalSet('\t여비\n질문만\t\t12\n좋은 질문\t문서\t열두쪽');
    expect(bad).toEqual({ ok: false, errors: ['1번째 줄: 질문이 비었습니다.', '2번째 줄: 기대 쪽을 적으려면 기대 문서도 적어 주세요.', '3번째 줄: 기대 쪽은 숫자로 적어 주세요(예: 12).'] });
    expect(parseRagEvalSet(Array.from({ length: 51 }, (_, i) => `질문 ${i}\t문서`).join('\n'))).toMatchObject({ ok: false, errors: [expect.stringContaining('50개까지')] });
    expect(parseRagEvalSet('  ')).toMatchObject({ ok: false });
    expect(parseRagEvalSet(`${'ㄱ'.repeat(501)}\t문서`)).toMatchObject({ ok: false });
  });
  it('보이지 않는 글자·줄 안 공백은 다듬는다', () => {
    expect(parseRagEvalSet('출장​  일비\t여비‮ 규정')).toMatchObject({ ok: true, rows: [{ question: '출장 일비', expected: '여비 규정' }] });
  });
});

describe('판정', () => {
  it('문서 이름은 확장자·공백·대소문자를 무시하고 일부만 적어도 맞는다', () => {
    expect(titleKey(' 공무원 여비 규정.HWP ')).toBe('공무원여비규정');
    expect(matchesExpected('공무원 여비 규정(2026).pdf', '여비규정')).toBe(true);
    expect(matchesExpected('복무 규정.pdf', '여비')).toBe(false);
    expect(matchesExpected('아무 문서', '  ')).toBe(false);
  });
  it('찾음(순위·쪽)·다른 문서만·근거 없음·걸러짐·엉뚱한 근거·찾기 실패', () => {
    const chunks = [chunk('복무 규정.pdf', 3, 0.83), chunk('여비 규정.pdf', 11, 0.9), chunk('여비 규정.pdf', 12, 0.86), chunk('행동강령.pdf'), chunk('기타.pdf')];
    expect(scoreRagEvalRow(row({ page: 12 }), chunks)).toMatchObject({ verdict: 'hit', rank: 2, pageMatch: true, chunkCount: 5, topSimilarity: 0.9, topDocuments: ['복무 규정.pdf', '여비 규정.pdf', '행동강령.pdf'] });
    expect(scoreRagEvalRow(row({ page: 40 }), chunks).pageMatch).toBe(false);
    expect(scoreRagEvalRow(row({ expected: '계약 규정', page: 5 }), chunks)).toMatchObject({ verdict: 'miss', rank: null, pageMatch: false });
    expect(scoreRagEvalRow(row(), [])).toMatchObject({ verdict: 'no_evidence', topSimilarity: null });
    expect(scoreRagEvalRow(row({ expected: null }), [])).toMatchObject({ verdict: 'correct_empty' });
    expect(scoreRagEvalRow(row({ expected: null }), chunks)).toMatchObject({ verdict: 'false_evidence' });
    expect(scoreRagEvalRow(row(), null)).toMatchObject({ verdict: 'error', chunkCount: 0 });
  });
  it('요약 — 찾기 실패는 비율에서 빼고, 평균 역순위는 못 찾으면 0', () => {
    const results = [
      scoreRagEvalRow(row({ line: 1, page: 12 }), [chunk('여비 규정', 12)]),
      scoreRagEvalRow(row({ line: 2 }), [chunk('복무'), chunk('여비 규정')]),
      scoreRagEvalRow(row({ line: 3 }), []),
      scoreRagEvalRow(row({ line: 4, expected: null }), []),
      scoreRagEvalRow(row({ line: 5, expected: null }), [chunk('여비')]),
      scoreRagEvalRow(row({ line: 6 }), null),
    ];
    expect(summarizeRagEval(results)).toEqual({
      questions: 6, expected: 3, hits: 2, hitRate: 0.667, withPage: 1, pageHits: 1, pageHitRate: 1, mrr: 0.5,
      offTopic: 2, offTopicRejected: 1, offTopicRejectRate: 0.5, errors: 1,
      counts: { hit: 2, miss: 0, no_evidence: 1, correct_empty: 1, false_evidence: 1, error: 1 },
    });
    expect(summarizeRagEval([])).toMatchObject({ hitRate: null, mrr: null, offTopicRejectRate: null });
  });
  it('비교 — 같은 질문끼리 맞음↔틀림이 바뀐 것, 찾기 실패는 비교하지 않음', () => {
    const r = (q: string, verdict: RagEvalResult['verdict']) => ({ ...scoreRagEvalRow(row({ question: q }), []), verdict });
    const out = compareRagEvalRuns([r('A', 'miss'), r('B', 'hit'), r('C', 'error'), r('D', 'hit')], [r('a ', 'hit'), r('B', 'no_evidence'), r('C', 'miss'), r('D', 'hit'), r('E', 'hit')]);
    expect(out.improved.map((x) => x.question)).toEqual(['a ']);
    expect(out.regressed.map((x) => x.question)).toEqual(['B']);
    expect(out.unmatched).toBe(1);
  });
  it('CSV는 BOM·한국어 판정, 수식으로 읽힐 칸은 글자로', () => {
    const csv = ragEvalCsv([scoreRagEvalRow(row({ question: '=HYPERLINK("x")', page: 12 }), [chunk('여비 규정', 12)])]);
    expect(csv.startsWith('﻿줄,질문')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain(',찾음,1,예,1,0.850,여비 규정');
  });
});

const post = (body: unknown) => POST(new NextRequest('http://x/api/admin/rag-eval', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }));
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

describe('라우트', () => {
  beforeEach(() => {
    Object.assign(state, { admin: true, agent: { id: AGENT, organization_id: 'o1', department_id: 'd1', tier: 'department', version: 7, deleted_at: null }, inserted: [], filters: [], row: null, logs: [] });
    state.search.mockReset();
    state.search.mockImplementation(async ({ query }: { query: string }) => ({ chunks: query.includes('점심') ? [] : [chunk('여비 규정.pdf', 12)], dropped: 0 }));
  });
  it('질문마다 대화와 같은 찾기로 판정해 기관·비서·판과 함께 저장한다', async () => {
    const out = await json(await post({ agentId: AGENT, set: '출장 일비는?\t여비\t12\n점심 메뉴\t\t' }));
    expect(out.status).toBe(200);
    expect(state.search).toHaveBeenCalledTimes(2);
    expect(state.search).toHaveBeenCalledWith({ agentId: AGENT, query: '출장 일비는?', organizationId: 'o1' });
    expect(state.inserted[0]).toMatchObject({ organization_id: 'o1', agent_id: AGENT, agent_version: 7, created_by: 'u1', question_count: 2, status: 'done', summary: { hits: 1, offTopicRejected: 1 } });
    expect(JSON.stringify(state.inserted[0])).not.toContain('"text"');
  });
  it('한 질문의 NODA 실패는 그 질문만 찾기 실패(partial), 모두 실패면 저장하지 않고 503', async () => {
    state.search.mockImplementationOnce(async () => { throw new NodaError('HTTP 503', 'http', 503); });
    await post({ agentId: AGENT, set: '가\t여비\n나\t여비' });
    expect(state.inserted[0]).toMatchObject({ status: 'partial', summary: { errors: 1 } });
    state.inserted = [];
    state.search.mockImplementation(async () => { throw new NodaError('HTTP 503', 'http', 503); });
    expect((await post({ agentId: AGENT, set: '가\t여비\n나\t여비' })).status).toBe(503);
    expect(state.inserted).toEqual([]);
    expect(state.logs).toHaveLength(1);
  });
  it('관리자만, 다른 기관·관리 밖 부서 비서는 없는 것처럼 404, 세트 오류는 400(찾기 전에)', async () => {
    state.admin = false;
    expect((await post({ agentId: AGENT, set: '가\t여비' })).status).toBe(403);
    state.admin = true;
    state.agent = { ...state.agent, organization_id: 'o2' };
    expect((await post({ agentId: AGENT, set: '가\t여비' })).status).toBe(404);
    state.agent = { ...state.agent, organization_id: 'o1', department_id: 'd9' };
    expect((await post({ agentId: AGENT, set: '가\t여비' })).status).toBe(404);
    state.agent = { ...state.agent, tier: 'official' };
    expect((await post({ agentId: AGENT, set: '가\t여비' })).status).toBe(200);
    expect((await post({ agentId: 'not-a-uuid', set: '가\t여비' })).status).toBe(404);
    const bad = await json(await post({ agentId: AGENT, set: '\t여비' }));
    expect(bad).toMatchObject({ status: 400, body: { error: { details: { errors: ['1번째 줄: 질문이 비었습니다.'] } } } });
    expect(state.search).toHaveBeenCalledTimes(1);
  });
  it('기록 하나는 기관으로 거르고 그 비서도 지금 볼 수 있어야 한다', async () => {
    state.row = { id: RUN, agent_id: AGENT, results: [] };
    const ok = await GET(new NextRequest(`http://x/api/admin/rag-eval?id=${RUN}`));
    expect(ok.status).toBe(200);
    expect(state.filters).toContainEqual(['organization_id', 'o1']);
    state.agent = { ...state.agent, department_id: 'd9' };
    expect((await GET(new NextRequest(`http://x/api/admin/rag-eval?id=${RUN}`))).status).toBe(404);
    expect((await GET(new NextRequest('http://x/api/admin/rag-eval?id=nope'))).status).toBe(404);
  });
  it('마이그레이션 — 추가만, RLS 켜고 권한 없음, 질문 1~50', () => {
    const sql = readFileSync('supabase/migrations/0054_rag_eval_runs.sql', 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.rag_eval_runs');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('REVOKE ALL ON public.rag_eval_runs FROM anon, authenticated');
    expect(sql).toContain('question_count BETWEEN 1 AND 50');
  });
});
