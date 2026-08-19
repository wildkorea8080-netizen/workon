import { describe, it, expect } from 'vitest';
import { isLikelyScanned, MAX_OCR_PAGES } from '@/lib/pdf-ocr';
import { MATCH_THRESHOLD, MATCH_COUNT } from '@/lib/rag';

/**
 * 스캔 판정과 RAG 임계값.
 *
 * 둘 다 숫자 하나가 잘못되면 조용히 전체 기능이 죽는 자리다.
 * 임계값 0.72로는 어떤 문서도 검색되지 않았고, 그 상태로 한참을 지났다.
 */

describe('스캔 PDF 판정', () => {
  it('텍스트 레이어가 있으면 스캔이 아니다', () => {
    expect(isLikelyScanned('가'.repeat(6000), 3)).toBe(false);
  });

  it('빈 문자열이면 스캔이다', () => {
    expect(isLikelyScanned('', 3)).toBe(true);
  });

  it('표지만 텍스트고 본문이 스캔인 문서를 잡는다', () => {
    // 전체 길이만 보면 놓친다. 페이지당으로 나눠야 잡힌다.
    expect(isLikelyScanned('가'.repeat(300), 10)).toBe(true);
  });

  it('짧지만 텍스트가 있는 1쪽 문서는 스캔이 아니다', () => {
    expect(isLikelyScanned('가'.repeat(200), 1)).toBe(false);
  });

  it('페이지 수를 모르면 스캔으로 단정하지 않는다', () => {
    // 판정 못 하는 것을 스캔으로 넘기면 멀쩡한 PDF에 토큰을 쓴다
    expect(isLikelyScanned('', 0)).toBe(false);
  });

  it('페이지 상한이 Anthropic document 블록 제한 안에 있다', () => {
    expect(MAX_OCR_PAGES).toBeLessThanOrEqual(100);
  });
});

describe('RAG 임계값', () => {
  it('실측한 무관 질문 유사도보다 높다', () => {
    // 무관 질문(요리·코딩·날씨) 실측 최고치가 0.11이었다.
    // 이보다 낮으면 아무 문서나 딸려 나온다.
    expect(MATCH_THRESHOLD).toBeGreaterThan(0.11);
  });

  it('실측한 관련 질문 유사도보다 낮다', () => {
    // 관련 질문 실측 최저치가 0.41이었다. 이보다 높으면 아무것도 검색되지
    // 않는다 — 0.72였을 때 실제로 그랬고, 오류 없이 조용히 그랬다.
    expect(MATCH_THRESHOLD).toBeLessThan(0.41);
  });

  it('top-k가 답변에 쓸 만한 개수다', () => {
    expect(MATCH_COUNT).toBeGreaterThanOrEqual(3);
    expect(MATCH_COUNT).toBeLessThanOrEqual(20);
  });
});
