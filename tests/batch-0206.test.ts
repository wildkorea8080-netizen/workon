import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 슈퍼관리자 대시보드의 토큰 한도 띠·Top 5·요금제 분포가 읽기 실패를 '없음'으로 보이지 않는다.
 * 예전엔 기관이나 이번 달 토큰을 못 읽으면 한도 경고·초과가 0(띠가 사라져 '한도 넘은 기관 없음'),
 * Top 5는 '데이터 없음' 또는 이름 '—'·0%, 요금제 분포는 '데이터 없음'으로 보였다.
 */

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));

import { tokenLimitCounts, topTokenOrgs } from '@/lib/org-chat-tokens';

describe('tokenLimitCounts', () => {
  const usage = new Map([['a', 80], ['b', 100], ['c', 79], ['d', 500], ['e', 1_000]]);
  it('80% 이상·100% 미만은 경고, 100% 이상은 초과', () => {
    const orgs = [
      { id: 'a', monthly_token_limit: 100 },
      { id: 'b', monthly_token_limit: 100 },
      { id: 'c', monthly_token_limit: 100 },
      { id: 'z', monthly_token_limit: 100 },
    ];
    expect(tokenLimitCounts(orgs, usage)).toEqual({ warnings: 1, exceeded: 1 });
  });
  it('한도 0·없음·숫자 아님은 무제한이라 세지 않음', () => {
    const orgs = [
      { id: 'd', monthly_token_limit: 0 },
      { id: 'e', monthly_token_limit: null },
      { id: 'a', monthly_token_limit: 'x' },
    ];
    expect(tokenLimitCounts(orgs, usage)).toEqual({ warnings: 0, exceeded: 0 });
  });
});

describe('topTokenOrgs', () => {
  it('순서를 지키고 사용률을 낸다', () => {
    const usage = new Map([['a', 900], ['b', 50]]);
    const out = topTokenOrgs(['a', 'b'], usage, [
      { id: 'b', name: '나', monthly_token_limit: 0 },
      { id: 'a', name: '가', monthly_token_limit: 1_000 },
    ]);
    expect(out).toEqual([
      { id: 'a', name: '가', tokens: 900, usagePct: 90 },
      { id: 'b', name: '나', tokens: 50, usagePct: 0 },
    ]);
  });
});

describe('원본 확인', () => {
  const route = readFileSync('src/app/api/super/dashboard/route.ts', 'utf8');
  const page = readFileSync('src/app/super/page.tsx', 'utf8');
  it('라우트: 못 읽으면 null', () => {
    expect(route).toContain('if (error || !usageMap) return null;');
    expect(route).toContain('tokenWarnings:     tokenLimits ? tokenLimits.warnings : null,');
    expect(route).toContain('tokenExceeded:     tokenLimits ? tokenLimits.exceeded : null,');
    expect(route).toContain('const planChart = planError ? null :');
    expect(route).toContain('topUsageOrgs = topError ? null :');
    expect(route).toContain('= topMap ? [] : null;');
    expect(route).not.toContain('?? new Map<string, number>()');
  });
  it('화면: 못 읽음을 따로 보인다', () => {
    expect(page).toContain('al.tokenExceeded === null');
    expect(page).toContain('data.planChart === null');
    expect(page).toContain('data.topUsageOrgs === null');
  });
});
