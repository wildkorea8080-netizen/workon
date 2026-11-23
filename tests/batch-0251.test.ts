import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 0251 — 업무 홈·내 작업함이 못 읽은 것을 '읽는 중'·'작업 없음'으로 보이지 않기.
// 업무 홈은 작업·결과물을 못 읽으면 숫자 칸이 '…'(읽는 중)으로 영영 남고 '최근 작업'은 머리만 있는 빈 표였다.
// 내 작업함은 거르기를 바꾼 뒤 못 읽으면 오류 띠 아래 앞 거르기의 작업이 새 거르기 결과처럼 남았고,
// 처음부터 못 읽으면 '해당하는 작업이 없습니다', 오류 띠는 다시 읽기에 성공해도 지워지지 않았다.

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const home = read('src/components/work/WorkHome.tsx');
const tasks = read('src/app/tasks/page.tsx');

describe('업무 홈', () => {
  it('못 읽은 부분을 따로 기억한다', () => {
    expect(home).toContain("setUnread({ workflows: !w.ok, tasks: !t.ok, files: !f.ok });");
  });

  it("못 읽은 숫자 칸은 '…'이 아니라 '읽지 못함'", () => {
    expect(home).toContain("export const WORK_HOME_UNREAD_VALUE = '읽지 못함';");
    expect(home).toContain("tasks ? `${review.length}건` : unread.tasks ? WORK_HOME_UNREAD_VALUE : '…'");
    expect(home).toContain("tasks ? `${active.length}건` : unread.tasks ? WORK_HOME_UNREAD_VALUE : '…'");
    expect(home).toContain("files ? `${files.length}개` : unread.files ? WORK_HOME_UNREAD_VALUE : '…'");
  });

  it('최근 작업·업무 비서를 못 읽으면 빈 표가 아니라 그렇다고', () => {
    expect(home).toContain("emptyListText(true, '', '최근 작업을')");
    expect(home).toContain("emptyListText(true, '', '업무 비서 목록을')");
  });
});

describe('내 작업함', () => {
  it('첫 쪽을 못 읽으면 앞 거르기의 작업을 지우고 못 읽음을 기억한다', () => {
    expect(tasks).toContain('if (!next) { setItems([]); setCursor(null); setUnread(true); }');
  });

  it('다시 읽기에 성공하면 오류와 못 읽음을 지운다', () => {
    expect(tasks).toContain('setError(null);\n      setUnread(false);');
  });

  it('늦게 온 앞 거르기의 응답은 버린다', () => {
    expect(tasks).toContain('const seq = ++requestSeq.current;');
    expect(tasks).toContain('if (seq !== requestSeq.current) return;');
  });

  it("못 읽은 것을 '해당하는 작업이 없습니다'로 보이지 않는다", () => {
    expect(tasks).toContain("emptyListText(unread, '해당하는 작업이 없습니다.', '작업 목록을')");
  });
});
