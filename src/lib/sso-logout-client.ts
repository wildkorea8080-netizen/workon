'use client';
// 로그아웃(2026-11-25, 0111) — 기관 계정(SSO)으로 들어온 로그인이면 먼저 계정 서비스의 로그아웃 주소를 받아 두고, NextAuth 로그아웃을 마친 뒤
// 그 주소로 보낸다(기관이 '함께 로그아웃'을 켰을 때만 주소가 온다). 주소를 못 받으면 평소처럼 WORKON만 로그아웃한다.
import { signOut } from 'next-auth/react';
import { requestJson } from '@/lib/ok-json';

/** 계정 서비스 로그아웃 주소 — https만 받는다(서버가 만든 주소지만 화면이 다시 본다) */
export function ssoLogoutTarget(body: unknown): string | null {
  const redirect = (body as { data?: { redirect?: unknown } } | null)?.data?.redirect;
  return typeof redirect === 'string' && redirect.startsWith('https://') ? redirect : null;
}

export async function signOutEverywhere(callbackUrl: string, sso: boolean | undefined): Promise<void> {
  let target: string | null = null;
  if (sso) {
    const r = await requestJson('/api/sso/logout', { method: 'POST' });
    if (r.ok) target = ssoLogoutTarget(r.body);
  }
  if (!target) {
    await signOut({ callbackUrl });
    return;
  }
  await signOut({ redirect: false });
  window.location.href = target;
}
