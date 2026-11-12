import { readFileSync } from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { constantTimeEqual, SUPER_JWT_DEV_FALLBACK, superJwtSecret } from '@/lib/super-secret';
import { signSuperJWT, verifySuperJWT } from '@/lib/super-auth';

/**
 * 2026-11-13 — 슈퍼관리자 인증.
 * ① 설정(`/api/super/auth/setup`)의 '슈퍼관리자가 이미 있으면 막기'가 maybeSingle()이라 둘 이상이면 열렸다(운영은 둘)
 * ② 비활성화한 슈퍼관리자가 계속 로그인됐다(로그인이 is_active를 보지 않음)
 * ③ SUPER_JWT_SECRET이 비면 소스에 적힌 고정 값으로 서명·검증했다(운영에서도)
 */

afterEach(() => vi.unstubAllEnvs());

describe('서명 비밀값', () => {
  it('값이 있으면 그 값, 운영에서 비면 null, 개발·시험에서만 고정 값', () => {
    expect(superJwtSecret({ SUPER_JWT_SECRET: 's3cret', NODE_ENV: 'production' })).toBe('s3cret');
    expect(superJwtSecret({ SUPER_JWT_SECRET: '', NODE_ENV: 'production' })).toBeNull();
    expect(superJwtSecret({ NODE_ENV: 'production' })).toBeNull();
    expect(superJwtSecret({ NODE_ENV: 'development' })).toBe(SUPER_JWT_DEV_FALLBACK);
    expect(superJwtSecret({ NODE_ENV: 'test' })).toBe(SUPER_JWT_DEV_FALLBACK);
  });
  it('같은 시간 비교', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});

describe('토큰', () => {
  it('맞는 토큰은 받고, 고친 토큰은 거절', () => {
    vi.stubEnv('SUPER_JWT_SECRET', 'unit-secret');
    const token = signSuperJWT('u1', 'a@b.kr', '관리자');
    expect(verifySuperJWT(token)).toMatchObject({ sub: 'u1' });
    const [h, p, s] = token.split('.');
    expect(verifySuperJWT(`${h}.${p}.${s.slice(0, -1)}${s.endsWith('A') ? 'B' : 'A'}`)).toBeNull();
  });
  it('운영에서 비밀값이 없으면 고정 값으로 만든 토큰도 거절하고, 새로 서명하지 않는다', () => {
    vi.stubEnv('SUPER_JWT_SECRET', '');
    vi.stubEnv('NODE_ENV', 'development');
    const forged = signSuperJWT('u1', 'a@b.kr', '관리자'); // 고정 값으로 만든 토큰
    vi.stubEnv('NODE_ENV', 'production');
    expect(verifySuperJWT(forged)).toBeNull();
    expect(() => signSuperJWT('u1', 'a@b.kr', '관리자')).toThrow('SUPER_JWT_SECRET');
  });
});

describe('연결(원본)', () => {
  it('설정 — 슈퍼관리자 수를 세고(maybeSingle 아님), 세지 못하면 닫는다', () => {
    const src = readFileSync('src/app/api/super/auth/setup/route.ts', 'utf8');
    expect(src).toMatch(/select\('id', \{ count: 'exact', head: true \}\)\s*\.eq\('is_super_admin', true\);/);
    expect(src).not.toMatch(/\.eq\('is_super_admin', true\)\s*\.maybeSingle\(\)/);
    expect(src).toContain('if (countError || superCount === null)');
    expect(src).toContain('constantTimeEqual(setupKey, validSetupKey)');
  });
  it('로그인 — 비활성·삭제 슈퍼관리자는 들이지 않는다', () => {
    const src = readFileSync('src/app/api/super/auth/login/route.ts', 'utf8');
    expect(src).toContain("select('id, email, full_name, is_super_admin, is_active, deleted_at')");
    expect(src).toContain('if (userError || !user || !canSignIn(user))');
  });
  it('미들웨어·서버 어디에도 고정 값을 직접 쓰지 않는다', () => {
    for (const f of ['src/middleware.ts', 'src/lib/super-auth.ts']) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toContain('dev-fallback-super-secret');
      expect(src, f).not.toMatch(/process\.env\.SUPER_JWT_SECRET \|\|/);
    }
  });
});
