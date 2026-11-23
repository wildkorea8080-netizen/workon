import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 0254 — 기관 관리자 '기관 통계 API 키'·'앱 결과 보낼 곳'이 못 읽은 목록을 '없습니다'로 보이지 않기.
// 예전엔 목록을 못 읽으면 오류 글 아래 '아직 만든 키가 없습니다'·'아직 보낼 곳이 없습니다'가 함께 보였고, 다른 단추를 누르면
// 오류 글이 지워져 쓰는 키·보낼 곳이 정말 없는 것처럼 남았다(회수할 키가 안 보임). 키 회수가 실패해도 곧바로 다시 읽기가
// 성공하면 오류 글을 지워, 회수하지 못했다는 안내가 사라졌다.

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const keys = read('src/components/admin/OrgApiKeysPanel.tsx');
const outbound = read('src/components/admin/OutboundEndpointsPanel.tsx');

describe.each([
  ['기관 통계 API 키', keys, 'setKeys([]); setCalls([]); setUnread(true);', "emptyListText(unread, '아직 만든 키가 없습니다.', 'API 키 목록을')"],
  ['앱 결과 보낼 곳', outbound, 'setEndpoints([]); setDeliveries([]); setUnread(true);', "emptyListText(unread, '아직 보낼 곳이 없습니다.', '보낼 곳 목록을')"],
])('%s', (_name, src, clearOnFail, emptyText) => {
  it('못 읽으면 앞 목록을 지우고 못 읽음을 따로 기억한다', () => {
    expect(src).toContain(clearOnFail);
    expect(src).toContain('setUnread(false);');
  });

  it('목록 읽기는 단추의 오류 글을 건드리지 않는다', () => {
    const load = src.slice(src.indexOf('const load = useCallback'), src.indexOf('useEffect(() => { void load(); }'));
    expect(load).not.toContain('setError');
  });

  it("못 읽은 목록을 '없습니다'로 보이지 않고, 몇 개 쓰는지 모를 때는 만들기를 막는다", () => {
    expect(src).toContain(emptyText);
    expect(src).toContain('disabled={busy || unread ||');
  });
});

describe('앱 결과 보낼 곳', () => {
  it("못 읽은 보낸 기록도 '없습니다'로 보이지 않는다", () => {
    expect(outbound).toContain("emptyListText(unread, '보낸 기록이 없습니다.', '보낸 기록을')");
  });
});
