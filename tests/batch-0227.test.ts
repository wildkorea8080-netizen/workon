import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

/**
 * 2026-11-20 — 관리자 통계의 '사용량 추이'·'답변 평가'가 실패한 뒤에 틀리게 남던 것.
 * ① 사용량 추이(`UsageChart`): 한 번 실패하면 오류가 지워지지 않고, 오류 화면이 **기간 단추까지 가려** 새로 고치기 전에는
 *    다시 조회할 수 없었다. 읽는 중 표시도 처음 한 번뿐이라 기간을 바꾸면 앞 기간 그림이 그대로 보였고,
 *    닿지 않는 자리에 오류를 '해당 기간에 사용 내역이 없습니다'로 보이는 가지가 남아 있었다.
 * ② 답변 평가(`FeedbackSummary`): 새 기간 조회가 실패해도 앞 기간의 표가 새 날짜 아래 그대로 보였다.
 */

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

describe('사용량 추이 (원본)', () => {
  const src = read('src/components/admin/UsageChart.tsx');
  const fn = src.slice(src.indexOf('const loadUsageData = async () => {'), src.indexOf('const formatDate'));

  it('다시 읽을 때 읽는 중으로 돌리고 앞 오류를 지운다', () => {
    const head = fn.slice(0, fn.indexOf('try {'));
    expect(head).toContain('setLoading(true);');
    expect(head).toContain('setError(null);');
  });

  it('늦게 온 앞 기간의 응답은 버린다', () => {
    expect(src).toContain('const requestSeq = useRef(0);');
    expect(fn.split('if (seq !== requestSeq.current) return;').length).toBe(3);
    expect(fn).toContain('if (seq === requestSeq.current) setLoading(false);');
  });

  it('기간 단추는 읽는 중·실패에도 보인다 — 화면을 통째로 바꾸는 이른 return이 없다', () => {
    expect(src).not.toContain('if (loading) {\n    return');
    expect(src).not.toContain('if (error && usageData.length === 0) {');
    const selector = src.indexOf('{/* Period selector */}');
    const branch = src.indexOf('{loading ? (');
    expect(selector).toBeGreaterThan(-1);
    expect(branch).toBeGreaterThan(selector);
    expect(src).toContain('<div role="alert" className="p-4 text-red-700 bg-red-100 rounded-lg">{error}</div>');
  });

  it('오류를 사용 내역 없음으로 보이는 가지가 없다', () => {
    expect(src).not.toContain('해당 기간에 사용 내역이 없습니다.');
  });

  it('가짜 숫자로 채우지 않는다(실패면 빈 값)', () => {
    expect(fn).toContain('setUsageData([]);');
  });
});

describe('답변 평가 (원본)', () => {
  const src = read('src/components/admin/FeedbackSummary.tsx');
  it('못 읽으면 앞 기간의 표를 지운다', () => {
    const fail = src.slice(src.indexOf('} catch (e) {'), src.indexOf('} finally {'));
    expect(fail).toContain('setData(null);');
    expect(fail).toContain("setError(actionErrorText(e, '답변 평가를 불러오지 못했습니다.'));"); // 0261부터 actionErrorText
  });
});
