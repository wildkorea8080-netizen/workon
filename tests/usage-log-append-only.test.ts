import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * 사용 기록(usage_logs)은 쌓기만 한다(2026-11-06) — 감사·청구·예산 판정의 장부다.
 * 옛 `/api/reports/[id]` PATCH가 직원 본인의 '보고서 생성' 기록(details.report_content)을 고쳐 쓰게 했다 — 화면도 없고
 * 2026-10(S1-b) 뒤로 그 기록을 만드는 길도 없는 죽은 라우트라 지웠다. 기록을 고치거나 지우는 코드가 다시 들어오지 않게 본다
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('사용 기록은 쌓기만', () => {
  it('src 어디에도 usage_logs를 고치거나 지우는 쿼리가 없다', () => {
    const offenders: string[] = [];
    for (const file of walk('src').filter((f) => /\.(ts|tsx)$/.test(f))) {
      const src = readFileSync(file, 'utf8');
      let at = src.indexOf("from('usage_logs')");
      while (at !== -1) {
        const head = src.slice(at, at + 160);
        if (/\.(update|delete|upsert)\(/.test(head)) offenders.push(`${file}: ${head.split('\n')[0]}`);
        at = src.indexOf("from('usage_logs')", at + 1);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('옛 보고서 라우트가 돌아오지 않는다', () => {
    expect(existsSync('src/app/api/reports')).toBe(false);
  });
});
