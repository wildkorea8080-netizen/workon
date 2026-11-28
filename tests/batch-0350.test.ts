// tests/batch-0350.test.ts
// 대화의 '답변 다시 받기·질문 고쳐 묻기'(2026-11-28) — 같은 질문을 새로 적으면 이력에 같은 질문이 두 번 남고 모델도 앞 답을 본 채 답했다.
// 마지막 질문·답 두 행을 서버가 지운 뒤에만 다시 묻는다
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { decideLastTurn, LAST_TURN_MESSAGES } from '@/lib/last-turn';
import { canRegenerate } from '@/components/chat/redo-turn';
import { API_ROUTES } from '@/lib/api-route-ids';

const A = '11111111-1111-4111-8111-111111111111';
const Q = '22222222-2222-4222-8222-222222222222';
const answer = (refs: unknown = {}) => ({ id: A, role: 'assistant', source_references: refs });
const question = (refs: unknown = {}) => ({ id: Q, role: 'user', source_references: refs });

describe('마지막 턴 판정', () => {
  it('끝의 두 행이 [이 답, 그 질문]이면 둘을 지운다', () => {
    expect(decideLastTurn([answer(), question()], A)).toEqual({ ok: true, ids: [A, Q] });
  });
  it('다른 답이거나 그 사이 턴이 생겼거나 끝이 질문이면 409', () => {
    expect(decideLastTurn([answer(), question()], Q)).toMatchObject({ ok: false, status: 409, message: LAST_TURN_MESSAGES.notLast });
    expect(decideLastTurn([question(), answer()], A)).toMatchObject({ ok: false, status: 409 });
    expect(decideLastTurn([answer()], A)).toMatchObject({ ok: false, status: 409 });
    expect(decideLastTurn([], A)).toMatchObject({ ok: false, status: 409 });
  });
  it('입력형 앱 실행 결과는 지우지 않는다', () => {
    expect(decideLastTurn([answer({ app_steps: [] }), question()], A)).toMatchObject({ ok: false, status: 400, message: LAST_TURN_MESSAGES.app });
    expect(decideLastTurn([answer(), question({ app_inputs: { a: '1' } })], A)).toMatchObject({ ok: false, status: 400 });
    expect(decideLastTurn([answer({ app_draft: '2026-11-28T00:00:00Z' }), question()], A)).toMatchObject({ ok: false, status: 400 });
  });
  it('source_references가 비거나 이상해도 판정한다', () => {
    expect(decideLastTurn([{ id: A, role: 'assistant', source_references: null }, { id: Q, role: 'user', source_references: [] }], A)).toMatchObject({ ok: true });
  });
});

describe('다시 받을 수 있는 질문', () => {
  it('글 질문·파일 질문은 되고 사진 질문·빈 질문은 안 된다', () => {
    expect(canRegenerate({ content: '여비 기준은?' })).toBe(true);
    expect(canRegenerate({ content: '[첨부 파일: a.xlsx]\n합계 내 줘' })).toBe(true);
    expect(canRegenerate({ content: '이 사진은?', imagePreviews: ['blob:x'] })).toBe(false);
    expect(canRegenerate({ content: '[첨부 이미지 1장]\n이 사진은?' })).toBe(false);
    expect(canRegenerate({ content: '[첨부 파일: a.xlsx]' })).toBe(false);
  });
});

describe('라우트', () => {
  const src = readFileSync('src/app/api/conversations/[id]/last-turn/route.ts', 'utf8');
  it('대화 주인만·끝의 두 행을 답 먼저 읽고·그 대화의 두 행만 지운다', () => {
    expect(src).toMatch(/\.eq\('user_id', session\.user\.id\)/);
    expect(src).toMatch(/\.order\('created_at', \{ ascending: false \}\)\s*\.order\('role', \{ ascending: true \}\)\s*\.limit\(2\)/);
    expect(src).toMatch(/\.delete\(\)\s*\.in\('id', verdict\.ids\)\s*\.eq\('conversation_id', params\.id\)/);
    expect(src).not.toMatch(/usage_logs/);
  });
  it('읽기 실패는 503, 남의·없는 대화는 404', () => {
    expect(src).toMatch(/if \(convError\) return jsonError\(READ_FAILED, 503\)/);
    expect(src).toMatch(/if \(readError\) return jsonError\(READ_FAILED, 503\)/);
    expect(src).toMatch(/if \(!conversation\) return jsonError\('대화를 찾을 수 없습니다\.', 404\)/);
  });
  it('라우트 목록에 있다', () => {
    expect(API_ROUTES).toContain('conversations/[id]/last-turn');
  });
});

describe('화면', () => {
  const ui = readFileSync('src/components/chat/ChatInterface.tsx', 'utf8');
  it('서버가 지운 뒤에만 화면에서 빼고, 실패는 알린다', () => {
    const fn = ui.slice(ui.indexOf('const redoLastTurn'), ui.indexOf('const sendTurn'));
    expect(fn.indexOf("method: 'DELETE'")).toBeGreaterThan(0);
    expect(fn.indexOf('if (!r.ok)')).toBeLessThan(fn.indexOf('prev.slice(0, -2)'));
    expect(fn).toMatch(/setRedoError\(serverErrorText\(r\.body, REDO_FAILED\)\)/);
  });
  it('다시 받기는 같은 태그·기준일·일반 답변 여부로, 첨부는 다시 묶지 않는다', () => {
    const fn = ui.slice(ui.indexOf('const redoLastTurn'), ui.indexOf('const sendTurn'));
    expect(fn).toMatch(/docTags: last\.docTags \?\? \[\], basisDate: last\.basisDate \?\? ''/);
    expect(fn).toMatch(/attachmentIds: \[\]/);
    expect(fn).toMatch(/last\.documentsSkipped === true/);
  });
});
