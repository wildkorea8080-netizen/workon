import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { latestGate } from '@/lib/latest-request';

// 0272(큰 묶음) — 늦게 온 앞 요청의 응답이 새 결과를 덮지 않게.
// 거르기·찾기·쪽·기간을 바꿀 때마다 다시 읽는 화면 여덟이 응답이 온 순서대로 썼다 — 찾기 칸에 '총무'를 치면 '총'의 결과가
// 마지막에 도착해 남거나, 기간을 '7일'에서 '30일'로 바꿨는데 7일 숫자가 30일 단추 아래 보였다.
//  슈퍼관리자 로그 관리 네 탭(접속·시스템·대리 접근·관리자 조작), 기관 목록(찾기·상태·요금제·쪽), 기관 상세 사용자 찾기,
//  사용량(기간·기관·날짜), 기관 관리자 '답변 평가'(기간).

const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

describe('latestGate', () => {
  it('마지막으로 받은 번호만 최신', () => {
    const g = latestGate();
    const a = g.begin();
    const b = g.begin();
    expect(g.isLatest(a)).toBe(false);
    expect(g.isLatest(b)).toBe(true);
    const c = g.begin();
    expect(g.isLatest(b)).toBe(false);
    expect(g.isLatest(c)).toBe(true);
  });
  it('화면마다 따로', () => {
    const g1 = latestGate();
    const g2 = latestGate();
    const t1 = g1.begin();
    g2.begin();
    g2.begin();
    expect(g1.isLatest(t1)).toBe(true);
  });
});

/** 함수 본문에서 번호를 받고, 응답을 쓰기 전에 최신인지 본다 */
function guarded(src: string, start: string, count = 1) {
  let from = 0;
  for (let n = 0; n < count; n++) {
    const i = src.indexOf(start, from);
    expect(i, `${start} #${n + 1}`).toBeGreaterThan(-1);
    const body = src.slice(i, src.indexOf('\n  }, [', i));
    expect(body).toContain('const ticket = gate.current.begin();');
    expect(body).toContain('if (!gate.current.isLatest(ticket)) return;');
    from = i + start.length;
  }
}

describe('다시 읽는 화면은 마지막 요청만 쓴다', () => {
  it('슈퍼관리자 로그 관리 네 탭', () => {
    const s = norm('src/app/super/logs/page.tsx');
    guarded(s, 'const load = useCallback(async (p = 1', 4);
    expect((s.match(/const gate = useRef\(latestGate\(\)\);/g) ?? []).length).toBe(4);
  });
  it('기관 목록', () => guarded(norm('src/app/super/organizations/page.tsx'), 'const fetchOrgs = useCallback('));
  it('기관 상세 사용자 찾기', () => guarded(norm('src/app/super/organizations/[id]/page.tsx'), 'const fetch_ = useCallback('));
  it('사용량', () => guarded(norm('src/app/super/usage/page.tsx'), 'const fetchMain = useCallback('));
  it('답변 평가', () => guarded(norm('src/components/admin/FeedbackSummary.tsx'), 'const load = useCallback('));
});
