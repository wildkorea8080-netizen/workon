import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

/**
 * 2026-11-20 — 내 사용현황(`/my/stats`)이 못 읽은 것을 0·'없음'·앞 기간 숫자로 보이지 않는다.
 * 예전엔 ① 처음부터 못 읽으면 오류 띠 옆에 '0건'·'0'·'없음'·'0일'과 '이 기간에 대화 기록이 없습니다'가 함께 보였고,
 * ② 기간을 바꾼 뒤 읽기에 실패하면 **앞 기간의 숫자가 새 기간 아래 그대로** 남았다(늦게 온 앞 기간 응답이 새 기간을 덮을 수도 있었다).
 * 이제 못 읽으면 값을 비우고 카드는 '읽지 못함', 세 목록은 '지금 불러오지 못했습니다', 늦은 응답은 버린다.
 */

const src = readFileSync('src/app/my/stats/page.tsx', 'utf8').replace(/\r\n/g, '\n');
const fn = src.slice(src.indexOf('const fetchStats = useCallback'), src.indexOf('useEffect(() => { fetchStats(period); }'));

describe('내 사용현황 (원본)', () => {
  it('못 읽으면 앞 값을 비운다', () => {
    const fail = fn.slice(fn.indexOf('} catch (e) {'), fn.indexOf('} finally {'));
    expect(fail).toContain('setData(null);');
    expect(fail).toContain('setError(');
  });

  it('늦게 온 앞 기간의 응답은 버린다 — 성공·실패·끝 모두', () => {
    expect(src).toContain('const requestSeq = useRef(0);');
    expect(fn).toContain('const seq = ++requestSeq.current;');
    expect(fn.split('if (seq !== requestSeq.current) return;').length).toBe(3);
    expect(fn).toContain('if (seq === requestSeq.current) setLoading(false);');
  });

  it('몸을 못 읽은 응답도 정해 둔 안내로', () => {
    expect(fn).toContain('await res.json().catch(() => null)');
    expect(fn).toContain("result?.error?.message ?? '사용현황을 지금 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.'");
  });

  it('카드는 0·없음 대신 읽지 못함', () => {
    expect(src).toContain('const unread = !loading && !data;');
    expect(src).toContain("const shown = (text: string) => (loading ? '—' : unread ? '읽지 못함' : text);");
    expect(src).toContain('value={shown(`${data?.summary.monthlyConvCount ?? 0}건`)}');
    expect(src).toContain('value={shown(formatTokens(data?.summary.monthlyTokens ?? 0))}');
    expect(src).toContain('value={shown(`${data?.summary.streakDays ?? 0}일`)}');
    expect(src).not.toContain("value={loading ? '—' :");
  });

  it('세 목록은 없습니다 대신 불러오지 못했다고', () => {
    expect(src).toContain("{emptyListText(unread, '이 기간에 대화 기록이 없습니다.', '대화 횟수를')}");
    expect(src).toContain("{emptyListText(unread, '이 기간에 사용한 비서가 없습니다.', '비서별 통계를')}");
    expect(src).toContain("{emptyListText(unread, '이 기간에 대화 기록이 없습니다.', '최근 대화를')}");
  });
});
