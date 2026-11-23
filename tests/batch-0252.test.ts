import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 0252 — 비서 편집 창의 '변경 기록'·'양식' 탭이 못 읽은 것을 '기록 없음'·'양식 없음'으로 보이지 않기.
// 예전엔 목록을 못 읽으면 오류 글 위에 '기록이 없습니다'·'올린 양식이 없습니다'가 함께 보였고,
// 되돌리기·올리기를 누르면 오류가 지워져 기록·양식이 정말 없는 것처럼 남았다.
// 판이 바뀐 뒤 다시 읽기에 실패하면 앞 판의 목록이 지금 목록처럼 남았고, 양식 탭은 몇 개 남았는지 모른 채 올리기 칸을 열었다.

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const history = read('src/components/agents/HistoryPanel.tsx');
const templates = read('src/components/agents/TemplatesPanel.tsx');

describe.each([
  ['변경 기록', history, "emptyListText(unread, '기록이 없습니다.', '변경 기록을')"],
  ['양식', templates, "emptyListText(unread, '올린 양식이 없습니다.', '양식 목록을')"],
])('%s 탭', (_name, src, emptyText) => {
  it('못 읽으면 앞 목록을 지우고 못 읽음을 따로 기억한다', () => {
    expect(src).toContain('setItems([]);\n      setUnread(true);');
  });

  it('다시 읽기에 성공하면 못 읽음을 지운다', () => {
    expect(src).toContain('setItems(r.data.items);\n      setUnread(false);');
  });

  it('늦게 온 앞 판의 응답은 버린다', () => {
    expect(src).toContain('const seq = ++requestSeq.current;');
    expect(src).toContain('if (seq !== requestSeq.current) return;');
  });

  it("못 읽은 것을 '없습니다'로 보이지 않는다", () => {
    expect(src).toContain(emptyText);
  });
});

describe('양식 탭', () => {
  it('목록을 못 읽었으면 올리기 칸을 열지 않는다', () => {
    expect(templates).toContain('{!unread && items.length < MAX_TEMPLATES && (');
  });
});
