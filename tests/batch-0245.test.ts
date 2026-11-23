import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { emptyListText } from '@/lib/ok-json';

/**
 * 2026-11-21 — 결과물 화면(`/files`)이 못 읽은 목록을 앞 결과·머리만 있는 빈 표로 보이지 않는다.
 * '대화에서 만든 파일'·'대화에 올린 파일'은 페이지 위 찾기 글이 바뀌면 처음부터 다시 읽는데, 그 첫 쪽을 못 읽으면 오류 띠만 띄우고
 * **앞 찾기(또는 전체)의 파일을 그대로** 두었다 — '예산'을 찾다 실패하면 이름에 '예산'이 없는 파일들이 찾은 결과처럼 보였다.
 * '업무 결과물'은 못 읽으면 머리만 있는 빈 표였다. 이제 첫 쪽 실패면 목록을 비우고 '지금 불러오지 못했습니다'를 보인다
 * ('더 보기' 실패는 읽은 쪽을 그대로 둔다).
 */

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const src = read('src/app/files/page.tsx');
const paged = src.slice(src.indexOf('function PagedFiles('));

describe('대화 파일 목록 (쪽으로 읽음)', () => {
  it('첫 쪽을 못 읽으면 앞 목록을 지우고 못 읽음으로 둔다', () => {
    expect(paged).toContain('if (!cursor) { setFiles(null); setNext(null); setUnread(true); }');
  });
  it('읽으면 못 읽음 표시를 푼다', () => {
    expect(paged).toContain('setError(null);\n    setUnread(false);');
  });
  it('못 읽은 목록은 없다고 하지 않는다', () => {
    expect(paged).toContain("{(unread && !files) || (files && files.length === 0) ? (");
    expect(paged).toContain("unread && !files ? emptyListText(true, emptyText, '파일 목록을')");
  });
  it('늦게 온 옛 응답은 그대로 버린다', () => {
    expect(paged).toContain('if (seq !== latest.current) return;');
  });
});

describe('업무 결과물', () => {
  it('못 읽으면 머리만 있는 표 대신 그렇다고', () => {
    expect(src).toContain('const workUnread = Boolean(error) && !allFiles;');
    expect(src).toContain("workUnread ? emptyListText(true, '', '업무 결과물을')");
  });
});

describe('문구', () => {
  it('못 읽음 글', () => {
    expect(emptyListText(true, '대화에서 만든 파일이 없습니다.', '파일 목록을')).toBe('파일 목록을 지금 불러오지 못했습니다. 화면을 새로 고쳐 주세요.');
    expect(emptyListText(false, '대화에서 만든 파일이 없습니다.', '파일 목록을')).toBe('대화에서 만든 파일이 없습니다.');
  });
});
