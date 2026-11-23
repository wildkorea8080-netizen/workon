import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

/**
 * 2026-11-21 — 슈퍼관리자 계정 관리·로그 관리 화면이 못 읽은 것을 앞 결과·'없음'으로 보이지 않는다.
 * ① 계정 관리 '전체 사용자'는 찾기가 실패하면(`{ ok: false }`) 아무것도 하지 않아 **앞 검색의 사용자·인원 수가 새 검색의 결과처럼** 남았다 —
 *    그 줄에서 사용 중지·비밀번호 재발급·삭제를 누를 수 있다. 처음부터 실패하면 '사용자가 없습니다'. 응답이 JSON이 아니면 던져 도는 표시가 멈추지 않았다.
 *    늦게 온 앞 검색이 새 검색 결과를 덮기도 했다. '슈퍼관리자' 탭도 같았다(못 읽으면 머리만 있는 빈 표).
 * ② 로그 관리의 접속·시스템·대리 접근 탭은 실패하면 '로그가 없습니다'와 오류 띠를 함께 보이면서, 앞 조회의 '총 N건'·의심 IP·
 *    '오늘·이번주 ERROR' 수를 그대로 남겼다. 응답이 JSON이 아니면 던져 도는 표시가 멈추지 않았다.
 */

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

describe('계정 관리', () => {
  const src = read('src/app/super/accounts/page.tsx');
  const users = src.slice(src.indexOf('const fetchUsers = useCallback'), src.indexOf('}, [search, filterOrg, filterRole]);'));
  const admins = src.slice(src.indexOf("fetchOkJson<{ data: any[] }>('/api/super/accounts/super-admins')") - 200, src.indexOf("fetchOkJson<{ data: any[] }>('/api/super/accounts/super-admins')") + 300);

  it('사용자 찾기는 던지지 않고, 실패면 앞 결과를 지우고 못 읽음으로', () => {
    expect(users).toContain('fetchOkJson<');
    expect(users).not.toContain('res.json()');
    expect(users).toContain('else { setUsers([]); setMeta({ total: 0, newThisMonth: null }); setUnread(true); }');
  });
  it('늦게 온 앞 검색은 버린다', () => {
    expect(users).toContain('const seq = ++requestSeq.current;');
    expect(users).toContain('if (seq !== requestSeq.current) return;');
  });
  it('못 읽으면 인원 수·빈 표를 그렇다고', () => {
    expect(src).toContain("value: unread ? '읽지 못함' : meta.total");
    expect(src).toContain("{emptyListText(unread, '사용자가 없습니다.', '사용자 목록을')}");
  });
  it('슈퍼관리자 목록도', () => {
    expect(admins).toContain('else { setList([]); setUnread(true); }');
    expect(src).toContain("{emptyListText(unread, '슈퍼관리자가 없습니다.', '슈퍼관리자 목록을')}");
  });
});

describe('로그 관리', () => {
  const src = read('src/app/super/logs/page.tsx');
  it('목록 읽기는 던지지 않는다', () => {
    expect(src).toContain('async function readLogJson(url: string)');
    expect(src).not.toMatch(/const res {2}= await fetch\(`\/api\/super\/logs\/(access|system|impersonation)/);
  });
  it('실패하면 앞 조회의 숫자를 남기지 않는다', () => {
    expect(src).toContain("else { setRows([]); setMeta({ total: 0 }); setSuspicious([]); setLoadError(data.error?.message ?? '접속 기록을 불러오지 못했습니다.'); }");
    expect(src).toContain("else { setRows([]); setSummary({}); setLoadError(data.error?.message ?? '시스템 기록을 불러오지 못했습니다.'); }");
    expect(src).toContain("else { setRows([]); setMeta({ total: 0 }); setLoadError(data.error?.message ?? '대리 접근 기록을 불러오지 못했습니다.'); }");
  });
  it("'로그가 없습니다'를 오류와 함께 보이지 않는다", () => {
    expect(src).not.toContain('text-slate-500">로그가 없습니다.</td>');
    expect(src).not.toContain('text-slate-500">대리 접근 이력이 없습니다.</td>');
    expect(src.match(/\{loadError \? '—' : '로그가 없습니다\.'\}/g)).toHaveLength(2);
  });
});
