import { describe, it, expect } from 'vitest';
import { LlmApiError, friendlyLlmMessage, LLM_MESSAGES } from '@/lib/llm/errors';

/**
 * AI 호출 실패를 직원에게 보일 글로 바꾼다.
 *
 * 예전에는 Anthropic 원문("credit balance is too low…")이 직원 화면에 그대로 떴다.
 * 결제 상태 같은 내부 사정이 드러나고, 직원은 무엇을 해야 할지 알 수 없다.
 */
describe('friendlyLlmMessage', () => {
  it('크레딧 부족(400)은 관리자에게 문의하라는 안내', () => {
    const e = new LlmApiError(400, 'Your credit balance is too low to access the Anthropic API.');
    expect(friendlyLlmMessage(e)).toBe(LLM_MESSAGES.unavailable);
  });

  it('키 오류(401·403)와 키 미설정도 관리자 문의', () => {
    expect(friendlyLlmMessage(new LlmApiError(401, 'invalid x-api-key'))).toBe(LLM_MESSAGES.unavailable);
    expect(friendlyLlmMessage(new LlmApiError(403, 'permission'))).toBe(LLM_MESSAGES.unavailable);
    expect(friendlyLlmMessage(new LlmApiError(null, 'ANTHROPIC_API_KEY가 설정되지 않았습니다.', 'missing_key'))).toBe(
      LLM_MESSAGES.unavailable
    );
  });

  it('요청 몰림(429·529·overloaded)은 잠시 뒤 다시', () => {
    expect(friendlyLlmMessage(new LlmApiError(429, 'rate limit'))).toBe(LLM_MESSAGES.busy);
    expect(friendlyLlmMessage(new LlmApiError(529, 'Overloaded'))).toBe(LLM_MESSAGES.busy);
    expect(friendlyLlmMessage(new LlmApiError(null, 'Overloaded', 'overloaded_error'))).toBe(LLM_MESSAGES.busy);
  });

  it('그 밖의 AI 오류는 일반 안내', () => {
    expect(friendlyLlmMessage(new LlmApiError(500, 'internal'))).toBe(LLM_MESSAGES.failed);
  });

  it('AI 오류가 아니면 null — 부르는 쪽이 자기 문구를 쓴다', () => {
    expect(friendlyLlmMessage(new Error('파일이 손상되었습니다'))).toBeNull();
    expect(friendlyLlmMessage('문자열')).toBeNull();
  });

  it('안내 글에는 영어 원문이 없다', () => {
    for (const msg of Object.values(LLM_MESSAGES)) expect(msg).not.toMatch(/[A-Za-z]{4,}/);
  });

  it('원문은 오류 객체에 남는다 — 서버 기록용', () => {
    const e = new LlmApiError(400, 'credit balance is too low');
    expect(e.message).toContain('credit balance is too low');
    expect(e.status).toBe(400);
  });
});
