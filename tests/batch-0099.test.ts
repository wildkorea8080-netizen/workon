import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { decideSignIn } from '@/lib/sign-in-user';

/**
 * 2026-11-12 — 로그인이 소속을 추측하지 않는다.
 * 예전 로그인은 Supabase Auth를 통과한 계정에 users 행이 없거나 부서가 비면 가장 오래된 부서(어느 기관이든)를 배정했고,
 * 하드코딩한 이메일 둘은 관리자로 만들었다. Supabase 공개 가입이 켜져 있어 바깥 사람이 첫 기관 직원이 되는 길이었다.
 */

describe('decideSignIn', () => {
  it('행·부서가 있으면 그 부서와 역할로', () => {
    expect(decideSignIn({ id: 'u1', role: 'admin', department_id: 'd1', full_name: '홍길동' }, false))
      .toEqual({ ok: true, role: 'ADMIN', departmentId: 'd1', name: '홍길동' });
    expect(decideSignIn({ id: 'u1', role: null, department_id: 'd1', email: 'a@b.kr' }, false))
      .toEqual({ ok: true, role: 'USER', departmentId: 'd1', name: 'a@b.kr' });
    expect(decideSignIn({ id: 'u1', role: 'SUPER', department_id: 'd1' }, false)).toMatchObject({ ok: true, role: 'USER' });
  });
  it('행이 없거나·읽지 못했거나·부서가 비면 들이지 않는다(배정하지 않음)', () => {
    expect(decideSignIn(null, false)).toEqual({ ok: false, reason: 'no_user_row' });
    expect(decideSignIn(null, true)).toEqual({ ok: false, reason: 'lookup_failed' });
    expect(decideSignIn({ id: 'u1', role: 'ADMIN', department_id: 'd1' }, true)).toEqual({ ok: false, reason: 'lookup_failed' });
    expect(decideSignIn({ id: 'u1', role: 'ADMIN', department_id: null }, false)).toEqual({ ok: false, reason: 'no_department' });
    expect(decideSignIn({ id: 'u1', department_id: '' }, false)).toEqual({ ok: false, reason: 'no_department' });
  });
});

describe('연결(원본)', () => {
  const src = readFileSync('src/lib/nextAuthOptions.ts', 'utf8');
  it('가장 오래된 부서 배정·하드코딩 관리자·로그인 때 users 행 만들기가 돌아오지 않는다', () => {
    expect(src).not.toMatch(/getDefaultDepartmentId|assignDefaultDepartmentToUser|ADMIN_EMAILS|admin-team/);
    expect(src).not.toMatch(/from\('users'\)\s*\.(insert|update|upsert)\(/);
    expect(src).not.toMatch(/from\('departments'\)/);
  });
  it('두 로그인 경로(Supabase Auth·password_hash) 모두 decideSignIn을 거친다', () => {
    expect(src.match(/decideSignIn\(/g)).toHaveLength(2);
  });
  it('가입 라우트도 하드코딩 관리자·전체에서 가장 오래된 부서를 쓰지 않는다', () => {
    const signup = readFileSync('src/app/api/signup/route.ts', 'utf8');
    expect(signup).not.toMatch(/ADMIN_EMAILS/);
    expect(signup).toMatch(/\.from\('departments'\)\s*\.select\('id, parent_id'\)\s*\.eq\('organization_id', org\.id\)/);
  });
});
