// tests/batch-0341.test.ts
// 메일 실패를 운영 기록에(2026-11-27, 운영에서 찾음) — 보내는 도메인이 인증되지 않아 운영 메일이 모두 실패했는데
// 함수 로그(받는 사람 주소까지)에만 남아 슈퍼관리자 화면 어디에도 보이지 않았다.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logs: Array<Record<string, unknown>> = [];
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn(async (p: Record<string, unknown>) => { logs.push(p); }) }));
vi.mock('@/lib/config', () => ({ APP_NAME: 'WORKON', MAIL_FROM: 'noreply@example.com', RESEND_API_KEY: 're_test' }));

import { isMailConfigFailure, mailErrorText, sendTempPasswordEmail } from '@/lib/mailer';

const send = () => sendTempPasswordEmail({ to: 'staff@agency.go.kr', fullName: '홍길동', tempPassword: 'x', loginUrl: 'https://w.example/login' });

describe('메일 실패 기록', () => {
  beforeEach(() => { logs.length = 0; vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-27T00:00:00Z')); });

  it('설정 문제(도메인 미인증 403)는 critical로, 받는 사람 주소 없이, 10분에 한 번', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ name: 'validation_error', message: 'The gmail.com domain is not verified. staff@agency.go.kr' }), { status: 403 })));
    expect(await send()).toMatchObject({ sent: false, reason: 'send_failed' });
    await send();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: 'critical', category: 'api' });
    expect(JSON.stringify(logs[0])).not.toContain('staff@agency.go.kr');
    expect(JSON.stringify(logs[0])).toContain('gmail.com domain is not verified');
    vi.setSystemTime(new Date('2026-11-27T00:11:00Z'));
    await send();
    expect(logs).toHaveLength(2);
  });

  it('그 밖의 실패(5xx·연결 끊김)는 error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    await send();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNRESET'); }));
    await send();
    expect(logs.map((l) => l.level)).toEqual(['error', 'error']);
  });

  it('꼴', () => {
    expect([401, 403, 422].every(isMailConfigFailure)).toBe(true);
    expect(isMailConfigFailure(500)).toBe(false);
    expect(isMailConfigFailure(null)).toBe(false);
    expect(mailErrorText('to a.b@c.kr failed')).toBe('to (주소) failed');
  });
});
