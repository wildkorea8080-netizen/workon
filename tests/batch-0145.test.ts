import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { sumCostUsd } from '@/lib/models';

/**
 * 2026-11-17 — 슈퍼관리자 대시보드·사용량 화면의 숫자. '오늘 활성 N명'은 오늘 대화 기록 수였고(한 사람이 열 번 물으면 열 명),
 * '전체 사용자'·'이번달 신규'에 탈퇴 처리한 계정이 들어 있었으며, 예상 비용은 기록할 때 확정한 원가(`details.cost_usd`) 대신
 * 모든 기록을 기본 모델 단가로 다시 셌다(Opus처럼 비싼 모델은 적게 보임). 토큰은 숫자가 아닌 값도 더했다.
 */

const dash = readFileSync('src/app/api/super/dashboard/route.ts', 'utf8');
const usage = readFileSync('src/app/api/super/usage/route.ts', 'utf8');

describe('대시보드', () => {
  it("'오늘 활성'은 서로 다른 사람 수", () => {
    expect(dash).toContain('new Set(todayRows.map((r: { user_id: string | null }) => r.user_id).filter(Boolean)).size');
    expect(dash).not.toContain('userToday.count');
  });
  it('사용자 수에서 탈퇴 처리한 계정은 뺀다', () => {
    expect(dash.match(/\.eq\('is_super_admin', false\)\.is\('deleted_at', null\)/g)?.length).toBe(2);
  });
  it('예상 비용은 기록한 원가, 토큰은 숫자만', () => {
    expect(dash).toContain('sumCostUsd(monthUsage.data ?? [])');
    expect(dash).toContain('chatTokensOf(l.details)');
    expect(dash).not.toContain('estimateCostUsd(');
  });
});

describe('사용량 모니터링', () => {
  it('예상 비용은 기록한 원가(기관별도), 토큰은 숫자만', () => {
    expect(usage).toContain('sumCostUsd([row])');
    expect(usage).toContain('estimatedCost: orgCost.get(oid) ?? 0');
    expect(usage).not.toContain('estimateCostUsd(');
    expect(usage).not.toMatch(/\(row\.details\?\.input_tokens\s+as number\) \?\? 0/);
  });
});

describe('기록한 원가를 쓰는 까닭', () => {
  it('Opus 기록은 기본 단가로 다시 세면 적게 나온다', () => {
    const opus = { details: { model: 'claude-opus-5', input_tokens: 1_000_000, output_tokens: 0, cost_usd: 5 } };
    expect(sumCostUsd([opus])).toBe(5); // 기록한 값(기본 Sonnet 단가로는 3)
  });
});
