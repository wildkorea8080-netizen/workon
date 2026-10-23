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
  it('위치도 유사도도 없는 NODA 조각은 청크 번호만 — "유사도: 0.0%"를 보이지 않는다', () => {
    expect(sourceLocationLabel({ page: null, cellRange: null, section: null, chunkIndex: 0, similarity: 0 })).toBe('청크 1');
    expect(sourceLocationLabel({ chunkIndex: 4, similarity: Number.NaN })).toBe('청크 5');
    expect(sourceLocationLabel({ chunkIndex: 1 } as { chunkIndex: number; similarity?: number })).toBe('청크 2');
  });
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

describe('관리 화면 원본 (문서·검색 시험)', () => {
  // 화면을 실행하는 장치가 없어 원본 글을 읽는다(document-routes.test.ts와 같은 방식)
  it('문서 목록 다시 부르기는 앞 응답 뒤에 다음을 예약하고(겹치지 않게), 늦은 옛 응답은 버린다', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/components/admin/DocumentsManager.tsx', 'utf8');
    expect(src).not.toContain('setInterval(');
    expect(src).toMatch(/await refreshDocuments\(\);\s*if \(!stopped\) timer = setTimeout\(tick, POLL_INTERVAL_MS\)/);
    expect(src).toContain('if (seq !== listSeqRef.current) return;');
    // '다시 시도'는 나가 있는 목록 응답을 버리게 순번을 올린다
    const retry = src.slice(src.indexOf('const handleRetry'), src.indexOf('const handleUpload'));
    expect(retry).toContain('listSeqRef.current++');
  });

  it('읽기 실패 칩에도 이유를 보인다', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/components/admin/DocumentsManager.tsx', 'utf8');
    expect(src).toContain("읽기 실패{doc.noda_reason ? ` — ${doc.noda_reason}` : ''}");
  });

  it('검색 시험은 대화 화면과 같은 위치 줄을 쓰고 빈 글 상자를 그리지 않는다', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/components/admin/RAGSearchTester.tsx', 'utf8');
    expect(src).toContain('sourceLocationLabel(chunk)');
    expect(src).not.toContain('내용 없음');
    expect(src).not.toMatch(/from '@\/lib\/(config|noda)'/);
  });
});
