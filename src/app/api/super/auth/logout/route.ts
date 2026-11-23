import { NextResponse } from 'next/server';
import { IS_PRODUCTION } from '@/lib/config';
import { SUPER_COOKIE_NAME } from '@/lib/super-auth';

export const dynamic = 'force-dynamic';

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: SUPER_COOKIE_NAME,
    value: '',
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return response;
}
