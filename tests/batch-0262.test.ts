import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 0262 — 남은 'err.message' 그대로 보이기·실패 삼키기.
// ① 공개 공유 페이지(/shared/[token]): 서버는 0238부터 대화를 못 읽으면 503 '지금 열지 못했습니다'로 답하는데,
//    화면 제목은 언제나 '대화를 찾을 수 없습니다'라 잠깐의 장애가 '공유가 취소됐거나 잘못된 링크'로 읽혔다.
//    몸이 JSON이 아니거나 연결이 끊기면 영어 오류 글('Unexpected token…'·'Failed to fetch')이 보였다.
// ② 슈퍼관리자 새 기관 등록: 연결이 끊기면 err.message('Failed to fetch')가 그대로 보였다.
// ③ 초대 가입 화면: 초대 정보를 확인하는 요청이 끊기면 실패를 삼켜 기관 안내도 이메일 고정도 없이 빈 가입 화면이었다.

const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const shared = norm('src/app/shared/[token]/page.tsx');
const orgs = norm('src/app/super/organizations/page.tsx');
const signup = norm('src/app/signup/page.tsx');

describe('공개 공유 페이지', () => {
  it('없는 링크(404)와 지금 못 연 것을 가른다', () => {
    expect(shared).toContain('setMissing(res.status === 404)');
    expect(shared).toContain("{missing ? '대화를 찾을 수 없습니다' : '대화를 지금 열지 못했습니다'}");
  });
  it('영어 오류 글을 보이지 않는다', () => {
    expect(shared).not.toContain('setError(err.message)');
    expect(shared).toContain("actionErrorText(err, '대화를 지금 열지 못했습니다. 잠시 뒤 다시 열어 주세요.')");
  });
});

describe('슈퍼관리자 새 기관 등록', () => {
  it('연결 실패를 한국어로', () => {
    expect(orgs).not.toContain('setError(err.message)');
    expect(orgs).toContain("actionErrorText(err, '기관을 등록하지 못했습니다. 잠시 뒤 다시 시도해 주세요.')");
  });
});

describe('초대 가입 화면', () => {
  it('초대 정보 확인이 끊기면 알린다', () => {
    const i = signup.indexOf('/api/signup/invite-info');
    const body = signup.slice(i, signup.indexOf('}, [inviteToken]);', i));
    expect(body).not.toContain('.catch(() => {})');
    expect(body).toContain('INVITE_INFO_UNREAD');
  });
});
