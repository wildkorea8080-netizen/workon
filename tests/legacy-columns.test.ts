import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * 0028이 지우는 칸을 코드가 읽거나 쓰지 않는다.
 * 남아 있으면 조회가 실패하거나, 화면이 오류 없이 빈 값을 보인다.
 *
 * 파일 목록은 fs로 모은다 — `find`는 Windows 기본 셸(cmd)에서 다른 명령이다.
 */
const LEGACY = /\bis_personal\b|\benabled_connectors\b/;
const SOURCE = /\.(ts|tsx|mjs)$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => SOURCE.test(f))
    .map((f) => join(dir, f).replace(/\\/g, '/'));
}

describe('옛 칸', () => {
  it('src와 scripts 어디에도 없다', () => {
    const files = [...sourceFiles('src'), ...sourceFiles('scripts')];
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((f) => LEGACY.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
