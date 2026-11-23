import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { emptyListText } from '@/lib/ok-json';

/**
 * 2026-11-21 — 슈퍼관리자 공통 자료실(`/super/common-library`)이 탭의 목록을 못 읽은 것을 '없음'으로 보이지 않는다.
 * 유형 탭을 열 때 목록을 못 읽으면 오류 띠와 함께 '현재 판 (0)'·'올린 문서가 없습니다'를 보였다 — 이미 올린 정부 기준 문서가 없는 줄 알고
 * 새로 올리게 된다(같은 이름이면 서버가 409로 막지만 까닭을 알기 어렵다). 그 오류 글은 조작마다 지워지는 칸이라 다른 탭을 읽은 뒤에도 남았고,
 * 지우기·올리기를 하면 사라졌다. 응답이 JSON이 아니면 '목록을 못 읽음' 대신 일반 실패로 떨어졌다.
 * 이제 탭마다 못 읽음을 따로 기억해 숫자를 '읽지 못함'으로, 빈 칸을 '지금 불러오지 못했습니다'로 보이고, 다시 읽으면 푼다.
 */

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const src = read('src/app/super/common-library/page.tsx');
const tabLoad = src.slice(src.indexOf('// 탭을 바꾸면 그 유형의 목록을 새로 부른다'), src.indexOf('// 읽는 중인 문서가 있는 동안만'));
const refresh = src.slice(src.indexOf('const refreshDocuments = useCallback'), src.indexOf('// 탭을 바꾸면 그 유형의 목록을 새로 부른다'));

describe('공통 자료실 목록', () => {
  it('탭을 못 읽으면 조작 오류와 따로 기억한다', () => {
    expect(tabLoad).toContain('setListUnread(null);');
    expect(tabLoad).toContain("setListUnread('문서 목록을 불러오지 못했습니다.')");
    expect(tabLoad).not.toContain("setErrorMessage(result.error?.message || '문서 목록을 불러오지 못했습니다.')");
    expect(tabLoad).toContain('if (res.ok && result?.ok && Array.isArray(result.data)) applyRows(result.data);');
    expect(tabLoad).toContain('await res.json().catch(() => null)');
  });
  it('다시 읽기가 되면 못 읽음을 푼다', () => {
    expect(refresh).toContain('setListUnread(null);');
  });
  it('없다고 하지 않는다', () => {
    expect(src).toContain("({listUnread ? '읽지 못함' : current.length})");
    expect(src).toContain("{emptyListText(Boolean(listUnread), '올린 문서가 없습니다.', '문서 목록을')}");
    expect(src).toContain('{listUnread && (');
  });
  it('문구', () => {
    expect(emptyListText(true, '올린 문서가 없습니다.', '문서 목록을')).toBe('문서 목록을 지금 불러오지 못했습니다. 화면을 새로 고쳐 주세요.');
  });
});
