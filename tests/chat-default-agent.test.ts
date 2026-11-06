import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { chatAgentChoices, pickDefaultAgent } from '@/lib/chat-default-agent';
import type { Agent } from '@/lib/db';

/**
 * AI 대화 첫 화면에서 비서 없이 바로 묻기(2026-11-06) — 전에는 입력창에 적고 보내면 화면만 바뀌고 적은 글이 버려졌고,
 * 비서를 먼저 고르기 전에는 보낼 수도 없었다(알리웍스·웍스AI는 바로 묻는다)
 */
const agent = (id: string, extra: Partial<Agent> = {}) => ({ id, name: id, is_active: true, tier: 'official', agent_type: 'chat', ...extra }) as Agent;

describe('답할 비서 고르기', () => {
  it('쓸 수 있는 대화 비서만 — 꺼짐·지움·링크형·입력형 앱·겹침은 뺀다', () => {
    const rows = [agent('a'), agent('off', { is_active: false }), agent('gone', { deleted_at: '2026-11-01' }), agent('link', { agent_type: 'link' }), agent('app', { app_definition: {} as Agent['app_definition'] }), agent('a')];
    expect(chatAgentChoices(rows).map((a) => a.id)).toEqual(['a']);
  });

  it('마지막으로 대화한 비서(지금도 쓸 수 있을 때) → 첫 공식 비서 → 첫 비서', () => {
    const rows = [agent('mine', { tier: 'personal' }), agent('first'), agent('second')];
    expect(pickDefaultAgent(rows, 'second')?.id).toBe('second');
    expect(pickDefaultAgent(rows, 'removed')?.id).toBe('first');
    expect(pickDefaultAgent(rows, null)?.id).toBe('first');
    expect(pickDefaultAgent([agent('mine', { tier: 'personal' })], null)?.id).toBe('mine');
    expect(pickDefaultAgent([], 'x')).toBeNull();
    // 마지막 비서가 이제 링크형이면 고르지 않는다
    expect(pickDefaultAgent([agent('first'), agent('l', { agent_type: 'link' })], 'l')?.id).toBe('first');
  });
});

describe('첫 화면 질문이 버려지지 않는다', () => {
  const home = readFileSync('src/components/chat/ChatHome.tsx', 'utf8');
  const chat = readFileSync('src/components/chat/ChatInterface.tsx', 'utf8');
  it('바로 묻기는 적은 질문을 대화 화면에 넘기고, 대화 화면이 열리며 한 번 보낸다', () => {
    expect(home).toContain('setInitialMessage(text);');
    expect(home).toContain('initialMessage={initialMessage}');
    expect(home).not.toContain('자동 전송 불가능하므로 clear');
    expect(chat).toMatch(/initialSentRef\.current = true;[\s\S]*setAutoSend\(true\)/);
    expect(chat).toMatch(/if \(initialSentRef\.current \|\| !initialMessage\?\.trim\(\) \|\| conversationId\) return;/);
  });
  it('답할 비서를 보인다 — 몰래 고르지 않는다', () => {
    expect(home).toContain('답할 비서: <span');
    expect(home).toContain("pickDefaultAgent([...shared, ...personal] as Agent[], lastId)");
  });
  it('대화 목록 미리보기가 비서 id를 준다(마지막 대화의 비서)', () => {
    expect(readFileSync('src/app/api/conversations/route.ts', 'utf8')).toContain('agent:agents(id, name)');
  });
});
