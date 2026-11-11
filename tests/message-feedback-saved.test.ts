import { readFileSync } from 'fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FEEDBACK_SAVED_MINUTE_CHOICES, parseFeedback, summarizeFeedback } from '@/lib/message-feedback-spec';
import { FeedbackSummaryTable, savedLabel } from '@/components/admin/FeedbackSummary';
import AnswerFeedback from '@/components/chat/AnswerFeedback';

/** 답변 평가의 '줄인 시간'(2026-11-10, 0082) — '도움됨'일 때만 직원이 고르는 자기 신고(측정·추정 아님), 관리자 요약에 비서별 합 */

describe('값', () => {
  it("'도움됨'에만 1~480분 정수, 없으면 옛 꼴 그대로", () => {
    expect(parseFeedback({ rating: 'up', saved_minutes: 30 })).toEqual({ rating: 'up', reason: null, savedMinutes: 30 });
    expect(parseFeedback({ rating: 'up' })).toEqual({ rating: 'up', reason: null });
    expect(parseFeedback({ rating: 'up', saved_minutes: null })).toEqual({ rating: 'up', reason: null });
    for (const bad of [{ rating: 'up', saved_minutes: 0 }, { rating: 'up', saved_minutes: 481 }, { rating: 'up', saved_minutes: 1.5 }, { rating: 'up', saved_minutes: '30' },
      { rating: 'down', saved_minutes: 30 }, { rating: 'down', reason: 'wrong', saved_minutes: 30 }, { rating: null, saved_minutes: 30 }]) {
      expect(parseFeedback(bad)).toBeNull();
    }
  });
  it('화면 단추는 정해 둔 다섯(최대 반나절)', () => {
    expect(FEEDBACK_SAVED_MINUTE_CHOICES.map((c) => c.minutes)).toEqual([10, 30, 60, 120, 240]);
  });
});

describe('요약', () => {
  it('비서별·전체 합과 고른 답 수 — 도움됨의 값만, 이상한 값은 안 셈', () => {
    const s = summarizeFeedback([
      { agent_id: 'a1', rating: 'up', reason: null, saved_minutes: 30 }, { agent_id: 'a1', rating: 'up', reason: null, saved_minutes: 60 },
      { agent_id: 'a1', rating: 'up', reason: null, saved_minutes: null }, { agent_id: 'a1', rating: 'down', reason: 'wrong', saved_minutes: 120 },
      { agent_id: 'a2', rating: 'up', reason: null, saved_minutes: 9999 },
    ], new Map([['a1', { name: '여비 도우미', personal: false }], ['a2', { name: '보고서', personal: false }]]));
    expect(s.total).toMatchObject({ savedMinutes: 90, savedReports: 2 });
    expect(s.agents.find((a) => a.agentName === '여비 도우미')).toMatchObject({ savedMinutes: 90, savedReports: 2 });
    expect(s.agents.find((a) => a.agentName === '보고서')).toMatchObject({ savedMinutes: 0, savedReports: 0 });
  });
  it('관리자 표 — 합(시간)·자기 신고 안내, 고른 답이 없으면 줄 없음', () => {
    expect(savedLabel(40)).toBe('40분');
    expect(savedLabel(210)).toBe('3.5시간');
    const data = { from: 'a', to: 'b', truncated: false, total: { up: 2, down: 0, helpfulPercent: 100, savedMinutes: 90, savedReports: 2 },
      agents: [{ agentId: 'a1', agentName: '여비 도우미', up: 2, down: 0, helpfulPercent: 100, reasons: { wrong: 0, no_evidence: 0, incomplete: 0, format: 0, other: 0 }, savedMinutes: 90, savedReports: 2 }] };
    const html = renderToStaticMarkup(createElement(FeedbackSummaryTable, { data }));
    expect(html).toContain('1.5시간');
    expect(html).toContain('측정하거나 추정한 시간이 아닙니다');
    const none = renderToStaticMarkup(createElement(FeedbackSummaryTable, { data: { ...data, total: { ...data.total, savedMinutes: 0, savedReports: 0 } } }));
    expect(none).not.toContain('줄인 시간&rsquo; 합');
  });
});

describe('화면·연결', () => {
  it("'도움됨'을 고른 답에만 줄인 시간 단추", () => {
    expect(renderToStaticMarkup(createElement(AnswerFeedback, { messageId: 'm1', initial: { rating: 'up', reason: null, savedMinutes: 30 } }))).toContain('줄인 시간(선택)');
    expect(renderToStaticMarkup(createElement(AnswerFeedback, { messageId: 'm1', initial: { rating: 'down', reason: null } }))).not.toContain('줄인 시간');
  });
  it('저장은 도움됨일 때만 칸을 쓰고, 읽기·요약이 칸을 읽는다', () => {
    const lib = readFileSync('src/lib/message-feedback.ts', 'utf8');
    expect(lib).toContain("saved_minutes: input.rating === 'up' ? input.savedMinutes ?? null : null");
    expect(lib).toContain("select('message_id, rating, reason, saved_minutes')");
    expect(lib).toContain("select('message_id, agent_id, rating, reason, saved_minutes'");
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('0082 (시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('다시 적용해도 안전, 도움됨에만 1~480', async () => {
    const sql = readFileSync('supabase/migrations/0082_message_feedback_saved_minutes.sql', 'utf8');
    await db.query(sql);
    await db.query(sql);
    const def = (await db.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'message_feedback_saved_minutes_check'")).rows[0]?.def as string;
    expect(def).toContain("rating = 'up'");
    expect(def).toContain('480');
  });
});
