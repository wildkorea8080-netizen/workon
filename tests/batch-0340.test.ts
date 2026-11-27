// tests/batch-0340.test.ts
// 사용자 관리 목록의 좁은 화면(2026-11-27, 운영 화면 확인에서 찾음) — 사이드바를 연 노트북(약 700px)에서 한 줄에 다 들어가지 않으면
// 줄바꿈 없이 눌려 '관리자로 지정'·'비밀번호 재발급' 같은 단추 글자가 한 글자씩 세로로 접혔다. 이제 줄을 바꿔 놓고 단추 글자는 접지 않는다.
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync('src/components/admin/UsersManager.tsx', 'utf8');
const row = src.slice(src.indexOf('{shownUsers.map(user => ('), src.indexOf('조건에 맞는 직원이 없습니다.'));

describe('사용자 관리 목록 줄', () => {
  it('줄과 오른쪽 조작 칸이 줄바꿈된다', () => {
    expect(row).toContain('flex flex-wrap items-center justify-between gap-3 p-4');
    expect(row).toContain('flex flex-wrap items-center justify-end gap-x-3 gap-y-2');
    expect(row).toContain('text-xs text-slate-400 break-all">{user.email}');
  });
  it('단추·표시 글자는 한 글자씩 접히지 않는다', () => {
    for (const label of ['잠금 풀기', '비밀번호 재발급', "'관리자 해제' : '관리자로 지정'", "'다시 사용' : '사용 중지'"]) {
      const at = row.indexOf(label);
      expect(at, label).toBeGreaterThan(0);
      const tag = row.slice(row.lastIndexOf('<button', at), at);
      expect(tag, label).toContain('whitespace-nowrap');
    }
    expect(row).toContain("whitespace-nowrap px-2.5 py-1 text-xs font-medium rounded-full ${");
  });
});
