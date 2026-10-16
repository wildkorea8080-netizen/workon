import { describe, it, expect } from 'vitest';
import {
  CAPABILITY_IDS,
  normalizeCapabilities,
  deriveCapabilityScope,
  scopeViolations,
  clampToScope,
} from '@/lib/capabilities/settings';

const known = { knownConnectorIds: ['law', 'kosis'] };

describe('능력 설정 정규화', () => {
  it('능력은 다섯이다 — S1의 셋, S2-a의 문서 만들기, S3-a의 파일 받아 읽기', () => {
    expect([...CAPABILITY_IDS]).toEqual(['doc_search', 'public_data', 'image', 'document', 'file_read']);
  });

  it('비어 있으면 빈 설정', () => {
    expect(normalizeCapabilities(null, known)).toEqual({ ok: true, value: {} });
    expect(normalizeCapabilities({}, known)).toEqual({ ok: true, value: {} });
  });

  it('설정이 없는 능력은 빈 객체로 맞춘다', () => {
    expect(normalizeCapabilities({ image: { junk: 1 }, doc_search: {} }, known)).toEqual({
      ok: true,
      value: { image: {}, doc_search: {} },
    });
  });

  it('모르는 능력은 거절한다', () => {
    const r = normalizeCapabilities({ table_merge: {} }, known);
    expect(r.ok).toBe(false);
  });

  it('없는 커넥터는 거절한다', () => {
    const r = normalizeCapabilities({ public_data: { connectors: ['law', 'g2b'] } }, known);
    expect(r).toEqual({ ok: false, message: '쓸 수 없는 공공데이터 연결입니다: g2b' });
  });

  it('커넥터가 비면 공공데이터 능력을 뺀다', () => {
    expect(normalizeCapabilities({ public_data: { connectors: [] } }, known)).toEqual({ ok: true, value: {} });
  });

  it('배열·문자열은 객체가 아니다', () => {
    expect(normalizeCapabilities(['image'], known).ok).toBe(false);
    expect(normalizeCapabilities({ image: true }, known).ok).toBe(false);
  });
});

describe('기관 범위', () => {
  const scope = deriveCapabilityScope(
    [
      { capabilities: { public_data: { connectors: ['law'] } } },
      { capabilities: { public_data: { connectors: ['dart'] } } }, // 키가 빠진 커넥터
      { capabilities: null },
    ],
    ['law', 'kosis']
  );

  it('공식 비서가 켠 커넥터만, 지금 쓸 수 있는 것만', () => {
    expect([...scope.publicDataConnectors]).toEqual(['law']);
  });

  it('문서 찾기와 사진은 범위 검사 대상이 아니다', () => {
    // 자기 비서의 문서·자기가 첨부한 사진은 기관 밖으로 나가지 않는다
    expect(scopeViolations({ doc_search: {}, image: {} }, scope)).toEqual([]);
  });

  it('범위 밖 커넥터를 짚는다', () => {
    expect(scopeViolations({ public_data: { connectors: ['law', 'kosis'] } }, scope)).toEqual(['kosis']);
  });

  it('대화할 때는 범위 밖을 걷어낸다', () => {
    expect(clampToScope({ image: {}, public_data: { connectors: ['kosis'] } }, scope)).toEqual({ image: {} });
    expect(clampToScope({ public_data: { connectors: ['law', 'kosis'] } }, scope)).toEqual({
      public_data: { connectors: ['law'] },
    });
  });
});
