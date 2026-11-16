import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { CRITICAL_LOGS_LINK, SYSTEM_LOG_CATEGORIES, criticalSummary, parseLogLink } from '@/lib/super-log-links';

/**
 * 2026-11-17 — 심각한 운영 기록을 보이게. 사용 기록·감사 기록·계약 맞추기 실패를 critical로 남기게 했지만 대시보드 알림 띠는 토큰 초과·
 * 계약 만료만 보였고, 로그 화면은 주소의 tab을 읽지 않아 대시보드 '전체 보기'가 접속 로그로 열렸으며 payment 카테고리 거르기가 없었다.
 */

describe('로그 화면 주소', () => {
  it('tab·level·category·period를 읽고 모르는 값은 기본값', () => {
    expect(parseLogLink('?tab=system&level=critical&category=payment&period=week')).toEqual({ tab: 'system', level: 'critical', category: 'payment', period: 'week' });
    expect(parseLogLink('tab=impersonation')).toEqual({ tab: 'impersonation', level: 'all', category: 'all', period: 'month' });
    expect(parseLogLink('?tab=evil&level=<x>&category=drop&period=year')).toEqual({ tab: 'access', level: 'all', category: 'all', period: 'month' });
    expect(parseLogLink('')).toEqual({ tab: 'access', level: 'all', category: 'all', period: 'month' });
  });
  it('알림 띠 링크가 그 거르기로 열린다, payment 카테고리가 있다', () => {
    expect(parseLogLink(CRITICAL_LOGS_LINK.split('?')[1])).toMatchObject({ tab: 'system', level: 'critical' });
    expect(SYSTEM_LOG_CATEGORIES).toContain('payment');
    // 서버가 쓰는 카테고리(logger.ts)를 모두 거를 수 있다
    const logger = readFileSync('src/lib/logger.ts', 'utf8');
    const used = /category:\s*([^;]+);/.exec(logger)![1].match(/'([a-z]+)'/g)!.map((s) => s.slice(1, -1));
    for (const c of used) expect(SYSTEM_LOG_CATEGORIES).toContain(c);
  });
});

describe('critical 요약', () => {
  it('문구별로 세어 많은 것부터 셋, 빈 문구 묶음', () => {
    const rows = [
      ...Array(3).fill({ message: '사용 기록을 남기지 못했습니다(청구·한도에서 빠짐)' }),
      ...Array(5).fill({ message: '계약·기관 상태를 맞추지 못했습니다' }),
      { message: '보안 로그를 남기지 못했습니다' },
      { message: null }, { message: '  ' },
    ];
    expect(criticalSummary(rows)).toEqual([
      { message: '계약·기관 상태를 맞추지 못했습니다', count: 5 },
      { message: '사용 기록을 남기지 못했습니다(청구·한도에서 빠짐)', count: 3 },
      { message: '(문구 없음)', count: 2 },
    ]);
    expect(criticalSummary([])).toEqual([]);
  });
  it('잎 파일', () => {
    expect(readFileSync('src/lib/super-log-links.ts', 'utf8')).not.toMatch(/^import /m);
  });
});

describe('연결(원본)', () => {
  it('대시보드 API — 최근 24시간 critical 수·문구, 못 읽으면 null', () => {
    const src = readFileSync('src/app/api/super/dashboard/route.ts', 'utf8');
    expect(src).toContain(".eq('level', 'critical')");
    expect(src).toContain('new Date(Date.now() - CRITICAL_WINDOW_MS).toISOString()');
    expect(src).toContain('critical24h: criticalRecent.error ? null :');
  });
  it('대시보드 화면 — 띠·링크·못 읽음 안내', () => {
    const page = readFileSync('src/app/super/page.tsx', 'utf8');
    expect(page).toContain('al.critical24h?.count > 0');
    expect(page).toContain('href={CRITICAL_LOGS_LINK}');
    expect(page).toContain('al.critical24h === null');
  });
  it('로그 화면 — 주소에서 열고 거르기 목록은 공용 값', () => {
    const page = readFileSync('src/app/super/logs/page.tsx', 'utf8');
    expect(page).toContain('parseLogLink(window.location.search)');
    expect(page).toContain("useState(initial?.level ?? 'all')");
    expect(page).toContain('SYSTEM_LOG_CATEGORIES.map(');
  });
});
