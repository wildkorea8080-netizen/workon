import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WORK_TEMPLATES_UNREAD } from '@/components/admin/WorkAdmin';

// 0253 — 기관 관리자 '업무 관리'가 못 읽은 것을 '없습니다'로 보이지 않기.
// 예전엔 기관 업무 양식 목록을 못 읽으면 '등록한 기관 업무 양식이 없습니다', 업무 현황을 못 읽으면 '아직 업무 작업이 없습니다'로
// 보이고 오류 글도 없었다. 양식 목록에서 오는 '바꿀 수 있는 사람인가'를 못 읽으면 처음 값(참)대로 단추가 열렸고,
// 업무 목록을 못 읽으면 곧바로 돌아가 이미 읽은 양식·현황까지 그리지 않았다.

const src = readFileSync('src/components/admin/WorkAdmin.tsx', 'utf8').replace(/\r\n/g, '\n');

describe('업무 관리 화면', () => {
  it('하나를 못 읽어도 나머지를 그리고, 못 읽은 부분을 기억한다', () => {
    expect(src).not.toContain('if (!i.ok) return setError(i.message);');
    expect(src).toContain('setUnread({ installs: !i.ok, templates: !t.ok, overview: !o.ok });');
    expect(src).toContain('if (failed && !failed.ok) setError(failed.message);');
  });

  it('양식 목록을 못 읽으면 단추를 열어 두지 않는다', () => {
    expect(src).toContain('setTemplates([]);\n      setChat([]);\n      setCanManage(false);');
    // 권한 없음 안내 대신 못 읽음 안내
    expect(src).toContain('{!canManage && !unread.templates && (');
    expect(WORK_TEMPLATES_UNREAD).toContain('불러오지 못했습니다');
    expect(WORK_TEMPLATES_UNREAD).toContain('단추를 막아 두었습니다');
  });

  it("못 읽은 양식·현황·업무 목록을 '없습니다'로 보이지 않는다", () => {
    expect(src).toContain("unread.templates ? WORK_TEMPLATES_UNREAD : '등록한 기관 업무 양식이 없습니다.");
    expect(src).toContain("emptyListText(unread.overview, '아직 업무 작업이 없습니다.', '업무 현황을')");
    expect(src).toContain("emptyListText(true, '', '업무 목록을')");
  });
});
