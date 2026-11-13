import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { clientIpFrom, isIpAllowed } from '@/lib/ip-access';
import { superJwtSecret } from '@/lib/super-secret';
import { readIpPolicy, readMaintenance, readSuperAdminStatus, restConfig, superAdminActive, superTokenSub } from '@/lib/middleware-db';

const NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? '';

const PUBLIC_FILE = /\.(.*)$/;
const SUPER_COOKIE = 'super_token';

// 점검 모드 캐시 (Edge Runtime 모듈 레벨, 30초 TTL)
let maintenanceCache: { value: boolean; message: string; ts: number } | null = null;
const CACHE_TTL = 30_000;

async function checkMaintenance(): Promise<{ on: boolean; message: string }> {
  if (maintenanceCache && Date.now() - maintenanceCache.ts < CACHE_TTL) {
    return { on: maintenanceCache.value, message: maintenanceCache.message };
  }
  // 서비스 키로 읽는다(2026-11-13, `middleware-db.ts`) — 공개 키로는 RLS 때문에 언제나 0행이라 점검 모드가 걸린 적이 없었다
  const read = await readMaintenance(restConfig(), fetch);
  if (read.ok) maintenanceCache = { value: read.on, message: read.message, ts: Date.now() };
  return { on: read.on, message: read.message };
}

// ── 접속 IP 제한 (0023) ─────────────────────────────────────
//
// 판정 자체는 src/lib/ip-access.ts의 순수 함수가 한다. 여기서는 "이 사용자의
// 기관이 어떤 대역을 허용하는가"만 가져온다.
//
// 미들웨어는 요청마다 돈다. 그래서 **제한을 켠 기관이 하나라도 있는지**를
// 먼저 보고, 없으면 거기서 끝낸다 — 이 기능을 쓰지 않는 배포에서는 30초에
// 한 번 작은 조회 하나가 전부다.
let ipCache: { byDept: Map<string, string[]>; ts: number } | null = null;

async function allowedIpsForDepartment(departmentId: string | null): Promise<string[]> {
  if (!departmentId) return [];

  if (!ipCache || Date.now() - ipCache.ts >= CACHE_TTL) {
    ipCache = { byDept: await loadIpPolicy(), ts: Date.now() };
  }
  return ipCache.byDept.get(departmentId) ?? [];
}

// 서비스 키로 읽는다(2026-11-13, `middleware-db.ts`) — 공개 키로는 RLS 때문에 기관이 0행이라 접속 허용 IP가 걸린 적이 없었다.
// 조회 실패는 "제한 없음"으로 떨어진다(IP 제한은 인증 위에 얹는 두 번째 층 — 부서 범위·커넥터 범위는 반대로 닫는다).
async function loadIpPolicy(): Promise<Map<string, string[]>> {
  return readIpPolicy(restConfig(), fetch);
}

// 슈퍼관리자 계정이 지금도 활성인가(2026-11-13) — 토큰은 24시간이라 비활성화해도 만료까지 쓰이던 공백을 닫는다
const superStatusCache = new Map<string, { active: boolean; at: number }>();
async function superTokenActive(token: string): Promise<boolean> {
  if (!(await verifySuperTokenEdge(token))) return false;
  return superAdminActive(superStatusCache, superTokenSub(token), (sub) => readSuperAdminStatus(restConfig(), sub, fetch));
}

/**
 * Edge Runtime 호환 JWT 서명 검증 (Web Crypto API)
 */
