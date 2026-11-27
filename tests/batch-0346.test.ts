// tests/batch-0346.test.ts
// 시민용 민원 상담 창 — 화면·붙이기·머리글·미들웨어·관리자 화면·30일 정리(2026-11-27, 0136)
import { readFileSync } from 'fs';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { GET as embedJs } from '@/app/ask/embed.js/route';
import { embedSnippet } from '@/lib/public-ask/spec';

const read = (p: string) => readFileSync(p, 'utf8');

describe('홈페이지에 붙이기', () => {
  it('X-Frame-Options DENY는 /ask 밖에만 — 다른 화면은 그대로 막는다', () => {
    const headers = JSON.parse(read('vercel.json')).headers as { source: string; headers: { key: string; value: string }[] }[];
    const deny = headers.filter((h) => h.headers.some((x) => x.key === 'X-Frame-Options'));
    expect(deny).toHaveLength(1);
    expect(deny[0].source).toBe('/((?!ask/).*)');
    const re = /^\/((?!ask\/).*)$/;
    expect(re.test('/admin/users')).toBe(true);
    expect(re.test('/ask/test-org')).toBe(false);
  });
  it('미들웨어 — /api/ask·/ask는 로그인·기관 IP 검사 전에 지나가고, 화면에 frame-ancestors를 건다', () => {
    const mw = read('src/middleware.ts');
    const ask = mw.indexOf("pathname.startsWith('/api/ask/')");
    expect(ask).toBeGreaterThan(0);
    expect(ask).toBeLessThan(mw.indexOf('  // ── 접속 IP 제한 (0023)'));
    expect(ask).toBeGreaterThan(mw.indexOf('await checkMaintenance()')); // 점검 모드는 그대로 걸린다
    expect(mw).toContain("res.headers.set('Content-Security-Policy', await publicAskFrame(");
  });
  it('붙이는 스크립트 — org를 다듬어 그 기관 상담 화면을 iframe으로, 틀린 org는 400', async () => {
    const ok = await embedJs(new NextRequest('https://w.example/ask/embed.js?org=Test-Org'));
    expect(ok.headers.get('content-type')).toContain('javascript');
    const js = await ok.text();
    expect(js).toContain('"https://w.example/ask/test-org?embed=1"');
    expect(js).toContain("createElement('iframe')");
    expect((await embedJs(new NextRequest('https://w.example/ask/embed.js?org=<x>'))).status).toBe(400);
    expect(embedSnippet('https://w.example/', 'test-org')).toBe('<script src="https://w.example/ask/embed.js?org=test-org" async></script>');
  });
});

describe('시민 화면', () => {
  it('질문 상한·한글 조합 Enter·개인정보 안내·근거 없을 때 연락처', () => {
    const chat = read('src/components/public-ask/PublicAskChat.tsx');
    expect(chat).toContain('maxLength={PUBLIC_ASK_QUESTION_MAX}');
    expect(chat).toContain('isImeComposing(e)');
    expect(chat).toContain('개인정보는 적지 마세요');
    expect(chat).toContain("t.found === false) && <Contacts");
  });
});

describe('관리자 시민 상담', () => {
  it('설정·비서 만들기·기록은 기관 전체 관리자만, 바꾸기는 대리 접근 403', () => {
    for (const p of ['src/app/api/admin/public-ask/route.ts', 'src/app/api/admin/public-ask/agent/route.ts', 'src/app/api/admin/public-ask/logs/route.ts']) {
      expect(read(p), p).toContain('managesWholeOrganization');
    }
    expect(read('src/app/api/admin/public-ask/route.ts')).toContain('if (session.user.isImpersonating) return jsonError(');
    expect(read('src/app/api/admin/public-ask/agent/route.ts')).toContain('if (session.user.isImpersonating) return jsonError(');
    expect(read('src/app/api/admin/public-ask/logs/route.ts')).not.toContain('ip_hash');
  });
  it('메뉴·화면·30일 정리', () => {
    expect(read('src/components/admin/AdminNav.tsx')).toContain("href: '/admin/public-ask'");
    expect(read('src/app/admin/public-ask/page.tsx')).toContain('<PublicAskPanel />');
    expect(read('src/app/api/cron/app-schedules/route.ts')).toContain('purgePublicAskLogs(now)');
  });
});
