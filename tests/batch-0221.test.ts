import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { confirmedPost } from '@/lib/confirmed-post';

/**
 * 2026-11-20 — 화면이 서버 응답을 보지 않고 '된 것처럼' 넘어가던 세 곳.
 * ① 대리 접근 복귀(`ImpersonateBanner`): 끝내기 요청이 실패해도 슈퍼관리자 포털로 이동했다 — 그 기관 관리자 로그인(쿠키)이
 *    남아 있는데 끝난 줄 안다. ② 슈퍼관리자 로그아웃(`SuperNav`): 실패해도 로그인 화면으로 이동(연결이 끊기면 처리되지 않은 오류).
 * ③ 공지 읽음(`NoticesBanner`): 저장에 실패해도 화면에서는 읽음.
 * 이제 `confirmedPost`가 참일 때만 다음으로 넘어간다.
 */

const res = (ok: boolean, body: unknown) => ({ ok, json: async () => body });

describe('confirmedPost', () => {
  it('2xx이고 몸이 ok면 참', async () => {
    const f = vi.fn(async () => res(true, { ok: true }));
    expect(await confirmedPost('/x', f)).toBe(true);
    expect(f).toHaveBeenCalledWith('/x', { method: 'POST' });
  });
  it('2xx인데 몸을 못 읽어도 참(몸 없는 성공)', async () => {
    expect(await confirmedPost('/x', async () => ({ ok: true, json: async () => { throw new Error('no body'); } }))).toBe(true);
  });
  it('5xx·4xx는 거짓', async () => {
    expect(await confirmedPost('/x', async () => res(false, { ok: false }))).toBe(false);
    expect(await confirmedPost('/x', async () => res(false, null))).toBe(false);
  });
  it('2xx여도 몸이 ok: false면 거짓', async () => {
    expect(await confirmedPost('/x', async () => res(true, { ok: false, error: { message: 'x' } }))).toBe(false);
  });
  it('연결이 끊겨도 던지지 않고 거짓', async () => {
    expect(await confirmedPost('/x', async () => { throw new TypeError('fetch failed'); })).toBe(false);
  });
});

describe('화면 (원본)', () => {
  const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

  it('대리 접근 복귀는 서버가 끝냈을 때만 이동하고, 실패는 알린다', () => {
    const src = read('src/components/admin/ImpersonateBanner.tsx');
    expect(src).not.toContain("await fetch('/api/super/impersonate/end'");
    const ok = src.indexOf("if (await confirmedPost('/api/super/impersonate/end')) {");
    const go = src.indexOf("window.location.href = '/super/organizations';");
    expect(ok).toBeGreaterThan(-1);
    expect(go).toBeGreaterThan(ok);
    expect(src.indexOf('setError(IMPERSONATION_END_FAILED);')).toBeGreaterThan(go);
    expect(src).toContain('{error && <p role="alert"');
    // 이동은 한 곳뿐 — 실패 길에서 이동하지 않는다
    expect(src.split("window.location.href = '/super/organizations'").length).toBe(2);
  });

  it('슈퍼관리자 로그아웃은 서버가 쿠키를 지웠을 때만 로그인 화면으로', () => {
    const src = read('src/components/super/SuperNav.tsx');
    expect(src).not.toContain("await fetch('/api/super/auth/logout'");
    const guard = src.indexOf("if (!(await confirmedPost('/api/super/auth/logout'))) {");
    expect(guard).toBeGreaterThan(-1);
    expect(src.indexOf('window.alert(SUPER_LOGOUT_FAILED);')).toBeGreaterThan(guard);
    expect(src.indexOf("router.push('/super/login');")).toBeGreaterThan(src.indexOf('window.alert(SUPER_LOGOUT_FAILED);'));
  });

  it('공지는 저장됐을 때만 읽음으로', () => {
    const src = read('src/components/NoticesBanner.tsx');
    expect(src).toContain('if (await confirmedPost(`/api/notices/${n.id}/read`)) setNotice(prev => prev ? { ...prev, isRead: true } : null);');
    expect(src).not.toContain("{ method: 'POST' }).catch(() => {});");
  });
});
