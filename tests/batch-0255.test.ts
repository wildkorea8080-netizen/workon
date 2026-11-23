import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as providers from '@/lib/api-key-providers';

// 0255 — 슈퍼관리자 'API 키 관리'가 못 읽은 것을 '미설정'·'0'·'기관 없음'으로 보이지 않기.
// 예전엔 시스템 키 상태를 못 읽으면 알림이 잠깐 뜬 뒤 키 카드가 '(미설정)', 통계가 '0개'·'0'·'$0'으로 남았고,
// 기관별 키 현황을 못 읽으면 '총 0개 기관'·'기관이 없습니다'로 남았다(알림은 사라진다). 키를 저장한 뒤 다시 읽기에
// 실패하면 앞의 상태가 그대로 남았다.

const src = readFileSync('src/app/super/api-keys/page.tsx', 'utf8').replace(/\r\n/g, '\n');

describe('시스템 키 탭', () => {
  it('못 읽으면 앞 상태를 버리고 그렇다고 남긴다', () => {
    expect(src).toContain("else { setData(null); onToast(");
    expect(src).toContain('{!data && <p role="alert"');
    expect(String((providers as Record<string, unknown>).SYSTEM_KEYS_UNREAD ?? '')).toContain('불러오지 못했습니다');
  });

  it("못 읽은 키·숫자를 '(미설정)'·0으로 보이지 않는다", () => {
    expect(src).toContain("{data ? (keyInfo.masked ?? '(미설정)') : '(읽지 못함)'}");
    expect(src).toContain('const stats = data ? (data.stats ?? {}) : { systemKeyOrgCount: null, totalTokensThisMonth: null, estimatedCostUsd: null };');
  });
});

describe('기관별 키 현황 탭', () => {
  it('못 읽으면 줄을 비우고 못 읽음을 표에 남긴다', () => {
    expect(src).toContain('else { setRows([]); setUnread(true);');
    expect(src).toContain("emptyListText(unread, '기관이 없습니다.', '기관별 키 현황을')");
    expect(src).toContain("unread ? '총 —개 기관'");
  });
});
