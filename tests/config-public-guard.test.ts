import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * config.ts는 서버 전용 환경 변수를 필수로 읽어, 브라우저 번들에 들어가면 시작하다 던진다.
 * 화면 코드는 config-public.ts만 쓴다. 이 둘이 섞이면 빌드는 통과하고 브라우저에서만 깨진다.
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

// '@/lib/config'(config.ts)만 잡는다. '@/lib/config-public'·'@/lib/config-x'는 다른 파일이다
const IMPORTS_SERVER_CONFIG = /from\s+['"](@\/lib\/config|\.{1,2}\/(?:\.\.\/)*(?:lib\/)?config)['"]/;

describe('config-public.ts', () => {
  const source = readFileSync('src/lib/config-public.ts', 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('NEXT_PUBLIC_ 환경 변수 이름만 그대로 적는다', () => {
    const names = [...code.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toMatch(/^NEXT_PUBLIC_/);
    // process.env[key]처럼 계산하면 Next가 값으로 바꾸지 못해 브라우저에서 비어 있다
    expect(code).not.toMatch(/process\.env\s*\[/);
    expect(code).not.toMatch(/\bprocess\.env\b(?!\.)/);
  });

  it('서버 설정을 가져오지 않는다', () => {
    expect(code).not.toMatch(/\bimport\b/);
  });
});

describe('화면 코드는 config.ts를 가져오지 않는다', () => {
  it("src/components 아래와 'use client' 파일", () => {
    const offenders = walk('src')
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        const isClient =
          file.replace(/\\/g, '/').startsWith('src/components/') || /^\s*['"]use client['"]/.test(text);
        return isClient && IMPORTS_SERVER_CONFIG.test(text);
      })
      .map((file) => file.replace(/\\/g, '/'));
    expect(offenders).toEqual([]);
  });

  it('화면이 쓰는 첨부 모듈도 마찬가지다', () => {
    for (const file of [
      'src/lib/attachments/upload-client.ts',
      'src/lib/attachments/limits.ts',
      'src/lib/attachments/types.ts',
      'src/lib/file-size.ts',
      'src/lib/browser-storage.ts',
      'src/lib/document-upload-client.ts',
      'src/lib/file-types.ts',
    ]) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(IMPORTS_SERVER_CONFIG);
    }
  });

  it('검사 정규식이 config.ts와 config-public.ts를 구별한다', () => {
    expect(IMPORTS_SERVER_CONFIG.test("import { A } from '@/lib/config';")).toBe(true);
    expect(IMPORTS_SERVER_CONFIG.test("import { A } from '@/lib/config-public';")).toBe(false);
    expect(IMPORTS_SERVER_CONFIG.test("import { A } from './config';")).toBe(true);
  });
});
