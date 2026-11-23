import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// 0263 — 실패를 200으로 답하는 API·남은 영어 오류 글.
// ① 초대 미리보기(GET /api/signup/invite-info)만 실패를 200으로 답했다 — 토큰 없음·없는 초대·이미 사용·만료,
//    그리고 처리 중 예외(catch)까지 `{ ok: false }` 200이었다. 예외는 '지금 확인하지 못함'(503)이어야 하고,
//    200이면 상태 코드를 보는 곳(브라우저 개발 도구·바깥 감시)이 성공으로 센다. 다시 들어오지 못하게 모든 API를 훑는다.
// ② 감사 기록·이용통계 조회 실패가 `err instanceof Error && err.message ? err.message : …`라 몸이 JSON이 아니면
//    영어 구문 오류 글, 연결이 끊기면 'Failed to fetch'가 보였다.

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? routes(p) : p.endsWith('route.ts') ? [p] : [];
  });
}

/** `NextResponse.json(…)` 호출 중 `ok: false`인데 상태 코드를 주지 않은 것 */
function okFalseWithoutStatus(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while ((i = src.indexOf('NextResponse.json(', i)) !== -1) {
    let j = i + 'NextResponse.json('.length;
    let depth = 1;
    while (j < src.length && depth) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') depth--;
      j++;
    }
    const call = src.slice(i, j);
    if (/ok:\s*false/.test(call) && !/status/.test(call)) out.push(call.replace(/\s+/g, ' ').slice(0, 100));
    i = j;
  }
  return out;
}

describe('실패는 실패 상태 코드로', () => {
  it('어느 API도 ok: false를 200으로 답하지 않는다', () => {
    const offenders = routes('src/app/api').flatMap((f) => okFalseWithoutStatus(readFileSync(f, 'utf8')).map((c) => `${f}: ${c}`));
    expect(offenders).toEqual([]);
  });

  it('초대 미리보기: 처리 중 예외는 503과 안내 글', () => {
    const s = readFileSync('src/app/api/signup/invite-info/route.ts', 'utf8');
    expect(s).toContain('{ ok: false, error: SIGNUP_READ_FAILED_MESSAGE }, { status: 503 });\n  }');
    expect(s).toContain("{ ok: false, error: '만료된 초대 링크' }, { status: 410 }");
  });
});

describe('감사 기록·이용통계 조회 실패 글', () => {
  for (const f of ['src/components/admin/AuditLogsManager.tsx', 'src/components/admin/UsageSummary.tsx']) {
    it(f, () => {
      const s = readFileSync(f, 'utf8');
      expect(s).not.toContain('err instanceof Error && err.message ? err.message');
      expect(s).toContain("actionErrorText(err, '조회에 실패했습니다.')");
    });
  }
});
