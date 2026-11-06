import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { API_KEY_PROVIDERS, isApiKeyProvider } from '@/lib/api-key-providers';

/**
 * 슈퍼관리자 키 화면의 옛 Voyage 키(2026-11-06) — S4-b에서 Voyage 경로를 지운 뒤에도 키 칸·확인 단추가 남아,
 * 확인을 누르면 보관한 키를 쓰지 않는 바깥 업체로 보냈다. 저장·확인·표시에서 모두 뺐다
 */
const read = (p: string) => readFileSync(p, 'utf8');
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('보관하는 API 키 종류', () => {
  it('Anthropic 하나 — Voyage는 받지 않는다', () => {
    expect([...API_KEY_PROVIDERS]).toEqual(['anthropic']);
    expect(isApiKeyProvider('anthropic')).toBe(true);
    expect(isApiKeyProvider('voyage')).toBe(false);
    expect(isApiKeyProvider(undefined)).toBe(false);
  });

  it('src 어디에도 Voyage 주소·키 칸이 없다(설명 글 제외)', () => {
    const offenders = walk('src')
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => {
        const code = read(f).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        return /voyageai\.com|['"]voyage['"]|voyageMasked/i.test(code);
      });
    expect(offenders).toEqual([]);
  });

  it('키 저장 두 곳이 종류를 검사한다', () => {
    expect(read('src/app/api/super/api-keys/system/route.ts')).toContain('if (!isApiKeyProvider(provider))');
    expect(read('src/app/api/super/organizations/[id]/api-keys/route.ts')).toContain('if (!isApiKeyProvider(provider)) {');
  });
});
