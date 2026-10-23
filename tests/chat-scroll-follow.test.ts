import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { isNearBottom, FOLLOW_THRESHOLD_PX } from '@/components/chat/scroll-follow';

/**
 * 답변이 흘러나오는 동안 화면을 맨 아래로 끌어내리는 것은 사용자가 맨 아래에 있을 때뿐이다.
 * 예전에는 글자 조각마다 무조건 내려, 참고 자료·출처 때문에 위로 밀린 답을 올려 읽을 수 없었다(2026-10-23).
 */
describe('isNearBottom', () => {
  it('맨 아래면 따라간다', () => {
    expect(isNearBottom({ scrollHeight: 2000, scrollTop: 1400, clientHeight: 600 })).toBe(true);
  });
  it('맨 아래에서 조금 떨어져도(상한 안) 따라간다', () => {
    expect(isNearBottom({ scrollHeight: 2000, scrollTop: 1400 - FOLLOW_THRESHOLD_PX + 1, clientHeight: 600 })).toBe(true);
  });
  it('위로 올려 읽는 중이면 따라가지 않는다', () => {
    expect(isNearBottom({ scrollHeight: 4000, scrollTop: 500, clientHeight: 600 })).toBe(false);
  });
  it('내용이 화면보다 짧으면 따라간다', () => {
    expect(isNearBottom({ scrollHeight: 300, scrollTop: 0, clientHeight: 600 })).toBe(true);
  });
});

describe('대화 화면은 따라가기 판정을 쓴다', () => {
  const src = readFileSync('src/components/chat/ChatInterface.tsx', 'utf8');
  it('메시지가 바뀔 때 무조건 맨 아래로 내리지 않는다', () => {
    // 맨 아래로 내리는 호출은 따라가기 판정 뒤에만 있다
    const calls = src.match(/[^\n]*messagesEndRef\.current\?\.scrollIntoView[^\n]*/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const line of calls) expect(line).toContain('followRef.current');
  });
  it('스크롤할 때 따라가기 여부를 다시 정한다', () => {
    expect(src).toContain('onScroll');
    expect(src).toContain('isNearBottom(');
  });
});
