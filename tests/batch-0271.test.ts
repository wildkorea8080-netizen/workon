import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// 0271 — 환경 변수는 config.ts를 거친다(CLAUDE.md 코딩 규칙 — 지금까지 시험이 없었다).
// 슈퍼관리자 라우트 여섯이 process.env를 직접 읽었다: 로그인(Supabase 주소·공개 키·NODE_ENV), 첫 설정(SUPER_ADMIN_SETUP_KEY),
// 대리 접근 들어가기·끝내기(NEXTAUTH_URL), 본인 비밀번호 바꾸기·로그아웃(NODE_ENV). 로그인은 config.ts의 대체 이름
// (SUPABASE_URL·SUPABASE_ANON_KEY)도 받지 못했다. 이제 config.ts의 값을 쓰고, 다시 직접 읽지 못하게 src 전체를 훑는다.

/** process.env를 직접 읽어도 되는 파일 — 까닭과 함께 */
const ALLOWED: Record<string, string> = {
  'src/lib/config.ts': '환경 변수를 읽는 한 곳',
  'src/lib/config-public.ts': '화면도 읽는 NEXT_PUBLIC_ 값 — NEXT_PUBLIC_ 이름을 그대로 적어야 브라우저 묶음에 들어간다',
  'src/lib/crypto.ts': 'config.ts는 가져오는 순간 필수 값을 요구해 암호화 도구가 따로 읽는다(2026-11-17)',
  'src/lib/super-secret.ts': '미들웨어(Edge)와 서버가 함께 쓰는 서명 비밀값 — config.ts를 Edge에 싣지 않는다',
  'src/lib/middleware-db.ts': '미들웨어(Edge)가 서비스 키로 읽는 도구 — config.ts를 Edge에 싣지 않는다',
  'src/middleware.ts': '미들웨어(Edge) — config.ts를 Edge에 싣지 않는다',
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
  });
}

describe('환경 변수', () => {
  it('src에서 process.env는 config.ts(와 까닭을 적은 몇 파일)만 읽는다', () => {
    const offenders = files('src')
      .map((p) => p.split(sep).join('/'))
      .filter((p) => !ALLOWED[p] && /process\.env\b/.test(readFileSync(p, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('슈퍼관리자 라우트는 config.ts의 값을 쓴다', () => {
    const login = readFileSync('src/app/api/super/auth/login/route.ts', 'utf8');
    expect(login).toContain("import { IS_PRODUCTION, SUPABASE_ANON_KEY, SUPABASE_URL } from '@/lib/config';");
    const setup = readFileSync('src/app/api/super/auth/setup/route.ts', 'utf8');
    expect(setup).toContain('const validSetupKey = SUPER_ADMIN_SETUP_KEY;');
    const cfg = readFileSync('src/lib/config.ts', 'utf8');
    expect(cfg).toContain("export const SUPER_ADMIN_SETUP_KEY = getEnv('SUPER_ADMIN_SETUP_KEY', false);");
    expect(cfg).toContain("export const IS_PRODUCTION = process.env.NODE_ENV === 'production';");
  });
});
