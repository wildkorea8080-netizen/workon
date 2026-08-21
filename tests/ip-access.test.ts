import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import {
  parseIpList,
  normalizeIp,
  matchesCidr,
  isIpAllowed,
  isValidIpPattern,
  clientIpFrom,
} from '../src/lib/ip-access';

/**
 * 접속 IP 제한.
 *
 * 이 판정이 틀리면 두 가지로 나빠진다. 느슨하면 **차단이 있는 척만** 하고,
 * 빡빡하면 기관 전체가 못 들어온다. 둘 다 조용히 일어나므로 여기서 고정한다.
 */

/** 헤더 흉내 */
const headers = (map: Record<string, string>) => ({
  get: (name: string) => map[name.toLowerCase()] ?? null,
});

describe('목록 파싱', () => {
  it('줄바꿈과 쉼표를 함께 받는다', () => {
    // 관리자가 어느 쪽으로 적을지 모른다
    expect(parseIpList('203.0.113.0/24\n198.51.100.7, 2001:db8::/32')).toEqual([
      '203.0.113.0/24',
      '198.51.100.7',
      '2001:db8::/32',
    ]);
  });

  it('빈 값은 빈 목록', () => {
    expect(parseIpList('')).toEqual([]);
    expect(parseIpList(null)).toEqual([]);
    expect(parseIpList('  \n , ')).toEqual([]);
  });
});

describe('주소 정규화', () => {
  it('IPv4 매핑을 IPv4로 되돌린다', () => {
    // ::ffff:1.2.3.4 를 그대로 두면 IPv4 대역과 대조되지 않는다
    expect(normalizeIp('::ffff:203.0.113.5')).toBe('203.0.113.5');
  });

  it('포트를 떼어낸다', () => {
    expect(normalizeIp('203.0.113.5:443')).toBe('203.0.113.5');
    expect(normalizeIp('[2001:db8::1]:443')).toBe('2001:db8::1');
  });

  it('IPv6의 콜론은 포트로 보지 않는다', () => {
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
  });
});

describe('대역 판정 — IPv4', () => {
  it('/24 안쪽과 바깥쪽을 가른다', () => {
    expect(matchesCidr('203.0.113.5', '203.0.113.0/24')).toBe(true);
    expect(matchesCidr('203.0.113.255', '203.0.113.0/24')).toBe(true);
    expect(matchesCidr('203.0.114.1', '203.0.113.0/24')).toBe(false);
  });

  it('바이트 경계가 아닌 접두도 센다', () => {
    // /25 는 앞 절반만. 경계를 대충 자르면 두 배 넓게 열린다.
    expect(matchesCidr('203.0.113.100', '203.0.113.0/25')).toBe(true);
    expect(matchesCidr('203.0.113.128', '203.0.113.0/25')).toBe(false);
    expect(matchesCidr('10.1.2.3', '10.0.0.0/12')).toBe(true);
    expect(matchesCidr('10.16.0.1', '10.0.0.0/12')).toBe(false);
  });

  it('접두가 없으면 주소 하나로 본다', () => {
    expect(matchesCidr('198.51.100.7', '198.51.100.7')).toBe(true);
    expect(matchesCidr('198.51.100.8', '198.51.100.7')).toBe(false);
  });

  it('/0 은 전부 허용', () => {
    expect(matchesCidr('1.2.3.4', '0.0.0.0/0')).toBe(true);
  });

  it('말이 안 되는 값은 통과시키지 않는다', () => {
    expect(matchesCidr('203.0.113.5', '203.0.113.0/33')).toBe(false);
    expect(matchesCidr('203.0.113.5', 'not-an-ip')).toBe(false);
    expect(matchesCidr('999.0.0.1', '0.0.0.0/0')).toBe(false);
    expect(matchesCidr('203.0.113.5', '')).toBe(false);
  });
});

