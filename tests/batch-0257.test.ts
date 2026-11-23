import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DOCUMENTS_STALE_NOTE } from '@/components/agents/DocumentsPanel';

// 0257 — 비서 편집 창 '문서' 탭(DocumentsPanel)이 목록을 못 읽은 것을 조작 오류와 섞지 않기.
// 예전엔 목록 다시 읽기의 실패가 같은 오류 칸(error)을 써서, 올리기·지우기 뒤 다시 읽기가 실패하면
// '올리지 못한 파일이 있습니다 — …'·'문서를 지우지 못했습니다' 글을 '문서를 불러오지 못했습니다'로 덮었다(무엇이 실패했는지 사라짐).
// 다시 읽기가 성공해도 앞 읽기 실패 글은 남았고, 실패한 동안 보이는 목록이 마지막으로 읽은 것이라는 표시도 없었다
// (지운 문서가 그대로 보이고 '읽는 중'이 멈춘 듯 보임).

const src = readFileSync('src/components/agents/DocumentsPanel.tsx', 'utf8').replace(/\r\n/g, '\n');

function refreshBody(): string {
  const i = src.indexOf('const refresh = useCallback(');
  const j = src.indexOf('}, [agentId]);', i);
  expect(i).toBeGreaterThan(-1);
  expect(j).toBeGreaterThan(i);
  return src.slice(i, j);
}

describe('비서 문서 탭', () => {
  it('목록 읽기는 조작 오류 칸을 쓰지 않고 못 읽음을 따로 기억한다', () => {
    const body = refreshBody();
    expect(body).not.toContain('setError');
    expect(body).toContain('setUnread(true)');
    expect(body).toContain('setUnread(false)');
  });

  it('못 읽으면 처음엔 안내, 앞 목록이 있으면 마지막으로 읽은 것이라고 알린다', () => {
    expect(src).toContain('{rows === null && !unread && ');
    expect(src).toContain("rows === null ? emptyListText(true, '', '참고 문서 목록을') : DOCUMENTS_STALE_NOTE");
    expect(DOCUMENTS_STALE_NOTE).toContain('마지막으로 읽은');
  });
});
