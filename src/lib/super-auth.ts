/**
 * 슈퍼관리자 전용 JWT 인증 유틸리티
 * NextAuth와 완전히 분리된 독립 인증 시스템
 *
 * - signSuperJWT / verifySuperJWT: Node.js crypto (서버 전용)
 * - verifyEdgeSuperJWT: Web Crypto API (미들웨어 Edge Runtime 호환)
 * - getSuperAdminSession: 서버 컴포넌트/API 라우트에서 현재 세션 조회
 */
import { cookies } from 'next/headers';
import { createHmac } from 'crypto';

export interface SuperAdminPayload {
  sub: string;   // user id
  email: string;
  name: string;
  iat: number;
  exp: number;
}

const COOKIE_NAME = 'super_token';

function getSecret(): string {
  return process.env.SUPER_JWT_SECRET || 'dev-fallback-super-secret-change-in-prod';
}

function b64url(str: string): string {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str: string): string {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

/** JWT 서명 (서버 전용) */
export function signSuperJWT(
  adminId: string,
  email: string,
  name: string
): string {
  const secret = getSecret();
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({
    sub: adminId,
    email,
    name,
    iat: now,
    exp: now + 86400, // 24h
  }));
  const sig = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${sig}`;
}

/** JWT 검증 (서버 전용 - Node.js runtime) */
export function verifySuperJWT(token: string): SuperAdminPayload | null {
  try {
    const secret = getSecret();
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, sig] = parts;
    const expected = createHmac('sha256', secret)
      .update(`${header}.${payload}`)
      .digest('base64url');
    if (sig !== expected) return null;
    const data = JSON.parse(b64urlDecode(payload)) as SuperAdminPayload;
    if (data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

/** 서버 컴포넌트/API 라우트에서 현재 슈퍼관리자 세션 조회 */
export async function getSuperAdminSession(): Promise<SuperAdminPayload | null> {
  try {
    const cookieStore = cookies();
    const token = cookieStore.get(COOKIE_NAME)?.value;
    if (!token) return null;
    return verifySuperJWT(token);
  } catch {
    return null;
  }
}

/** API Request에서 슈퍼관리자 정보 추출 (API Route 전용) */
export function getSuperAdminFromRequest(request: Request): SuperAdminPayload | null {
  try {
    const cookieHeader = request.headers.get('cookie') ?? '';
    const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
    if (!match?.[1]) return null;
    return verifySuperJWT(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

export { COOKIE_NAME as SUPER_COOKIE_NAME };
