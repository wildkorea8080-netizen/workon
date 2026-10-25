import { describe, it, expect } from 'vitest';
import { linkCitations, CITE_HREF_PREFIX, citationNumber } from '@/components/chat/source-label';

describe('답변 속 [n]을 근거 창 단추로 (2026-10-23)', () => {
  const valid = new Set([1, 2]);
  it('출처에 있는 번호만 바꾼다', () => {
    expect(linkCitations('구성한다 [1]. 위원장은 총리 [2][3].', valid)).toBe(
      `구성한다 [1](${CITE_HREF_PREFIX}1). 위원장은 총리 [2](${CITE_HREF_PREFIX}2)[3].`
    );
  });
  it('이미 링크인 [1](…)은 건드리지 않는다', () => {
    expect(linkCitations('[1](https://law.go.kr) 참조', valid)).toBe('[1](https://law.go.kr) 참조');
  });
  it('코드 안의 [1]은 건드리지 않는다', () => {
    const md = '값 [1]\n```\narr[1]\n```\n끝 `x[2]`';
    expect(linkCitations(md, valid)).toBe(`값 [1](${CITE_HREF_PREFIX}1)\n\`\`\`\narr[1]\n\`\`\`\n끝 \`x[2]\``);
  });
  it('출처가 없으면 그대로', () => {
    expect(linkCitations('a [1]', new Set())).toBe('a [1]');
  });
  it('링크 주소에서 번호를 읽는다', () => {
    expect(citationNumber(`${CITE_HREF_PREFIX}2`)).toBe(2);
    expect(citationNumber('https://x')).toBeNull();
  });
});
import { sourceLocationLabel, stripNodaPrefixes, sourceTitleLabel } from '@/components/chat/source-label';

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

describe('근거 창을 화면에 잇는다 (원본 검사)', () => {
  const read = (p: string) => require('fs').readFileSync(p, 'utf8') as string;
  it('답변 말풍선은 [n]을 단추로 바꾸고, 출처 칩과 함께 근거 창을 연다', () => {
    const bubble = read('src/components/chat/MessageBubble.tsx');
    expect(bubble).toContain('linkCitations(content');
    expect(bubble).toContain('citationNumber(href)');
    expect(bubble).toContain('onOpen={onOpenSource}');
  });
  it('대화 화면이 근거 창을 하나 두고, 다른 대화를 열면 닫는다', () => {
    const chat = read('src/components/chat/ChatInterface.tsx');
    expect(chat).toContain('<SourcePanel source={openSource} onClose={closeSource} />');
    expect(chat).toContain('onOpenSource={setOpenSource}');
    expect(chat).toMatch(/followRef\.current = true;\s*setOpenSource\(null\);/);
  });
  it('근거 창은 Esc·바깥 누르기·×로 닫힌다', () => {
    const panel = read('src/components/chat/SourcePanel.tsx');
    expect(panel).toContain("e.key === 'Escape'");
    expect(panel).toContain('onClick={onClose}');
    expect(panel).toContain('aria-label="근거 창 닫기"');
  });
});

describe('출처의 [공통]·기준 연도 (S5)', () => {
  const read = (p: string) => require('fs').readFileSync(p, 'utf8') as string;

  it('공통 조각은 `[공통] 제목(연도)`, 연도가 없으면 괄호 없이', () => {
    expect(sourceTitleLabel({ documentTitle: '예산편성기준', scope: 'common', editionYear: 2026 })).toBe('[공통] 예산편성기준(2026)');
    expect(sourceTitleLabel({ documentTitle: '예산편성기준', scope: 'common' })).toBe('[공통] 예산편성기준');
  });

  it('공통인데 제목이 없으면 `문서`, 파일 이름 앞부분은 뗀다', () => {
    expect(sourceTitleLabel({ scope: 'common', editionYear: 2026 })).toBe('[공통] 문서(2026)');
    const id = '123e4567-e89b-12d3-a456-426614174000';
    expect(sourceTitleLabel({ documentTitle: `${id}__기준.pdf`, scope: 'common' })).toBe('[공통] 기준.pdf');
  });

  it('scope 없는 옛 조각은 지금 제목 그대로(앞부분 떼기·제목 없음 문구 유지)', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    expect(sourceTitleLabel({ documentTitle: `${id}__규정.pdf` })).toBe('규정.pdf');
    expect(sourceTitleLabel({ documentTitle: '규정.pdf', editionYear: 2026 })).toBe('규정.pdf');
    expect(sourceTitleLabel({})).toBe('제목 없는 문서');
  });

  it('칩과 근거 창이 이 함수를 쓰고, 창은 공통일 때만 `공통 기준` 줄을 둔다', () => {
    const chip = read('src/components/chat/SourceCitation.tsx');
    expect(chip).toContain('sourceTitleLabel(source)');
    const panel = read('src/components/chat/SourcePanel.tsx');
    expect(panel).toContain('sourceTitleLabel(source)');
    expect(panel).toContain("source.scope === 'common'");
    expect(panel).toContain('공통 기준');
  });
});
