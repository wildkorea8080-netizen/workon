import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Next.js 라우트 파일(src/app 아래의 route.ts)은 HTTP 핸들러와 라우트 설정만 값으로 내보낼 수 있다.
 * 다른 값(상수·함수)을 내보내면 `next build`의 타입 검사가 "is not a valid Route export field"로 빌드를 멈추는데,
 * `tsc --noEmit`과 vitest는 이것을 보지 않는다 — 2026-11-03 앱 예약 [id] 라우트의 상수 하나로 운영 빌드가 실패했다.
 * 타입·인터페이스는 값이 아니라 괜찮다.
 */
const SEGMENT_CONFIG = ['dynamic', 'dynamicParams', 'revalidate', 'fetchCache', 'runtime', 'preferredRegion', 'maxDuration', 'generateStaticParams'];
const ALLOWED = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', ...SEGMENT_CONFIG]);
/** page·layout 파일도 같은 검사를 받는다(2026-11-03 앱 예약 화면 page.tsx가 도움 함수를 내보내 빌드가 또 멈췄다) */
const PAGE_ALLOWED = new Set(['default', 'metadata', 'generateMetadata', 'viewport', 'generateViewport', ...SEGMENT_CONFIG]);

function filesNamed(dir: string, names: string[]): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesNamed(path, names);
    return names.includes(name) ? [path] : [];
  });
}

function valueExports(src: string): string[] {
  const names: string[] = [];
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) names.push(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && !name.startsWith('type ')) names.push(name);
    }
  }
  return names;
}

describe('Next.js 라우트 파일의 내보내기', () => {
  const files = filesNamed('src/app', ['route.ts', 'route.tsx']);
  const pages = filesNamed('src/app', ['page.tsx', 'page.ts', 'layout.tsx', 'layout.ts']);
  it('라우트 파일을 실제로 찾는다', () => {
    expect(files.length).toBeGreaterThan(100);
  });
  it('핸들러·라우트 설정 밖의 값을 내보내지 않는다(next build 실패 방지)', () => {
    const violations = files.flatMap((file) => valueExports(readFileSync(file, 'utf8')).filter((n) => !ALLOWED.has(n)).map((n) => `${file}: ${n}`));
    expect(violations).toEqual([]);
  });
  it('page·layout 파일도 Next.js가 받는 것만 내보낸다', () => {
    expect(pages.length).toBeGreaterThan(30);
    const violations = pages.flatMap((file) => valueExports(readFileSync(file, 'utf8')).filter((n) => !PAGE_ALLOWED.has(n)).map((n) => `${file}: ${n}`));
    expect(violations).toEqual([]);
  });
  it('라우트·화면 폴더 이름이 index가 아니다(/index로 끝나는 주소는 Next.js가 위 경로로 308 — 2026-11-09 색인 만들기 라우트가 운영에서 닿지 않았다)', () => {
    const violations = [...files, ...pages].filter((file) => file.split(/[\\/]/).slice(0, -1).includes('index'));
    expect(violations).toEqual([]);
  });
  it('검사가 실제로 잡는다', () => {
    expect(valueExports("export const PAUSED = 'x';\nexport async function GET() {}\nexport { handler as POST, helper };")).toEqual(['PAUSED', 'GET', 'POST', 'helper']);
  });
});