describe('대역 판정 — IPv6', () => {
  it('축약 표기를 푼다', () => {
    expect(matchesCidr('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(matchesCidr('2001:db9::1', '2001:db8::/32')).toBe(false);
  });

  it('IPv4 매핑 주소는 IPv4 규칙에 걸린다', () => {
    expect(matchesCidr('::ffff:203.0.113.5', '203.0.113.0/24')).toBe(true);
  });

  it('계열이 다르면 맞대지 않는다', () => {
    // IPv6 주소가 IPv4 대역에 우연히 걸리면 안 된다
    expect(matchesCidr('2001:db8::1', '0.0.0.0/0')).toBe(false);
    expect(matchesCidr('203.0.113.5', '::/0')).toBe(false);
  });
});

describe('허용 여부', () => {
  const list = ['203.0.113.0/24', '198.51.100.7'];

  it('목록에 들면 통과', () => {
    expect(isIpAllowed('203.0.113.9', list)).toBe(true);
    expect(isIpAllowed('198.51.100.7', list)).toBe(true);
  });

  it('목록 밖이면 막는다', () => {
    expect(isIpAllowed('8.8.8.8', list)).toBe(false);
  });

  it('목록이 비면 허용한다', () => {
    // 이 기능을 켠 적 없는 기관까지 잠그면 안 된다
    expect(isIpAllowed('8.8.8.8', [])).toBe(true);
  });

  it('IP를 모르면 허용한다', () => {
    // 판정할 근거가 없을 때 막으면 헤더가 다른 환경 하나가 기관을 잠근다.
    // IP 제한은 인증 위에 얹는 두 번째 층이지 인증 자체가 아니다.
    expect(isIpAllowed(null, list)).toBe(true);
  });
});

describe('클라이언트 IP 판별', () => {
  it('플랫폼이 준 값을 가장 먼저 쓴다', () => {
    // 여기가 가장 틀리기 쉬운 자리다. x-forwarded-for를 그냥 믿으면
    // 누구나 헤더 한 줄로 제한을 넘는다.
    const ip = clientIpFrom(
      headers({ 'x-forwarded-for': '203.0.113.9' }),
      '8.8.8.8'
    );
    expect(ip).toBe('8.8.8.8');
  });

  it('플랫폼 값이 없으면 Vercel 헤더를 본다', () => {
    const ip = clientIpFrom(
      headers({
        'x-vercel-forwarded-for': '198.51.100.7',
        'x-forwarded-for': '203.0.113.9',
      }),
      null
    );
    expect(ip).toBe('198.51.100.7');
  });

  it('마지막 수단으로 x-forwarded-for의 첫 항목', () => {
    const ip = clientIpFrom(headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }), null);
    expect(ip).toBe('203.0.113.9');
  });

  it('아무것도 없으면 null', () => {
    expect(clientIpFrom(headers({}), null)).toBeNull();
  });
});

describe('입력 검증', () => {
  it('맞는 형식을 받는다', () => {
    for (const p of ['203.0.113.0/24', '198.51.100.7', '2001:db8::/32', '::1']) {
      expect(isValidIpPattern(p), p).toBe(true);
    }
  });

  it('틀린 형식을 거른다', () => {
    // 관리자가 오타를 내면 저장 전에 알려야 한다. 저장돼 버리면
    // 그 항목만 조용히 아무에게도 안 맞는다.
    for (const p of ['203.0.113.0/33', '999.1.1.1', '사무실', '10.0.0.0/', '']) {
      expect(isValidIpPattern(p), p).toBe(false);
    }
  });
});

describe('실제로 걸리는 자리', () => {
  const mw = readFileSync('src/middleware.ts', 'utf8');

  it('미들웨어가 API도 검사한다', () => {
    // 예전 matcher는 /api를 빼고 있었다. 그대로 두면 화면만 막히고
    // /api/chat은 밖에서 그대로 불린다 — 차단이 있는 것처럼 보이지만
    // 실제로는 없는, 이 기능을 만들게 된 바로 그 상태다.
    const start = mw.indexOf('export const config');
    const block = mw.slice(start);
    expect(block).toContain("'/api/:path*'");
  });

  it('판정은 공용 순수 함수를 쓴다', () => {
    // 판정이 두 벌이면 한쪽만 고쳐져 화면과 API가 어긋난다
    expect(mw).toContain("from '@/lib/ip-access'");
    expect(mw).toContain('isIpAllowed');
    expect(mw).toContain('clientIpFrom');
  });

  /** 실제 차단이 일어나는 블록 */
  const gate = (() => {
    const at = mw.indexOf('!isIpAllowed(ip, allowed)');
    return at === -1 ? '' : mw.slice(Math.max(0, at - 2000), at + 2000);
  })();

  it('슈퍼관리자 경로는 제외한다', () => {
    // 대역을 잘못 적어 기관이 잠겼을 때 되돌릴 통로가 하나는 남아야 한다
    expect(gate).not.toBe('');
    expect(gate).toContain("!pathname.startsWith('/super')");
  });

  it('API에는 리디렉션 대신 403 JSON을 준다', () => {
    // fetch가 로그인 HTML을 받으면 "알 수 없는 오류"가 된다
    expect(gate).toContain('status: 403');
    expect(gate).toContain("pathname.startsWith('/api')");
  });

  it('차단 기록 라우트가 부르는 쪽을 믿지 않는다', () => {
    // 재판정 없이 기록하면 아무나 감사 기록을 가짜로 채울 수 있다
    const log = readFileSync('src/app/api/access-denied/route.ts', 'utf8');
    expect(log).toContain('isIpAllowed');
    expect(log).toContain('ip_blocked');
  });
});
