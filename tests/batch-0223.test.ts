import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

/**
 * 2026-11-20 — 슈퍼관리자 계약·공지·매출 화면이 못 읽은 것을 '없습니다'·0원·앞 연도 숫자로 보이지 않는다.
 * ① 계약 목록·공지 목록: 응답이 실패면 아무것도 하지 않아 '계약이 없습니다'·'공지사항이 없습니다'로 보였고(거르기를 바꾼 뒤 실패하면
 *    앞 거르기의 줄이 새 거르기 아래 남았다), 연결이 끊기면 처리되지 않은 오류로 불러오는 표시가 멈추지 않았다.
 * ② 매출 현황: 연도를 바꿨는데 읽기에 실패하면 **앞 연도의 숫자가 새 연도 아래 그대로** 보였고, 처음부터 실패하면 0원이었다.
 * 판정은 `fetchOkJson`·`emptyListText`(0222, `tests/batch-0222.test.ts`가 동작을 본다).
 */

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

describe('계약 화면 (원본)', () => {
  const src = read('src/app/super/contracts/page.tsx');

  it('계약 목록 — 못 읽으면 줄을 비우고 그렇다고 알린다', () => {
    expect(src).toContain("fetchOkJson<{ data: any[]; summary: any }>(`/api/super/contracts?${p}`)");
    expect(src).toContain('setUnread(!cr);');
    expect(src).toContain('if (cr) { setContracts(cr.data); setSummary(cr.summary); } else setContracts([]);');
    expect(src).toContain("{emptyListText(unread, '계약이 없습니다.', '계약 목록을')}");
    expect(src).not.toContain('fetch(`/api/super/contracts?${p}`).then(r => r.json())');
  });

  it('매출 현황 — 연도를 바꾸면 앞 숫자를 지우고, 못 읽으면 0원이 아니라 읽지 못함', () => {
    const tab = src.slice(src.indexOf('function RevenueTab()'));
    const effect = tab.slice(tab.indexOf('useEffect(() => {'), tab.indexOf('}, [year]);'));
    expect(effect).toContain('setData(null);');
    expect(effect.indexOf('setData(null);')).toBeLessThan(effect.indexOf('fetchOkJson'));
    expect(effect).toContain('setUnread(!d);');
    expect(effect).toContain('setData(d ? d.data : null);');
    // 늦게 온 앞 연도 응답은 버린다
    expect(effect).toContain('if (!active) return;');
    expect(tab).toContain("const shown = (text: string) => (loading ? '…' : unread ? '읽지 못함' : text);");
    expect(tab).toContain("value: shown(fmtMoney(annual.totalRevenue ?? 0))");
    expect(tab).toContain("value: shown(fmtMoney(annual.totalProfit ?? 0))");
    expect(tab).toContain('매출 현황을 지금 불러오지 못했습니다.');
    expect(tab).not.toContain('.then(d => { if (d.ok) setData(d.data); })');
  });
});

describe('공지 화면 (원본)', () => {
  const src = read('src/app/super/notices/page.tsx');

  it('공지 목록 — 못 읽으면 줄을 비우고 그렇다고 알린다', () => {
    expect(src).toContain('fetchOkJson<{ data: any[] }>(`/api/super/notices?status=${filterStatus}`)');
    expect(src).toContain('setUnread(!nr);');
    expect(src).toContain('setNotices(nr ? nr.data : []);');
    expect(src).toContain("{emptyListText(unread, '공지사항이 없습니다.', '공지 목록을')}");
  });
});
