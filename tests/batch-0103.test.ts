import { readFileSync } from 'fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));

import {
  IP_FAILURES, LOCK_FAILURES, LOCK_WINDOW_MS, ipKey, noteSignInFailure, noteSignInSuccess, requestIp, signInAllowed, signInKey,
  type ThrottleDeps,
} from '@/lib/sign-in-throttle';
import { ACCOUNT_LOCKED, LOCKED_MESSAGE } from '@/lib/sign-in-lock-spec';

/** 2026-11-13 — 로그인 실패 잠금(0091). 예전에는 비밀번호를 끝없이 맞춰 볼 수 있었다 */

function deps(counts: { key?: number | null; ip?: number | null } = {}) {
  const calls: { field: string; since: string }[] = [];
  const d: ThrottleDeps = {
    countFailures: vi.fn(async (_s, field, _v, since) => { calls.push({ field, since }); return field === 'key_hash' ? (counts.key ?? 0) : (counts.ip ?? 0); }),
    recordFailure: vi.fn(async () => {}),
    clearFailures: vi.fn(async () => {}),
  };
  return { d, calls };
}

describe('잠금 판정', () => {
  it('계정 실패가 30분 안에 5번 미만이면 받고, 5번이면 잠근다', async () => {
    expect(await signInAllowed(deps({ key: LOCK_FAILURES - 1 }).d, 'user', 'a@b.kr', null)).toBe(true);
    expect(await signInAllowed(deps({ key: LOCK_FAILURES }).d, 'user', 'a@b.kr', null)).toBe(false);
    expect(LOCK_FAILURES).toBe(5);
    expect(LOCK_WINDOW_MS).toBe(30 * 60_000);
  });
  it('IP 실패가 30번이면 막고, IP를 모르면 IP는 보지 않는다', async () => {
    expect(await signInAllowed(deps({ ip: IP_FAILURES }).d, 'user', 'a@b.kr', '1.2.3.4')).toBe(false);
    const { d, calls } = deps({ ip: IP_FAILURES });
    expect(await signInAllowed(d, 'user', 'a@b.kr', null)).toBe(true);
    expect(calls.map((c) => c.field)).toEqual(['key_hash']);
  });
  it('30분 창으로 센다', async () => {
    const { d, calls } = deps();
    await signInAllowed(d, 'super', 'a@b.kr', '1.2.3.4', Date.parse('2026-11-13T10:00:00Z'));
    expect(calls[0].since).toBe('2026-11-13T09:30:00.000Z');
  });
  it('실패 기록을 못 읽으면 막지 않는다(열림) — DB가 흔들려 모두 못 들어오면 안 된다', async () => {
    expect(await signInAllowed(deps({ key: null, ip: null }).d, 'user', 'a@b.kr', '1.2.3.4')).toBe(true);
    const thrower: ThrottleDeps = { countFailures: async () => { throw new Error('db'); }, recordFailure: async () => {}, clearFailures: async () => {} };
    expect(await signInAllowed(thrower, 'user', 'a@b.kr', '1.2.3.4')).toBe(true);
  });
  it('기록·지우기 실패는 로그인을 막지 않는다(던지지 않음)', async () => {
    const bad: ThrottleDeps = { countFailures: async () => 0, recordFailure: async () => { throw new Error('x'); }, clearFailures: async () => { throw new Error('x'); } };
    await expect(noteSignInFailure(bad, 'user', 'a@b.kr', null)).resolves.toBeUndefined();
    await expect(noteSignInSuccess(bad, 'user', 'a@b.kr')).resolves.toBeUndefined();
  });
  it('이메일은 대소문자·공백을 맞춘 해시만, IP도 해시', () => {
    expect(signInKey(' A@B.kr ')).toBe(signInKey('a@b.kr'));
    expect(signInKey('a@b.kr')).toMatch(/^[0-9a-f]{64}$/);
    expect(signInKey('a@b.kr')).not.toContain('a@b');
    expect(ipKey('1.2.3.4')).toMatch(/^[0-9a-f]{64}$/);
    expect(ipKey(null)).toBeNull();
  });
  it('NextAuth 머리글(평범한 객체)·Headers 둘 다에서 IP', () => {
    expect(requestIp({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' })).toBe('1.2.3.4');
    expect(requestIp({ 'x-vercel-forwarded-for': '5.6.7.8', 'x-forwarded-for': '1.2.3.4' })).toBe('5.6.7.8');
    expect(requestIp(new Headers({ 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9');
    expect(requestIp(undefined)).toBeNull();
  });
});

describe('연결(원본)', () => {
  it('직원 로그인 — 잠겼으면 비밀번호를 보기 전에 던지고, 틀리면 세고, 맞으면 지운다', () => {
    const src = readFileSync('src/lib/nextAuthOptions.ts', 'utf8');
    const gate = src.indexOf("if (!(await signInAllowed(throttle, 'user', credentials.email, ip)))");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(src.indexOf('supabase.auth.signInWithPassword('));
    expect(src).toContain('throw new Error(ACCOUNT_LOCKED);');
    expect(src).toContain("else await noteSignInFailure(throttle, 'user', credentials.email, ip);");
    expect(src.match(/noteSignInSuccess\(throttle, 'user', credentials\.email\)/g)).toHaveLength(2);
  });
  it('슈퍼관리자 로그인 — 잠기면 429, 틀리면 세고, 다 통과하면 지운다', () => {
    const src = readFileSync('src/app/api/super/auth/login/route.ts', 'utf8');
    expect(src.indexOf("signInAllowed(throttle, 'super', normalizedEmail, ip)")).toBeLessThan(src.indexOf('signInWithPassword('));
    expect(src).toContain('{ ok: false, error: LOCKED_MESSAGE }, { status: 429 }');
    expect(src).toContain("await noteSignInFailure(throttle, 'super', normalizedEmail, ip);");
    expect(src.indexOf("await noteSignInSuccess(throttle, 'super', normalizedEmail);")).toBeLessThan(src.indexOf('signSuperJWT('));
  });
  it('로그인 화면은 잎 파일만 읽고(서버 모듈 없이) 잠김 안내를 보인다', () => {
    const form = readFileSync('src/components/auth/LoginForm.tsx', 'utf8');
    expect(form).toContain("from '@/lib/sign-in-lock-spec'");
    expect(form).not.toContain("from '@/lib/sign-in-throttle'");
    expect(form).toContain('res.error === ACCOUNT_LOCKED ? LOCKED_MESSAGE');
    expect(readFileSync('src/lib/sign-in-lock-spec.ts', 'utf8')).not.toMatch(/^import /m);
    expect(ACCOUNT_LOCKED).toBe('ACCOUNT_LOCKED');
    expect(LOCKED_MESSAGE).toContain('30분');
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('0091 로그인 실패 기록 (시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
    const sql = readFileSync('supabase/migrations/0091_sign_in_failures.sql', 'utf8');
    await db.query(sql);
    await db.query(sql);
  });
  afterAll(async () => { await db?.end(); });
  it('해시 꼴만 받고, RLS가 켜져 있고, 공개 키 역할은 권한이 없다', async () => {
    await db.query('BEGIN');
    try {
      const h = 'a'.repeat(64);
      await db.query("INSERT INTO sign_in_failures (scope, key_hash, ip_hash) VALUES ('user', $1, NULL)", [h]);
      await expect(db.query("INSERT INTO sign_in_failures (scope, key_hash) VALUES ('user', 'a@b.kr')")).rejects.toMatchObject({ code: '23514' });
    } finally { await db.query('ROLLBACK'); }
    await db.query('BEGIN');
    try {
      await expect(db.query("INSERT INTO sign_in_failures (scope, key_hash) VALUES ('admin', $1)", ['b'.repeat(64)])).rejects.toMatchObject({ code: '23514' });
    } finally { await db.query('ROLLBACK'); }
    const rls = await db.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'sign_in_failures'");
    expect(rls.rows[0].relrowsecurity).toBe(true);
    const roles = await db.query("SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated')");
    for (const r of roles.rows as { rolname: string }[]) {
      const p = await db.query(`SELECT has_table_privilege($1, 'public.sign_in_failures', 'SELECT') s, has_table_privilege($1, 'public.sign_in_failures', 'INSERT') i`, [r.rolname]);
      expect(p.rows[0]).toEqual({ s: false, i: false });
    }
  });
});