// 운영에서 SUPER_JWT_SECRET이 비면 거절한다(2026-11-13 — 예전에는 소스에 적힌 고정 값으로 검증해 누구나 토큰을 만들 수 있었다)
async function verifySuperTokenEdge(token: string): Promise<boolean> {
  try {
    const secret = superJwtSecret();
    if (!secret) return false;

    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [header, payload, sig] = parts;

    // 서명 검증
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const sigBytes = Uint8Array.from(
      atob(sig.replace(/-/g, '+').replace(/_/g, '/')),
      c => c.charCodeAt(0)
    );
    const data = new TextEncoder().encode(`${header}.${payload}`);
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, data);
    if (!valid) return false;

    // 만료 검증
    const decoded = JSON.parse(
      atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    );
    return decoded.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // ── 점검 모드 체크 (/super, /maintenance, /api/super, /api/system은 제외) ──
  const isExempt =
    pathname.startsWith('/super') ||
    pathname.startsWith('/maintenance') ||
    pathname.startsWith('/api/super') ||
    pathname.startsWith('/api/system') ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api/auth') ||
    PUBLIC_FILE.test(pathname);

  if (!isExempt) {
    const { on: isMaintenance } = await checkMaintenance();
    if (isMaintenance) {
      // 슈퍼관리자 토큰 있으면 통과
      const superToken = req.cookies.get(SUPER_COOKIE)?.value;
      const isSuperAdmin = superToken ? await superTokenActive(superToken) : false;
      if (!isSuperAdmin) {
        // API에 리디렉션을 주면 fetch가 점검 안내 HTML을 받아 "알 수 없는
        // 오류"가 된다. matcher에 /api를 넣으면서 이 경로가 처음으로
        // 점검 모드에 걸리게 됐으므로 함께 처리한다.
        if (pathname.startsWith('/api')) {
          return NextResponse.json(
            { ok: false, error: { message: '서비스 점검 중입니다. 잠시 후 다시 시도해주세요.' } },
            { status: 503 }
          );
        }
        return NextResponse.redirect(new URL('/maintenance', req.url));
      }
    }
  }

  // 정적 파일, Next.js 내부 경로 통과
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/api/super/auth') ||
    pathname.startsWith('/static') ||
    PUBLIC_FILE.test(pathname)
  ) {
    return NextResponse.next();
  }

  // ── 슈퍼관리자 API(2026-11-13) — 서명이 맞는 토큰이어도 비활성화·삭제된 슈퍼관리자면 막는다.
  // 라우트의 getSuperAdminFromRequest는 서명만 보므로(DB를 안 봄) 여기서 계정 상태를 한 번 더 본다.
  // 토큰이 없거나 서명이 틀리면 라우트가 401로 막으니 그대로 넘긴다.
  if (pathname.startsWith('/api/super')) {
    const superToken = req.cookies.get(SUPER_COOKIE)?.value;
    if (superToken && (await verifySuperTokenEdge(superToken)) && !(await superTokenActive(superToken))) {
      const res = NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });
      res.cookies.set({ name: SUPER_COOKIE, value: '', maxAge: 0, path: '/' });
      return res;
    }
    return NextResponse.next();
  }

  // ── 접속 IP 제한 (0023) ───────────────────────────────────
  //
  // 슈퍼관리자 경로는 제외한다. 관리자가 대역을 잘못 적어 기관 전체가
  // 잠겼을 때 **되돌릴 통로가 하나는 남아야** 하기 때문이다. 슈퍼관리자는
  // 별도 인증(super_token)을 쓰고 기관에 속하지 않는다.
  //
  // 인증되지 않은 요청도 제외한다. 소속 기관을 알 수 없어 판정할 근거가
  // 없고, 어차피 그다음 인증 검사에서 막힌다.
  if (!pathname.startsWith('/super') && !pathname.startsWith('/blocked')) {
    const ipToken = await getToken({ req, secret: NEXTAUTH_SECRET });
    const ipDeptId = (ipToken?.departmentId as string | null | undefined) ?? null;

    if (ipToken?.sub && ipDeptId) {
      const allowed = await allowedIpsForDepartment(ipDeptId);
      if (allowed.length > 0) {
        const ip = clientIpFrom(req.headers, req.ip);
        if (!isIpAllowed(ip, allowed)) {
          // API는 되돌려 보낼 화면이 없다. 리디렉션을 주면 fetch가 로그인
          // HTML을 받아 "알 수 없는 오류"가 된다.
          if (pathname.startsWith('/api')) {
            return NextResponse.json(
              {
                ok: false,
                error: {
                  message:
                    '기관이 허용한 네트워크에서만 이용할 수 있습니다. 기관 내부망에서 접속해주세요.',
                },
              },
              { status: 403 }
            );
          }
          const url = req.nextUrl.clone();
          url.pathname = '/blocked';
          url.search = '';
          if (ip) url.searchParams.set('ip', ip);
          return NextResponse.redirect(url);
        }
      }
    }
  }

  // ── 슈퍼관리자 경로 ───────────────────────────────────────
  if (pathname.startsWith('/super')) {
    // 로그인 페이지는 항상 통과 (pathname 헤더만 설정)
    if (pathname === '/super/login') {
      const res = NextResponse.next();
      res.headers.set('x-pathname', pathname);
      return res;
    }

    const superToken = req.cookies.get(SUPER_COOKIE)?.value;
    if (!superToken) {
      const url = req.nextUrl.clone();
      url.pathname = '/super/login';
      url.searchParams.set('redirect', pathname);
      return NextResponse.redirect(url);
    }

    // 서명·만료에 더해 계정이 지금도 활성 슈퍼관리자인지(2026-11-13)
    const valid = await superTokenActive(superToken);
    if (!valid) {
      const url = req.nextUrl.clone();
      url.pathname = '/super/login';
      url.searchParams.set('redirect', pathname);
      const res = NextResponse.redirect(url);
      // 만료된 쿠키 제거
      res.cookies.set({ name: SUPER_COOKIE, value: '', maxAge: 0, path: '/' });
      return res;
    }

    // pathname을 헤더로 전달 (layout에서 /super/login 제외 처리용)
    const res = NextResponse.next();
    res.headers.set('x-pathname', pathname);
    return res;
  }

  // ── 관리자 경로 ───────────────────────────────────────────
  if (pathname.startsWith('/admin')) {
    const token = await getToken({ req, secret: NEXTAUTH_SECRET });
    if (!token?.sub || token.role !== 'ADMIN') {
      const url = req.nextUrl.clone();
      url.pathname = '/login';
      url.searchParams.set('error', 'unauthorized');
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  // ── 일반 인증 경로 ────────────────────────────────────────
  if (pathname.startsWith('/user')) {
    const token = await getToken({ req, secret: NEXTAUTH_SECRET });
    if (!token?.sub) {
      const url = req.nextUrl.clone();
      url.pathname = '/login';
      url.searchParams.set('error', 'unauthenticated');
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  // **`/api`를 반드시 포함한다.** 예전 matcher는 api를 빼고 있었다. 그대로
  // 두면 화면만 막히고 `/api/chat`은 밖에서 그대로 불린다 — 차단이 있는
  // 것처럼 보이지만 실제로는 없는, 이 기능을 만들게 된 바로 그 상태다.
  matcher: [
    '/admin/:path*',
    '/user/:path*',
    '/super/:path*',
    '/api/:path*',
    '/((?!_next|api|static|.*\..*).*)',
  ],
};
