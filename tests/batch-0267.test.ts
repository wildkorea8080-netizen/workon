import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 0267(큰 묶음) — 화면 전체를 훑어 찾은 '못 읽은 것을 없음·숨김으로 보이기'와 '던지는 응답 읽기' 일곱 곳을 한 번에.
//  ① 기관 정보(OrganizationManager): 응답을 못 읽으면(`r.json()`이 던짐) 오류 글 없이 빈 칸의 기관 정보 양식이 보였다
//  ② 슈퍼관리자 기관 상세의 초대 링크: 못 읽으면 잠깐의 알림 뒤 '아직 초대 링크가 없습니다'
//  ③ 대화의 '이 대화의 첨부 N개'(ConversationAttachments): 못 읽으면 줄이 사라져 첨부가 없는 대화처럼 보였다
//  ④ 관리자 문서 검색 시험(RAGSearchTester): 비서 목록을 못 읽으면 콘솔에만 남기고 빈 고르기
//  ⑤ 문서 찾기 일괄 평가(RagEvalPanel): 비서 목록·저장한 세트를 못 읽으면 빈 고르기(비서·세트가 없는 것처럼)
//  ⑥ 내 로그인 기록(MySignIns): 못 읽으면 칸이 통째로 사라졌다(대리 접근 403일 때만 숨겨야 한다)
//  ⑦ 업무 변경 기록: 작업 권한을 못 읽으면 '되돌리기' 단추가 까닭 없이 사라졌다

const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

describe('기관 정보', () => {
  const s = norm('src/components/admin/OrganizationManager.tsx');
  it('던지지 않고 읽고, 못 읽었으면 오류 글', () => {
    expect(s).not.toContain("fetch('/api/admin/organization').then((r) => r.json())");
    expect(s).toContain("requestJson('/api/admin/organization')");
    expect(s).toContain("serverErrorText(orgReply.body, '기관 정보를 불러오지 못했습니다.')");
  });
  it('기관 정보를 못 읽었으면 저장 단추를 막는다', () => {
    expect(s).toContain('disabled={saving || !org || !name.trim()}');
  });
});

describe('슈퍼관리자 기관 상세의 초대 링크', () => {
  const s = norm('src/app/super/organizations/[id]/page.tsx');
  it("못 읽었으면 '없습니다' 대신 그렇다고", () => {
    expect(s).toContain('setInvitationsUnread(true)');
    expect(s).toContain("invitationsUnread ? emptyListText(true, '', '초대 링크 목록을') : '아직 초대 링크가 없습니다.");
  });
});

describe('대화의 첨부 목록', () => {
  const s = norm('src/components/chat/AttachmentChips.tsx');
  it('못 읽었으면 줄을 숨기지 않고 알린다', () => {
    expect(s).toContain('if (items.length === 0 && !unread) return null;');
    expect(s).toContain('ATTACHMENTS_UNREAD');
  });
});

describe('문서 검색 시험·일괄 평가의 고르기 목록', () => {
  it('검색 시험', () => {
    const s = norm('src/components/admin/RAGSearchTester.tsx');
    expect(s).not.toContain("console.error('Failed to load agents:'");
    expect(s).toContain("emptyListText(true, '', '비서 목록을')");
  });
  it('일괄 평가', () => {
    const s = norm('src/components/admin/RagEvalPanel.tsx');
    expect(s).toContain('setListUnread((u) => ({ ...u, sets: !r.ok }))');
    expect(s).toContain('setListUnread((u) => ({ ...u, agents: !r.ok }))');
    expect(s).toContain('{listUnread.agents && <option value="" disabled>');
    expect(s).toContain('{listUnread.sets && <option value="" disabled>');
  });
});

describe('내 로그인 기록', () => {
  const s = norm('src/components/my/MySignIns.tsx');
  it('대리 접근(403)일 때만 숨기고, 그 밖의 실패는 알린다', () => {
    expect(s).not.toContain('if (failed) return null;');
    expect(s).toContain('else if (r.status === 403) setHidden(true);');
    expect(s).toContain('로그인 기록을 지금 불러오지 못했습니다');
  });
});

describe('업무 변경 기록', () => {
  const s = norm('src/app/tasks/[id]/history/page.tsx');
  it('작업 권한을 못 읽었으면 되돌리기 단추가 없는 까닭을 알린다', () => {
    expect(s).toContain('else if (v.ok) setError(');
    expect(s).toContain('되돌리기 단추를 숨겼습니다');
  });
});
