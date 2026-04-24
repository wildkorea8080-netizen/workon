import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';

const NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? '';

const PUBLIC_FILE = /\.(.*)$/;
const SUPER_COOKIE = 'super_token';

/**
 * Edge Runtime 호환 JWT 서명 검증 (Web Crypto API)
 */
async function verifySuperTokenEdge(token: string): Promise<boolean> {
  try {
    const secret = process.env.SUPER_JWT_SECRET;
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

  // 정적 파일, Next.js 내부 경로 통과
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/api/super/auth') || // 슈퍼관리자 인증 API는 공개
    pathname.startsWith('/static') ||
    PUBLIC_FILE.test(pathname)
  ) {
    return NextResponse.next();
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

    const valid = await verifySuperTokenEdge(superToken);
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
  matcher: ['/admin/:path*', '/user/:path*', '/super/:path*'],
};
