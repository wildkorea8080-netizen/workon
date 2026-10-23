import { describe, it, expect } from 'vitest';
import { sourceLocationLabel, stripNodaPrefixes } from '@/components/chat/source-label';

const ID = '123e4567-e89b-12d3-a456-426614174000';

describe('sourceLocationLabel', () => {
  it('쪽과 절', () =>
    expect(sourceLocationLabel({ page: 12, section: '제3장 › 여비', chunkIndex: 0, similarity: 0.8 })).toBe('p.12 · 제3장 › 여비'));
  it('쪽만 있으면 쪽만', () =>
    expect(sourceLocationLabel({ page: 3, section: null, chunkIndex: 0, similarity: 0.8 })).toBe('p.3'));
  it('칸 주소', () =>
    expect(sourceLocationLabel({ page: null, cellRange: '표.csv!A3:D20', chunkIndex: 1, similarity: 0.8 })).toBe('표.csv!A3:D20'));
  it('절만 있으면 절', () =>
    expect(sourceLocationLabel({ section: '제3장 › 여비', chunkIndex: 1, similarity: 0.8 })).toBe('제3장 › 여비'));
  it('옛 메시지는 옛 표시', () =>
    expect(sourceLocationLabel({ chunkIndex: 2, similarity: 0.456 })).toBe('청크 3 • 유사도: 45.6%'));
  it('빈 글 위치는 없는 것으로 본다', () =>
    expect(sourceLocationLabel({ page: null, cellRange: '  ', section: '', chunkIndex: 0, similarity: 0.5 })).toBe('청크 1 • 유사도: 50.0%'));
  it('NODA 파일 이름 앞부분은 보이지 않는다', () => {
    expect(sourceLocationLabel({ cellRange: `${ID}__표.csv!A1`, chunkIndex: 0, similarity: 0.8 })).toBe('표.csv!A1');
    expect(sourceLocationLabel({ page: 2, section: `${ID}__제1장`, chunkIndex: 0, similarity: 0.8 })).toBe('p.2 · 제1장');
  });
});

describe('stripNodaPrefixes', () => {
  it('uuid 앞부분만 뗀다', () => {
    expect(stripNodaPrefixes(`${ID}__여비 규정.pdf`)).toBe('여비 규정.pdf');
    expect(stripNodaPrefixes('abc__여비.pdf')).toBe('abc__여비.pdf');
    expect(stripNodaPrefixes(`${ID.toUpperCase()}__a.csv`)).toBe('a.csv');
  });
});
