import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Next.js 라우트 파일(src/app 아래의 route.ts)은 HTTP 핸들러와 라우트 설정만 값으로 내보낼 수 있다.
 * 다른 값(상수·함수)을 내보내면 `next build`의 타입 검사가 "is not a valid Route export field"로 빌드를 멈추는데,
 * `tsc --noEmit`과 vitest는 이것을 보지 않는다 — 2026-11-03 앱 예약 [id] 라우트의 상수 하나로 운영 빌드가 실패했다.
 * 타입·인터페이스는 값이 아니라 괜찮다.
 */
const ALLOWED = new Set([
  'GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS',
  'dynamic', 'dynamicParams', 'revalidate', 'fetchCache', 'runtime', 'preferredRegion', 'maxDuration', 'generateStaticParams',
]);

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name === 'route.ts' || name === 'route.tsx' ? [path] : [];
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
  const files = routeFiles('src/app');
  it('라우트 파일을 실제로 찾는다', () => {
    expect(files.length).toBeGreaterThan(100);
  });
  it('핸들러·라우트 설정 밖의 값을 내보내지 않는다(next build 실패 방지)', () => {
    const violations = files.flatMap((file) => valueExports(readFileSync(file, 'utf8')).filter((n) => !ALLOWED.has(n)).map((n) => `${file}: ${n}`));
    expect(violations).toEqual([]);
  });
  it('검사가 실제로 잡는다', () => {
    expect(valueExports("export const PAUSED = 'x';\nexport async function GET() {}\nexport { handler as POST, helper };")).toEqual(['PAUSED', 'GET', 'POST', 'helper']);
  });
});
