// tests/batch-0347.test.ts
// 미들웨어 마지막 matcher(2026-11-27) — 문자열 속 '\.'이 '.'이 되어 `.*..*`를 빼는 바람에 '/' 하나에만 맞았다.
// 그래서 /chat·/apps 같은 직원 화면에 기관 접속 허용 IP·세션 끝내기가 걸리지 않았다(API·/admin·/super는 걸림).
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-auth/jwt', () => ({ getToken: async () => null }));

describe('미들웨어 matcher', () => {
  it('마지막 줄은 점(.)이 든 파일 주소만 빼고 화면 주소에 맞는다', async () => {
    const { config } = await import('@/middleware');
    const last = config.matcher[config.matcher.length - 1];
    expect(last).toBe('/((?!_next|api|static|.*\\..*).*)');
    // Next가 matcher를 정규식으로 바꾸는 꼴과 같게 — 괄호 속 정규식 그대로
    const re = new RegExp('^' + last + '$');
    for (const p of ['/chat', '/apps/run', '/tasks/abc', '/my/password', '/']) expect(re.test(p), p).toBe(true);
    for (const p of ['/_next/static/x.js', '/api/chat', '/favicon.ico', '/static/a', '/ask/embed.js']) expect(re.test(p), p).toBe(false);
  });
});

describe('알리웍스 core 앱 여섯(2026-11-27)', () => {
  it('FAQ·계약서는 파일이 꼭 필요하고, 채용공고는 할 일에 따라 조건부 필수·초안 단계만 조건, 나머지는 입력만', async () => {
    const { PUBLIC_SECTOR_FORM_PRESETS } = await import('@/lib/agent-presets');
    const { renderAppInput } = await import('@/lib/apps/definition');
    const by = (n: string) => PUBLIC_SECTOR_FORM_PRESETS.find((p) => p.name === n)!.appDefinition!;
    expect(by('문서로 FAQ 만들기').attachments).toEqual({ required: true });
    expect(by('계약서 조항 검토').attachments).toEqual({ required: true });
    for (const n of ['주간보고 종합', '설문 문항 만들기', '채용공고 작성·점검', '회의 안건 정리']) expect(by(n).attachments, n).toBeUndefined();
    const hire = by('채용공고 작성·점검');
    expect(hire.steps?.[0].when).toEqual({ all: [{ field: 'task', op: 'equals', value: '공고 초안 작성' }] });
    expect(renderAppInput(hire, { task: '기존 공고 점검', job: '시설관리 직원' }).ok).toBe(false); // 점검할 공고문이 없으면
    expect(renderAppInput(hire, { task: '기존 공고 점검', job: '시설관리 직원', existing: '모집 공고 …' }).ok).toBe(true);
  });
});
