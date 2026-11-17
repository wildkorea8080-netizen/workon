import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { AUTH_GENERIC_MESSAGE, authErrorMessage } from '@/lib/auth-error-text';
import { DB_ERROR_FALLBACK, dbErrorCode, dbErrorText } from '@/lib/db-error-text';

/**
 * 2026-11-17 — 직원·기관 관리자가 받는 API 응답에 DB·Auth 오류 원문을 싣지 않는다. 예전엔 대화·문서 라우트가 `details: error`로
 * Supabase 오류 객체(칸·제약 이름·힌트)를, 가입이 Auth 영문 원문을, 일괄 등록이 줄마다 DB 원문을 그대로 돌려줬다.
 * 원문은 서버 기록(console·system_logs)에만. 같은 날 슈퍼관리자 라우트 26곳도 `dbErrorText`(Postgres 코드로 가른 한국어)로 바꿨다 —
 * 던지는 곳이 모두 DB 오류였고 일부러 던진 한국어 검사 문구는 없었다. 이제 `src/app/api` 전체를 본다.
 */

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (name === 'route.ts') out.push(p.replace(/\\/g, '/'));
  }
  return out;
}

const LEAKS: Array<[string, RegExp]> = [
  ['오류 객체를 details로', /\bdetails:\s*(err|error|e)\s*[},]/],
  ['원문 message를 응답 칸에', /(?<![\w])(message|error):\s*\w*(err|Err|error|Error)\??\.message\b/],
  ['instanceof Error ? 원문', /(?<![\w])(error|message):\s*\w+\s+instanceof\s+Error\s*\?\s*\w+\.message/],
  ['jsonError·NextResponse에 원문', /(jsonError|NextResponse\.json)\(.*instanceof\s+Error\s*\?\s*\w+\.message/],
];

