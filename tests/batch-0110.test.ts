import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { MY_SIGN_INS_DAYS, MY_SIGN_INS_LIMIT, deviceLabel, recentFailures, type MySignIn } from '@/lib/my-sign-ins-spec';

/** 2026-11-16 — 직원이 자기 최근 로그인(성공·실패)을 본다. 내가 하지 않은 로그인을 스스로 알아채게 */

describe('기기 이름', () => {
  it('운영체제 · 브라우저', () => {
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')).toBe('윈도우 · 크롬');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0')).toBe('윈도우 · 엣지');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/128.0 Whale/3.28 Safari/537.36')).toBe('윈도우 · 웨일');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1')).toBe('iOS · 사파리');
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36')).toBe('안드로이드 · 삼성 인터넷');
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Gecko/20100101 Firefox/131.0')).toBe('맥 · 파이어폭스');
  });
  it('모르면 알 수 없는 기기', () => {
    expect(deviceLabel(null)).toBe('알 수 없는 기기');
    expect(deviceLabel('curl/8.0')).toBe('알 수 없는 기기');
  });
});

describe('최근 실패 수', () => {
  const now = Date.parse('2026-11-16T10:00:00Z');
  const at = (days: number) => new Date(now - days * 86_400_000).toISOString();
  it('30일 안의 틀림·잠김만', () => {
    const list: MySignIn[] = [
      { at: at(1), action: 'login_failed', ip: null, device: '' },
      { at: at(2), action: 'login_locked', ip: null, device: '' },
      { at: at(3), action: 'login', ip: null, device: '' },
      { at: at(4), action: 'login_rejected', ip: null, device: '' },
      { at: at(31), action: 'login_failed', ip: null, device: '' },
    ];
    expect(recentFailures(list, now)).toBe(2);
  });
});

describe('연결(원본)', () => {
  it('라우트 — 세션 본인만·대리 접근 막음·90일·30건·짧은 기기 이름만', () => {
    const src = readFileSync('src/app/api/my/sign-ins/route.ts', 'utf8');
    expect(src).toContain(".eq('user_id', session.user.id)");
    expect(src).toContain('if (session.user.isImpersonating)');
    expect(src).toContain('.limit(MY_SIGN_INS_LIMIT)');
    expect(src).toContain('device: deviceLabel(r.user_agent)');
    expect(src).not.toMatch(/user_agent: r\.user_agent/);
    expect(MY_SIGN_INS_DAYS).toBe(90);
    expect(MY_SIGN_INS_LIMIT).toBe(30);
  });
  it('화면 — 비밀번호 화면 아래, 임시 비밀번호로 묶인 동안은 숨김, 잎 파일만', () => {
    const page = readFileSync('src/app/my/password/page.tsx', 'utf8');
    expect(page).toContain('{!required && <MySignIns />}');
    const comp = readFileSync('src/components/my/MySignIns.tsx', 'utf8');
    expect(comp).toContain("requestJson('/api/my/sign-ins')"); // 0267부터 던지지 않는 requestJson
    expect(comp).toContain("from '@/lib/my-sign-ins-spec'");
    expect(readFileSync('src/lib/my-sign-ins-spec.ts', 'utf8')).not.toMatch(/^import /m);
    expect(readFileSync('src/components/layout/UserMenu.tsx', 'utf8')).toContain('>비밀번호·로그인 기록</Link>');
  });
});
