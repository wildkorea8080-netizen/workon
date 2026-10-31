import { describe, expect, it } from 'vitest';
import { verifyFaq, formatFaq } from '@/lib/work/workflows/faq/verify';
const sources = [{ id: 'source', name: '이용 안내', text: '주차장은 매일 운영합니다. 요금은 정해지지 않았습니다.' }];
const item = { question: '언제 운영하나요?', answer: '매일 운영합니다.', sourceId: 'source', quote: '주차장은 매일 운영합니다.', status: 'grounded' };
const json = (items: unknown[]) => JSON.stringify({ items });
describe('FAQ 답변별 근거 확인', () => {
  it('지정 문서에서 원문 인용을 확인하고 읽을 수 있게 구성한다', () => {
    const items = verifyFaq(json([item]), sources, 3);
    expect(items[0]).toMatchObject({ sourceId: 'source', status: 'grounded' });
    expect(formatFaq(items, sources)).toContain('근거: 이용 안내 — 주차장은 매일 운영합니다.');
  });
  it.each([{ sourceId: 'other' }, { quote: '요금은 무료입니다.' }, { quote: '' }, { answer: '' }, { status: 'unknown' }])('근거가 맞지 않으면 거절한다: %j', (patch) => {
    expect(() => verifyFaq(json([{ ...item, ...patch }]), sources, 3)).toThrow();
  });
  it('답 없음은 모델 답변을 버리고 확인 필요로 고정한다', () => {
    const items = verifyFaq(json([{ ...item, status: 'needs_info', answer: '무료입니다.' }]), sources, 3);
    expect(items[0]).toMatchObject({ answer: '[확인 필요] 자료에서 답을 확인할 수 없습니다.', sourceId: null, quote: '' });
  });
  it('빈 결과·초과 개수·중복 질문·잘못된 개수 제한을 거절한다', () => {
    expect(() => verifyFaq(json([]), sources, 3)).toThrow();
    expect(() => verifyFaq(json([item, item]), sources, 3)).toThrow();
    expect(() => verifyFaq(json([item, { ...item, question: '다른 질문' }]), sources, 1)).toThrow();
    expect(() => verifyFaq(json([item]), sources, NaN)).toThrow();
  });
});
