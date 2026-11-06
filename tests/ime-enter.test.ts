import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { isImeComposing } from '@/lib/ime';

/**
 * 한글 조합 중 Enter(2026-11-06) — 조합 중 Enter로 보내면 마지막 글자가 입력창에 남거나 두 번 가거나 덜 조합된 글로 찾는다.
 * Enter로 보내는 키 처리는 모두 isImeComposing을 먼저 본다.
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('한글 조합 중 Enter', () => {
  it('조합 중(isComposing)이거나 조합을 끝내는 키(229)면 참', () => {
    expect(isImeComposing({ nativeEvent: { isComposing: true }, keyCode: 13 })).toBe(true);
    expect(isImeComposing({ nativeEvent: { isComposing: false }, keyCode: 229 })).toBe(true);
    expect(isImeComposing({ nativeEvent: { isComposing: false }, keyCode: 13 })).toBe(false);
    expect(isImeComposing({})).toBe(false);
  });

  it('화면의 Enter 처리는 모두 조합 중인지 먼저 본다', () => {
    const offenders: string[] = [];
    for (const f of walk('src').filter((p) => p.endsWith('.tsx'))) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/\.key\s*===?\s*['"]Enter['"]|keyCode\s*===?\s*13/.test(line) && !line.includes('isImeComposing(e)')) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('잎 파일', () => {
    expect(readFileSync('src/lib/ime.ts', 'utf8')).not.toMatch(/^import /m);
  });
});