const RESPONSE_OPEN = /NextResponse\.json\(|jsonError\(|results\.push\(/;
const LOG_OPEN = /logSystem\(|logSecurityEvent\(|writeAuditRow\(/;

/** 서버 기록(logSystem 등)의 몸 안인가 — 위 8줄 안에서 기록 호출이 응답보다 나중에 열렸으면 그렇다(원문은 서버 기록에 남겨도 된다) */
function inServerLog(lines: string[], i: number): boolean {
  for (let j = i; j >= Math.max(0, i - 8); j--) {
    if (RESPONSE_OPEN.test(lines[j])) return false;
    if (LOG_OPEN.test(lines[j])) return true;
  }
  return false;
}

function findResponseLeaks(files: string[]): string[] {
  const found: string[] = [];
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/^\s*\/\//.test(line) || /console\./.test(line) || inServerLog(lines, i)) return;
      for (const [kind, re] of LEAKS) if (re.test(line)) found.push(`${f}:${i + 1} ${kind}`);
    });
  }
  return found;
}

describe('응답에 오류 원문이 없다', () => {
  it('API 라우트 전체(슈퍼관리자 포함)', () => {
    const files = routeFiles('src/app/api');
    expect(files.filter((f) => f.includes('/api/super/')).length).toBeGreaterThan(30);
    expect(files.length).toBeGreaterThan(150);
    expect(findResponseLeaks(files)).toEqual([]);
  });
  it('찾개가 옛 꼴을 잡는다', () => {
    for (const s of [
      "{ ok: false, error: { message: '오류', details: error } },",
      "return NextResponse.json({ ok: false, error: { message: err.message } }, { status: 500 });",
      "return NextResponse.json({ ok: false, error: err.message }, { status: 500 });",
      "error: err instanceof Error ? err.message : '등록 실패',",
      "return jsonError(error instanceof Error ? error.message : '서버 오류', 500);",
    ]) expect(LEAKS.some(([, re]) => re.test(s)), s).toBe(true);
    for (const ok of [
      "...(markError ? { mark_failed: true, mark_error: markError.message } : {}),",
      "if (err instanceof AppExportTemplateError) return fail(err.message, 422);",
    ]) expect(LEAKS.some(([, re]) => re.test(ok)), ok).toBe(false);
  });
  it('서버 기록 몸 안의 원문은 괜찮고, 응답 몸 안은 잡는다', () => {
    const logBody = ['await logSystem({', "  level: 'warning',", '  details: { error: e instanceof Error ? e.message : String(e) },', '});'];
    expect(inServerLog(logBody, 2)).toBe(true);
    const resp = ['await logSystem({ x });', 'results.push({', "  error: err instanceof Error ? err.message : '실패',"];
    expect(inServerLog(resp, 2)).toBe(false);
  });
});

describe('DB 오류 문구', () => {
  it('Postgres 코드로 고칠 것을 알리고, 그 밖은 기본 문구 — 원문은 싣지 않음', () => {
    const raw = { code: '23505', message: 'duplicate key value violates unique constraint "organizations_slug_key"' };
    expect(dbErrorText(raw)).toContain('겹칩니다');
    expect(dbErrorText(raw)).not.toContain('organizations_slug_key');
    expect(dbErrorText({ code: '23503' })).toContain('연결된 기록');
    expect(dbErrorText({ code: '23514' })).toContain('허용 범위');
    expect(dbErrorText({ code: '42P01', message: 'relation "x" does not exist' })).toBe(DB_ERROR_FALLBACK);
    expect(dbErrorText(new Error('boom'), '기관을 만들지 못했습니다.')).toBe('기관을 만들지 못했습니다.');
    expect(dbErrorCode({ code: 'weak_password' })).toBeNull();
    expect(dbErrorText(null)).toBe(DB_ERROR_FALLBACK);
  });
  it('슈퍼관리자 라우트가 원문을 Error로 감싸지 않고 그대로 던진다(코드가 남게)', () => {
    for (const f of routeFiles('src/app/api/super')) {
      const s = readFileSync(f, 'utf8');
      if (!s.includes('dbErrorText(')) continue;
      expect(s, f).not.toMatch(/throw new Error\(\w+\??\.message/);
    }
  });
});

describe('Auth 오류 문구', () => {
  it('영문 원문 대신 할 수 있는 일을 알림', () => {
    expect(authErrorMessage({ message: 'A user with this email address has already been registered' })).toContain('이미 가입된 이메일');
    expect(authErrorMessage({ message: 'Email rate limit exceeded' })).toContain('몇 분 뒤');
    expect(authErrorMessage({ message: 'For security purposes, you can only request this after 30 seconds.' })).toContain('몇 분 뒤');
    expect(authErrorMessage({ message: 'Password should be at least 6 characters.' })).toContain('비밀번호');
    expect(authErrorMessage({ message: 'Unable to validate email address: invalid format' })).toContain('이메일 주소 형식');
    for (const x of [{ message: 'Database error saving new user' }, null, undefined, 5, {}]) expect(authErrorMessage(x)).toBe(AUTH_GENERIC_MESSAGE);
  });
  it('가입·일괄 등록·대화가 원문 대신 이 문구를 쓴다', () => {
    const signup = readFileSync('src/app/api/signup/route.ts', 'utf8');
    expect(signup).toContain('authErrorMessage(authErr)');
    expect(signup).toContain('authErrorMessage(signUpError)');
    expect(signup).not.toContain('process.env.');
    const bulk = readFileSync('src/app/api/admin/bulk-register/route.ts', 'utf8');
    expect(bulk).toContain("error: err instanceof RowError ? err.message : '등록하지 못했습니다.'");
    expect(bulk).not.toContain('throw new Error(insertError.message)');
    expect(readFileSync('src/app/api/chat/route.ts', 'utf8')).toContain("jsonError('서버 오류가 발생했습니다. 잠시 뒤 다시 시도해 주세요.', 500)");
  });
});
