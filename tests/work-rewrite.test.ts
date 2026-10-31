import { describe, expect, it } from 'vitest';
import { rewriteNumbersPreserved, translationNumbersPreserved } from '@/lib/work/workflows/rewrite/verify';
import { getWorkflow } from '@/lib/work/catalog';
import { getWorkflowImpl } from '@/lib/work/workflows';
describe('문장 교정·변환의 숫자 표기 검사', () => {
  it('표현만 바뀌면 통과한다', () => { expect(rewriteNumbersPreserved('2026년 11월 3일 오후 2시, 15명, 30,000원이에요.', '2026년 11월 3일 오후 2시, 15명, 30,000원입니다.')).toBe(true); });
  it.each(['2026년 11월 4일 15명', '2026년 11월 3일 16명', '2026년 11월 3일', '2026년 11월 3일 15명 2건'])('날짜·수치 변경·누락·추가를 감지한다: %s', (text) => { expect(rewriteNumbersPreserved('2026년 11월 3일 15명', text)).toBe(false); });
  it('같은 숫자의 누락과 단위 변경도 감지한다', () => { expect(rewriteNumbersPreserved('10명과 10명', '10명')).toBe(false); expect(rewriteNumbersPreserved('10명', '10건')).toBe(false); });
  it('숫자가 없는 표현도 지원한다', () => { expect(rewriteNumbersPreserved('알려드릴게요.', '안내하겠습니다.')).toBe(true); });
  it('앱 입력·출력과 실행기가 등록되어 있다', () => { expect(getWorkflow('document-rewrite')?.inputs.find((i) => i.key === 'rewriteMode')?.options).toHaveLength(3); expect(getWorkflowImpl('document-rewrite')).toMatchObject({ kind: 'document', documentOutputKey: 'rewritten' }); });
});

describe('번역 숫자 보존', () => {
  it('날짜 순서·단위 언어·금액 쉼표 변경을 허용한다', () => {
    expect(translationNumbersPreserved('2026년 11월 3일 15명, 30,000원', '15 participants, KRW 30000 on 2026-11-03')).toBe(true);
  });
  it.each(['15 participants on 2026-11-04', '16 participants on 2026-11-03', 'on 2026-11-03', '15 participants and 2 rooms on 2026-11-03'])('추가·누락·변경을 거부한다: %s', (output) => {
    expect(translationNumbersPreserved('2026년 11월 3일 15명', output)).toBe(false);
  });
  it('번역 앱이 등록되어 있다', () => { expect(getWorkflow('document-translation')?.inputs.find((i) => i.key === 'targetLanguage')?.options).toHaveLength(4); expect(getWorkflowImpl('document-translation')?.documentOutputKey).toBe('translation'); });
});
