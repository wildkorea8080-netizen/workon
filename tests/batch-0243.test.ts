import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { emptyListText } from '@/lib/ok-json';

/**
 * 2026-11-21 — 기관 관리자 감사 기록·이용통계·부서 화면이 못 읽은 것을 '없음'으로 보이지 않는다.
 * ① 감사 기록(`AuditLogsManager`)·이용통계(`UsageSummary`)는 조회가 실패하면 표를 '해당 기간에 (사용) 내역이 없습니다'로 그리면서,
 *    위의 '총 N건 · 사용액 X원'은 **앞서 조회한 기간·조건의 숫자를 그대로** 남겼다 — 감사 자료를 낼 화면에서 새 조건의 합계로 읽힌다.
 *    늦게 온 앞 조회의 응답이 새 조건의 결과를 덮기도 했다. 이제 실패하면 합계를 지우고 '지금 불러오지 못했습니다', 앞 응답은 버린다.
 * ② 부서 화면(`DepartmentsManager`)은 못 읽으면 '등록된 부서가 없습니다'였고, 목록 읽기가 연결 실패로 던져 부서를 만든·고친·지운 뒤
 *    다시 읽기가 실패하면 '부서 생성에 실패했습니다'처럼 보였다(이미 만들어졌는데). 이제 던지지 않고 못 읽음을 따로 알린다.
 */

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

describe.each([
  ['src/components/admin/AuditLogsManager.tsx', '해당 기간에 내역이 없습니다.', '내역을'],
  ['src/components/admin/UsageSummary.tsx', '해당 기간에 사용 내역이 없습니다.', '사용 내역을'],
])('%s', (file, empty, what) => {
  const src = read(file);
  const failBlock = src.slice(src.indexOf('    } catch (err) {', src.indexOf('const load = useCallback')), src.indexOf('    } finally {', src.indexOf('const load = useCallback')));

  it('실패하면 앞 조회의 합계를 지우고 못 읽음으로 둔다', () => {
    expect(failBlock).toContain('setMeta(null);');
    expect(failBlock).toContain('setUnread(true);');
    expect(src).toContain('setUnread(false);');
  });
  it('빈 표를 못 읽음과 가른다', () => {
    expect(src).toContain(`{emptyListText(unread, '${empty}', '${what}')}`);
    expect(src).not.toContain(`text-slate-400">${empty}</td>`);
    expect(emptyListText(true, empty, what)).toContain('지금 불러오지 못했습니다');
    expect(emptyListText(false, empty, what)).toBe(empty);
  });
  it('늦게 온 앞 조회의 응답은 버린다', () => {
    expect(src).toContain('const seq = ++requestSeq.current;');
    expect(src).toContain('if (seq !== requestSeq.current) return;');
    expect(src).toContain('if (seq === requestSeq.current) setLoading(false);');
  });
});

describe('부서 화면', () => {
  const src = read('src/components/admin/DepartmentsManager.tsx');
  const load = src.slice(src.indexOf('const load = useCallback'), src.indexOf('}, []);', src.indexOf('const load = useCallback')));

  it('목록 읽기는 던지지 않는다(만든 뒤 다시 읽기 실패가 만들기 실패로 보이지 않게)', () => {
    expect(load).toContain("fetchOkJson<");
    expect(load).not.toContain('res.json()');
    expect(load).toContain('setUnread(true)');
  });
  it('못 읽으면 "등록된 부서가 없습니다" 대신 알린다', () => {
    expect(src).toContain("{emptyListText(unread, '등록된 부서가 없습니다.', '부서 목록을')}");
    expect(src).toContain('{unread && tree.length > 0 && (');
    expect(src).toContain('DEPARTMENTS_STALE');
  });
});
