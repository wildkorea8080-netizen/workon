import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

/**
 * 2026-11-20 — 기관 관리자 '사용자 관리'가 못 읽은 목록을 '없음'으로 보이지 않는다.
 * 화면은 사용자·초대·부서 세 목록을 읽는데, 응답이 `{ ok: false }`(503 등)이면 아무것도 하지 않았다 —
 * 사용자 목록은 '등록된 사용자가 없습니다', 초대는 0건으로 보였고, 부서 목록을 못 읽으면 소속 부서 드롭다운이
 * 까닭 없이 막혔다(부서 0개 = 못 옮김). 오류 칸(`error`)은 조작마다 지워져 읽기 실패를 담아 둘 수 없다.
 * 이제 `fetchOkJson`으로 받아 못 읽은 것을 따로 기억하고 알린다. 앞서 읽은 목록은 그대로 둔다.
 */

const src = readFileSync('src/components/admin/UsersManager.tsx', 'utf8').replace(/\r\n/g, '\n');
const fn = src.slice(src.indexOf('const loadData = useCallback(async () => {'), src.indexOf('useEffect(() => { loadData(); }'));

describe('사용자 관리 (원본)', () => {
  it('세 목록 모두 못 읽음을 기억한다', () => {
    expect(fn).toContain("fetchOkJson<{ data: any[]; seats?: any; me?: unknown }>('/api/users')");
    expect(fn).toContain("fetchOkJson<{ data: any[] }>('/api/admin/invite')");
    expect(fn).toContain("fetchOkJson<{ data?: any[] }>('/api/departments')");
    expect(fn).toContain('setUnread({ users: !usersRes, invitations: !invitesRes, depts: !deptsRes });');
  });

  it('못 읽었을 때 앞서 읽은 목록을 비우지 않는다', () => {
    expect(fn).toContain('if (usersRes) { setUsers(usersRes.data);');
    expect(fn).toContain('if (invitesRes) setInvitations(invitesRes.data);');
    expect(fn).toContain('if (deptsRes) setDepts(flattenDepts(deptsRes.data ?? []));');
    expect(fn).not.toContain('setUsers([])');
  });

  it('읽는 중 표시는 실패해도 끝난다(던지지 않는 읽기)', () => {
    expect(fn).toContain('setLoading(false);');
    expect(fn).not.toContain('.then(r => r.json())');
  });

  it('무엇을 못 읽었는지 알리고, 빈 자리에 없습니다라고 하지 않는다', () => {
    expect(src).toContain("const unreadNames = [unread.users && '사용자 목록', unread.invitations && '초대 목록', unread.depts && '부서 목록'].filter(Boolean) as string[];");
    expect(src).toContain('{unreadNames.length > 0 && (');
    expect(src).toContain("{unreadNames.join('·')}을 지금 불러오지 못했습니다.");
    expect(src).toContain("{emptyListText(unread.users, '등록된 사용자가 없습니다.', '사용자 목록을')}");
  });

  it('읽기 실패 알림은 조작마다 지워지는 오류 칸과 따로다', () => {
    expect(src.indexOf('{unreadNames.length > 0 && (')).toBeLessThan(src.indexOf('{error && ('));
    expect(fn).not.toContain('setError(');
  });
});
