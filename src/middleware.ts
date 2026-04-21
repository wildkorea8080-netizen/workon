import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { NEXTAUTH_SECRET } from '@/lib/config';

const PUBLIC_FILE = /\.(.*)$/;

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/static') ||
    PUBLIC_FILE.test(pathname)
  ) {
    return NextResponse.next();
  }

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
  matcher: ['/admin/:path*', '/user/:path*']
};
