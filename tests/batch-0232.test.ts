import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

/**
 * 2026-11-20 — 못 읽으면 조용히 사라지던 화면 조각 둘.
 * ① 슈퍼관리자 사용량 화면의 '한도 초과·경고 기관': 경보 읽기가 실패하면 칸이 그냥 안 보여, 넘은 기관이 없는 줄 알았다.
 *    '실시간 현황'은 30초마다 읽는데 연결이 끊기면 처리되지 않은 오류였고, 실패해도 마지막 숫자가 그대로 보였다.
 * ② 기관 관리자 '장기 미접속 계정 잠금' 설정 칸: 지금 설정을 못 읽으면 칸이 통째로 사라졌다(이 설정이 있는지조차 알 수 없음).
 *    권한이 없어 거절된 것(401·403)은 예전처럼 보이지 않는다.
 */

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

describe('슈퍼관리자 사용량 (원본)', () => {
  const src = read('src/app/super/usage/page.tsx');

  it('한도 경보를 못 읽으면 그렇다고 알린다 — 앞서 읽은 경보는 그대로', () => {
    expect(src).toContain('setAlertsUnread(!alertRes?.ok);');
    expect(src).toContain('if (alertRes?.ok) setAlerts(alertRes.data);');
    expect(src).toContain('{alertsUnread && (');
    expect(src).toContain('한도 초과·경고 기관을 지금 불러오지 못했습니다');
    expect(src).not.toContain('setAlerts(null)');
  });

  it('실시간 현황은 던지지 않는 읽기로, 실패를 알리고 마지막 값은 그대로', () => {
    const fn = src.slice(src.indexOf('const fetchRealtime = useCallback'), src.indexOf('useEffect(() => { fetchMain(); }'));
    expect(fn).toContain("const d = await fetchOkJson<{ data: any }>('/api/super/usage/realtime');");
    expect(fn).toContain('setRealtimeUnread(!d);');
    expect(fn).toContain('if (d) setRealtime(d.data);');
    expect(src).toContain("{period === 'today' && realtimeUnread && (");
    expect(src).toContain('실시간 현황을 지금 불러오지 못했습니다');
  });
});

describe('장기 미접속 계정 잠금 (원본)', () => {
  const src = read('src/components/admin/DormantLockPanel.tsx');

  it('못 읽으면 칸을 숨기지 않고 알린다', () => {
    expect(src).toContain('.catch(() => setUnread(true));');
    const at = src.indexOf('if (unread) {');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(src.indexOf('if (!loaded) return null;'));
    expect(src).toContain('지금 설정을 불러오지 못했습니다. 화면을 새로 고쳐 주세요.');
  });

  it('권한이 없어 거절된 것은 예전처럼 보이지 않는다', () => {
    expect(src).toContain('if (!d?.ok) { if (status !== 401 && status !== 403) setUnread(true); return; }');
  });

  it('못 읽은 채로는 고르거나 저장할 수 없다(지금 값을 모르고 끄지 않게)', () => {
    const unreadBlock = src.slice(src.indexOf('if (unread) {'), src.indexOf('if (!loaded) return null;'));
    expect(unreadBlock).not.toContain('<select');
    expect(unreadBlock).not.toContain('<button');
  });
});
