import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { ORG_FILTER_UNREAD } from '@/lib/ok-json';

/**
 * 2026-11-21 — 슈퍼관리자 화면 셋(사용량·로그 관리·계정 관리)의 기관 거르기 목록을 못 읽은 것을 '기관 없음'으로 보이지 않는다.
 * 셋 다 `if (d.ok) setOrgs(…)`만 있어, 기관 목록을 못 읽으면 드롭다운에 '전체 기관'만 남아 등록된 기관이 없는 것처럼 보였고
 * 기관별로 거를 수 없는 까닭도 알 수 없었다(응답이 JSON이 아니면 처리되지 않은 오류). 이제 고를 수 없는 안내 줄을 넣는다.
 */

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const PAGES = ['src/app/super/usage/page.tsx', 'src/app/super/logs/page.tsx', 'src/app/super/accounts/page.tsx'];

describe.each(PAGES)('%s 기관 거르기', (path) => {
  const src = read(path);
  it('목록을 fetchOkJson으로 받고 못 읽음을 기억한다', () => {
    expect(src).toContain("fetchOkJson<{ data: unknown }>('/api/super/organizations?limit=100')");
    expect(src).toContain('setOrgsUnread(true)');
    expect(src).not.toMatch(/if \((d|data)\.ok\) setOrgs\((d|data)\.data\)/);
  });
  it('드롭다운에 고를 수 없는 안내 줄', () => {
    expect(src).toContain('{orgsUnread && <option value="__unread" disabled>{ORG_FILTER_UNREAD}</option>}');
  });
});

describe('문구', () => {
  it('안내 줄', () => {
    expect(ORG_FILTER_UNREAD).toBe('(기관 목록을 불러오지 못함 — 화면을 새로 고쳐 주세요)');
  });
});
