import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { limitMessage, type TokenLimitStatus } from '../src/lib/usage-limit';

/**
 * 사용 한도.
 *
 * 이 계층의 실패는 전부 **조용하다.** 한도를 걸어 뒀는데 안 걸리거나,
 * 새 달이 됐는데 안 풀리거나, 어떤 경로만 검사를 안 거치거나 — 셋 다
 * 오류를 내지 않고 결과만 틀린다. 그래서 소스와 순수 함수를 함께 본다.
 */

const base: TokenLimitStatus = { allowed: false, usedTokens: 0, limitTokens: 0 };

describe('차단 문구', () => {
  it('부서 한도와 개인 한도를 구분해 말한다', () => {
    // "한도 초과"만 뜨면 담당자는 누구에게 무엇을 요청해야 할지 모른다
    const dept = limitMessage({
      ...base,
      reason: 'department_budget_exhausted',
      monthly: { scope: 'department', usedKrw: 1_000_000, limitKrw: 1_000_000, percent: 100 },
    });
    expect(dept).toContain('부서');
    expect(dept).toContain('1,000,000원');

    const user = limitMessage({
      ...base,
      reason: 'user_budget_exhausted',
      monthly: { scope: 'user', usedKrw: 20_000, limitKrw: 20_000, percent: 100 },
    });
    expect(user).toContain('개인');
    expect(user).toContain('20,000원');
  });

  it('금액 한도에는 토큰 수를 쓰지 않는다', () => {
    // 공공기관 담당자에게 "토큰"은 의미가 통하지 않는다
    const msg = limitMessage({
      ...base,
      reason: 'department_budget_exhausted',
      monthly: { scope: 'department', usedKrw: 500, limitKrw: 500, percent: 100 },
    });
    expect(msg).not.toContain('토큰');
  });
});

describe('월 경계는 KST', () => {
  const src = readFileSync('src/lib/usage-limit.ts', 'utf8');

  it('서버 로컬 시간을 쓰지 않는다', () => {
    // Vercel은 UTC로 돈다. 로컬 기준으로 자르면 한국 시간 매월 1일
    // 0시~9시 사이에 한도가 풀리지 않아 "새 달인데 왜 막혀 있냐"가 된다.
    const start = src.indexOf('function monthStartISO');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('}', src.indexOf('return', start)));
    expect(block).toContain('getUTC');
    expect(block).not.toContain('getFullYear()');
  });

  it('실제로 KST 1일 0시를 가리킨다', () => {
    // 함수가 모듈 밖으로 나가 있지 않으므로 같은 계산을 여기서 재현해
    // 경계값이 어긋나지 않는지 본다.
    const monthStart = (now: Date) => {
      const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
      return new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), 1, -9, 0, 0));
    };

    // 한국 3월 1일 오전 3시 → 이번 달은 3월이어야 한다
    const kstMar1_03 = new Date('2026-02-28T18:00:00Z'); // KST 3/1 03:00
    expect(monthStart(kstMar1_03).toISOString()).toBe('2026-02-28T15:00:00.000Z');

    // 한국 2월 28일 오후 11시 → 아직 2월
    const kstFeb28_23 = new Date('2026-02-28T14:00:00Z'); // KST 2/28 23:00
    expect(monthStart(kstFeb28_23).toISOString()).toBe('2026-01-31T15:00:00.000Z');
  });
});

describe('토큰을 쓰는 라우트는 모두 한도를 확인한다', () => {
  /**
   * `/api/qna`와 `/api/report`가 usage_logs에 토큰을 기록하면서 한도는
   * 확인하지 않고 있었다. 예산을 소진한 기관도 그 두 경로로는 계속 쓸 수
   * 있었다 — 차단이 동작한다고 믿는데 구멍이 남아 있던 자리다.
   */
  const files = execSync('find src/app/api -name "route.ts"', { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);

  const spenders = files.filter((f) => {
    const src = readFileSync(f, 'utf8');
    // 모델을 부르고 그 사용량을 기록하는 라우트
    return src.includes('usage_logs') && /callClaudeAPI|streamClaudeAPI/.test(src);
  });

  it('대상 라우트를 실제로 찾는다', () => {
    expect(spenders.length).toBeGreaterThan(2);
  });

  it('전부 checkTokenLimit을 거친다', () => {
    const missing = spenders.filter((f) => !readFileSync(f, 'utf8').includes('checkTokenLimit'));
    expect(missing, '토큰을 쓰는데 한도 검사가 없음').toEqual([]);
  });

  it('사용자를 함께 넘긴다', () => {
    // 두 번째 인자를 빠뜨리면 개인 한도가 조용히 적용되지 않는다.
    // 관리자는 한도를 걸었다고 믿는데 아무도 안 걸린다.
    const bad = spenders.filter((f) => {
      const src = readFileSync(f, 'utf8');
      const at = src.indexOf('checkTokenLimit(');
      if (at === -1) return false;
      const call = src.slice(at, src.indexOf(')', at));
      return !call.includes(',');
    });
    expect(bad, 'checkTokenLimit에 사용자를 안 넘김').toEqual([]);
  });
});

describe('집계 규약', () => {
  const sql = readFileSync('supabase/migrations/0024_department_user_budget.sql', 'utf8');

  it('cost_krw가 없는 옛 로그는 제외한다', () => {
    // 0017과 같은 규약. 추정치로 서비스를 차단하지 않겠다는 뜻이다.
    const count = (sql.match(/details \? 'cost_krw'/g) ?? []).length;
    expect(count).toBe(2); // 부서·사용자 두 함수
  });

  it('합산을 DB에서 끝낸다', () => {
    // 매 대화마다 로그를 앱으로 끌어오면 월 수천 건만 되어도 무겁다
    expect(sql).toContain('department_spend_krw');
    expect(sql).toContain('user_spend_krw');
    expect(sql).toContain('SUM(');
  });

  it('조회 인덱스를 함께 만든다', () => {
    expect(sql).toContain('idx_usage_logs_dept_created');
    expect(sql).toContain('idx_usage_logs_user_created');
  });
});
