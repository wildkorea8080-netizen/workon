import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TAG_VOCABULARY_UNREAD } from '@/lib/document-tags';

// 0256 — 관리자 화면 둘이 못 읽은 것을 숨기지 않기.
// ① 설정 '공개 링크로 공유 중인 대화'(SharedLinksPanel): 목록 읽기가 같은 오류 칸(error)을 썼다 — '공유 중단'이 실패해도
//    뒤따른 다시 읽기가 성공하면 setError(null)로 그 실패 글을 지웠고(링크가 그대로 열려 있는데 직원·관리자는 멈춘 줄 안다),
//    다시 읽기가 실패하면 중단 실패 글을 목록 실패 글로 덮었다. 목록을 못 읽은 것은 따로 기억하고 읽기는 오류 칸을 건드리지 않는다.
// ② 문서 화면의 기관 태그 분류표: 못 읽으면 칸이 조용히 사라져 분류표가 없는 기관처럼 보였다.

const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const shared = norm('src/components/admin/SharedLinksPanel.tsx');
const docs = norm('src/components/admin/DocumentsManager.tsx');

function body(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  expect(i).toBeGreaterThan(-1);
  const j = src.indexOf(end, i + start.length);
  expect(j).toBeGreaterThan(i);
  return src.slice(i, j);
}

describe('공개 링크 공유 목록', () => {
  it('목록 읽기는 조작 오류 글을 지우거나 덮지 않는다', () => {
    const load = body(shared, 'const load = useCallback(', '}, []);');
    expect(load).not.toContain('setError');
    expect(load).toContain('setUnread(true)');
    expect(load).toContain('setUnread(false)');
  });

  it('못 읽으면 앞 목록을 버리고 그렇다고 알린다', () => {
    const load = body(shared, 'const load = useCallback(', '}, []);');
    expect(load).toContain('setRows(null);');
    expect(shared).toContain("emptyListText(true, '', '공유 중인 대화를')");
    expect(shared).toContain('{rows === null && !unread && ');
  });
});

describe('기관 태그 분류표', () => {
  it('못 읽은 것을 기억하고 알린다', () => {
    const load = body(docs, 'const loadVocabulary = useCallback(', '}, []);');
    expect(load).toContain('setVocabUnread(true)');
    expect(load).toContain('setVocabUnread(false)');
    expect(docs).toContain('{vocabUnread && (');
    expect(docs).toContain('{TAG_VOCABULARY_UNREAD}');
    expect(TAG_VOCABULARY_UNREAD).toContain('불러오지 못했습니다');
  });
});
