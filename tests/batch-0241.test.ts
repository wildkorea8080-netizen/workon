import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { chooseDefaultAgent, DEFAULT_AGENT_UNREAD } from '@/lib/chat-default-agent';
import type { Agent } from '@/lib/db';

/**
 * 2026-11-21 — AI 대화 첫 화면이 답할 비서를 정할 목록을 못 읽은 것을 '없음'으로 보지 않는다.
 * 첫 화면은 공식·부서 비서, 나만의 비서, 마지막 대화 셋을 읽어 '마지막으로 쓴 비서 → 첫 공식 비서'로 답할 비서를 정한다.
 * 예전엔 못 읽은 목록을 빈 목록으로 보아, 마지막 대화나 나만의 비서 목록을 못 읽으면 직원이 마지막으로 쓴 비서가 아니라
 * 첫 공식 비서를 골랐고, 업무 홈 '바로 묻기'로 넘긴 질문이 직원이 고르지 않은 비서에게 곧바로 갔다(비서마다 문서·기능이 다르다).
 * 이제 하나라도 못 읽으면 고르지 않고 질문을 입력창에 남기며 까닭을 보인다.
 * 같은 화면에서: 적어 둔 질문이 있을 때 아래 비서를 고르면 그 비서에게 보낸다 — 안내는 '다른 비서에게 물으려면 아래에서 고르세요'인데
 * 예전엔 고르는 순간 적은 글이 버려졌다(못 읽어 비서를 못 정했을 때 입력창에 남긴 질문도 함께 버려졌다).
 */

const agent = (id: string, extra: Partial<Agent> = {}) => ({ id, name: id, is_active: true, tier: 'official', agent_type: 'chat', ...extra }) as Agent;

describe('chooseDefaultAgent', () => {
  it('셋 다 읽었으면 마지막으로 쓴 비서', () => {
    const r = chooseDefaultAgent([agent('first')], [agent('mine', { tier: 'personal' })], [{ agent: { id: 'mine' } }]);
    expect(r).toEqual({ agent: expect.objectContaining({ id: 'mine' }), unread: false });
  });
  it('배열로 온 비서(내장 관계)도 읽는다', () => {
    expect(chooseDefaultAgent([agent('first'), agent('b')], [], [{ agent: [{ id: 'b' }] }]).agent?.id).toBe('b');
  });
  it('지난 대화가 없으면 첫 공식 비서', () => {
    expect(chooseDefaultAgent([agent('first')], [], []).agent?.id).toBe('first');
  });
  it('마지막 대화를 못 읽으면 고르지 않는다(예전엔 첫 공식 비서)', () => {
    expect(chooseDefaultAgent([agent('first')], [agent('mine', { tier: 'personal' })], null)).toEqual({ agent: null, unread: true });
  });
  it('나만의 비서 목록을 못 읽으면 고르지 않는다(마지막 비서가 거기 있을 수 있다)', () => {
    expect(chooseDefaultAgent([agent('first')], null, [{ agent: { id: 'mine' } }])).toEqual({ agent: null, unread: true });
  });
  it('공식·부서 비서 목록을 못 읽어도 고르지 않는다', () => {
    expect(chooseDefaultAgent(null, [agent('mine', { tier: 'personal' })], []).unread).toBe(true);
  });
  it('비서가 정말 없으면 못 읽음이 아니다', () => {
    expect(chooseDefaultAgent([], [], [])).toEqual({ agent: null, unread: false });
  });
});

describe('첫 화면 (원본)', () => {
  const home = readFileSync('src/components/chat/ChatHome.tsx', 'utf8').replace(/\r\n/g, '\n');

  it('목록 읽기 실패를 빈 목록이 아니라 null로', () => {
    expect(home).not.toContain('.catch(() => [])');
    expect(home).toContain("const read = (url: string) => fetchOkJson<{ data: unknown }>(url).then((b) => (b && Array.isArray(b.data) ? b.data : null));");
    expect(home).toContain('setDefaultUnread(chosen.unread);');
  });
  it('못 정했으면 까닭을 보인다', () => {
    expect(home).toContain('{defaultUnread ? DEFAULT_AGENT_UNREAD :');
    expect(home).toContain('defaultUnread={defaultUnread && !lastAgentRef.current}');
    expect(DEFAULT_AGENT_UNREAD).toContain('정하지 못했습니다');
  });
  it('비서를 고르면 적어 둔 질문을 그 비서에게 보낸다', () => {
    const select = home.slice(home.indexOf('const handleAgentSelect = useCallback('), home.indexOf('const handleConversationSelect'));
    expect(select).toContain('setInitialMessage(quickInputRef.current.trim() || null);');
    expect(select).not.toContain('setInitialMessage(null);');
    expect(select).toContain("setQuickInput('');");
    expect(home).toContain('quickInputRef.current = quickInput;');
  });
});
