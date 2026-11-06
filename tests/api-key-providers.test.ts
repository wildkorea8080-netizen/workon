import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { API_KEY_PROVIDERS, STORED_KEYS_NOT_USED_NOTICE, isApiKeyProvider } from '@/lib/api-key-providers';

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

  it('화면은 사실대로 — 저장한 키는 보관만, 호출은 서버 환경 변수 키(옛 "기관 자체 키 사용" 문구 없음)', () => {
    const pages = ['src/app/super/api-keys/page.tsx', 'src/app/super/organizations/[id]/page.tsx'].map(read);
    for (const page of pages) {
      expect(page).toContain('{STORED_KEYS_NOT_USED_NOTICE}');
      expect(page).not.toMatch(/OFF: 기관 자체 키 사용|공용으로 사용됩니다|시스템 키 사용 기관|✅ 자체 키/);
    }
    expect(STORED_KEYS_NOT_USED_NOTICE).toContain('보관만');
    expect(STORED_KEYS_NOT_USED_NOTICE).toContain('ANTHROPIC_API_KEY');
  });

  it('저장한 키를 읽는 곳은 슈퍼관리자 키 라우트뿐 — 호출에 쓰게 되면 이 시험과 화면 문구를 함께 고친다', () => {
    const readers = walk('src')
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => read(f).includes("from('api_keys')"))
      .map((f) => f.replace(/\\/g, '/'));
    expect(readers.every((f) => f.startsWith('src/app/api/super/'))).toBe(true);
    expect(read('src/lib/llm/anthropic.ts')).not.toContain('api_keys');
  });

  it('키 저장 두 곳이 종류를 검사한다', () => {
    expect(read('src/app/api/super/api-keys/system/route.ts')).toContain('if (!isApiKeyProvider(provider))');
    expect(read('src/app/api/super/organizations/[id]/api-keys/route.ts')).toContain('if (!isApiKeyProvider(provider)) {');
  });
});
