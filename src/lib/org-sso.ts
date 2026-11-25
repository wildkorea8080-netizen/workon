// src/lib/org-sso.ts
// 기관 SSO — OpenID Connect(2026-11-25, 0107). 기관이 쓰는 계정 서비스(Microsoft Entra ID·Google Workspace·Keycloak·사내 SSO)로 로그인한다.
//
// 흐름(인가 코드 + PKCE):
//   /signin/{slug} '기관 계정으로 로그인' → GET /api/sso/{slug}/start
//     → 발견 문서(issuer/.well-known/openid-configuration) → 인가 주소로 보냄(state·nonce·PKCE는 서명한 10분 쿠키에)
//   계정 서비스 → GET /api/sso/callback?code&state
//     → state 맞대기 → 토큰 교환(client_secret_post + code_verifier) → id_token 검증(서명은 jwks_uri의 공개키, iss·aud·azp·exp·iat·nonce)
//     → 이메일로 **이 기관에 이미 등록된** 직원을 찾아 NextAuth 세션 쿠키(대리 접근과 같은 encode)를 만들어 '/'로.
//
// 지키는 것:
// - **계정을 만들지 않는다** — 소속·역할은 users 행만 정한다(CLAUDE.md 구조적 위험 0). 없으면 '연결된 계정이 없음'.
//   이메일이 같아도 다른 기관 부서의 사람이면 들이지 않는다. 슈퍼관리자 계정은 이 길로 들어오지 않는다.
// - 사용 중지·탈퇴(canSignIn)·장기 미접속 잠금(0095)·정지/종료한 기관은 막는다. 성공·거절은 접속 기록(access_logs)에.
// - 이메일은 email(검증 표시가 false면 안 씀) → preferred_username·upn이 이메일 꼴일 때. 기관이 허용 도메인을 정했으면 그 도메인만.
// - 비밀값(클라이언트 비밀)은 AES로 저장하고 화면·기록에 내보내지 않는다. 토큰·코드·id_token은 기록에 남기지 않는다.
// - 계정 서비스 주소는 https만, 부를 때마다 이름을 다시 풀어 내부망·특수 IP면 부르지 않는다(결과 보내기와 같은 담장), 8초.
// - (0110) 그룹 → 부서 맞추기를 정해 두었으면 일반 직원(USER)의 소속을 id_token 클레임의 그룹에 맞춰 옮긴다(관리자는 그대로,
//   맞는 그룹이 없거나 옮기지 못하면 소속 그대로 들어온다 — 로그인은 막지 않음).
import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify, type JsonWebKey } from 'node:crypto';
import { encode } from 'next-auth/jwt';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { NEXTAUTH_SECRET, NEXTAUTH_URL } from '@/lib/config';
import { decryptApiKey, encryptApiKey } from '@/lib/crypto';
import { canSignIn } from '@/lib/user-withdrawal';
import { decideSignIn } from '@/lib/sign-in-user';
import { dormantDeps, lockIfDormant } from '@/lib/dormant-lock';
import { recordSignIn, signInRecordDeps, type SignInOutcome } from '@/lib/sign-in-record';
import { isStoppedOrgStatus } from '@/lib/org-status';
import { checkPublicHost } from '@/lib/apps/outbound/deliver';
import { logSystem } from '@/lib/logger';
import { logSecurityEvent } from '@/lib/security-log';
import { adminGroupMatch, groupDepartment, normalizeIssuer, readAdminGroups, readGroupMappings, SSO_DEFAULT_LABEL, type SsoConfigInput, type SsoConfigView, type SsoErrorCode } from '@/lib/org-sso-spec';

export * from '@/lib/org-sso-spec';

export const SSO_STATE_COOKIE = 'wo_sso_state';
export const SSO_STATE_TTL_MS = 10 * 60_000;
export const SSO_CALLBACK_PATH = '/api/sso/callback';
export const SSO_TIMEOUT_MS = 8_000;
/** 세션 길이 — NextAuth 기본(30일)과 같게 */
export const SSO_SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
const CLOCK_SKEW_S = 120;

export class SsoError extends Error {
  constructor(public code: SsoErrorCode, public detail?: string) { super(code); }
}

// ── 작은 도구 ────────────────────────────────────────────────────────────

const b64url = (buf: Buffer) => buf.toString('base64url');
const fromB64url = (s: string) => Buffer.from(s, 'base64url');

export function pkceChallenge(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest());
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ── 10분 상태 쿠키(서명) ─────────────────────────────────────────────────

export type SsoState = { org: string; slug: string; state: string; nonce: string; verifier: string; exp: number };

export function sealState(st: SsoState, secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify(st)));
  const mac = b64url(createHmac('sha256', secret).update(`sso.${body}`).digest());
  return `${body}.${mac}`;
}

export function openState(raw: string | null | undefined, secret: string, nowMs: number): SsoState | null {
  if (!raw || raw.length > 2000) return null;
  const [body, mac, extra] = raw.split('.');
  if (!body || !mac || extra !== undefined) return null;
  const expect = b64url(createHmac('sha256', secret).update(`sso.${body}`).digest());
  if (!safeEqual(mac, expect)) return null;
  try {
    const st = JSON.parse(fromB64url(body).toString('utf8')) as SsoState;
    if (typeof st?.exp !== 'number' || st.exp < nowMs) return null;
    for (const k of ['org', 'slug', 'state', 'nonce', 'verifier'] as const) if (typeof st[k] !== 'string' || !st[k]) return null;
    return st;
  } catch {
    return null;
  }
}

// ── id_token 검증(순수) ──────────────────────────────────────────────────

export type IdClaims = Record<string, unknown>;

/** JWT 서명만 — RS256·ES256, kid가 맞는 공개키로(id_token·logout_token이 함께 쓴다). 맞으면 클레임 */
function verifyJwtSignature(token: string, keys: JsonWebKey[]): { ok: true; claims: IdClaims } | { ok: false; reason: string } {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'format' };
  let header: { alg?: unknown; kid?: unknown };
  let claims: IdClaims;
  try {
    header = JSON.parse(fromB64url(parts[0]).toString('utf8'));
    claims = JSON.parse(fromB64url(parts[1]).toString('utf8'));
  } catch {
    return { ok: false, reason: 'format' };
  }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return { ok: false, reason: 'format' };
  const alg = header.alg;
  if (alg !== 'RS256' && alg !== 'ES256') return { ok: false, reason: 'alg' };
  const kty = alg === 'RS256' ? 'RSA' : 'EC';
  const candidates = keys.filter((k) => k && k.kty === kty && (k.use === undefined || k.use === 'sig')
    && (typeof header.kid !== 'string' || k.kid === header.kid) && (k.alg === undefined || k.alg === alg));
  if (!candidates.length) return { ok: false, reason: 'no_key' };
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = fromB64url(parts[2]);
  const verified = candidates.some((jwk) => {
    try {
      const key = createPublicKey({ key: jwk, format: 'jwk' });
      return alg === 'RS256'
        ? cryptoVerify('sha256', data, key, sig)
        : cryptoVerify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
    } catch {
      return false;
    }
  });
  if (!verified) return { ok: false, reason: 'signature' };
  return { ok: true, claims };
}

function audiences(claims: IdClaims): string[] {
  const aud = claims.aud;
  return typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud.filter((a): a is string => typeof a === 'string') : [];
}

/**
 * id_token 서명·내용 검증 — RS256·ES256만, kid가 맞는 공개키로. iss(다듬어 같음)·aud(클라이언트 ID 포함, 여럿이면 azp도)·
 * exp(2분 여유)·iat(앞서지 않음)·nonce. 맞으면 클레임, 아니면 까닭(기록용 — 화면에는 내보내지 않음)
 */
export function verifyIdToken(
  token: string,
  expect: { issuer: string; clientId: string; nonce: string; keys: JsonWebKey[]; nowMs: number },
): { ok: true; claims: IdClaims } | { ok: false; reason: string } {
  const signed = verifyJwtSignature(token, expect.keys);
  if (!signed.ok) return signed;
  const claims = signed.claims;
  const nowS = Math.floor(expect.nowMs / 1000);
  if (typeof claims.iss !== 'string' || normalizeIssuer(claims.iss) !== expect.issuer) return { ok: false, reason: 'iss' };
  const auds = audiences(claims);
  if (!auds.includes(expect.clientId)) return { ok: false, reason: 'aud' };
  if (auds.length > 1 && claims.azp !== undefined && claims.azp !== expect.clientId) return { ok: false, reason: 'azp' };
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < nowS) return { ok: false, reason: 'exp' };
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_S > nowS) return { ok: false, reason: 'iat' };
  if (typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, expect.nonce)) return { ok: false, reason: 'nonce' };
  return { ok: true, claims };
}

/** back-channel 로그아웃(0114) — OIDC Back-Channel Logout 1.0의 이벤트 이름 */
export const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
/** 이보다 오래된 logout_token은 받지 않는다(다시 보낸 옛 토큰) */
export const LOGOUT_TOKEN_MAX_AGE_S = 10 * 60;
export const LOGOUT_TOKEN_MAX_LENGTH = 16_000;

/**
 * logout_token 검증(0114) — 서명(id_token과 같은 규칙)·iss·aud·iat(앞서지 않고 10분 안)·exp(있으면)·events에 back-channel 로그아웃 이벤트·
 * nonce 없음·sub나 sid 중 하나 이상(이 사람을 찾는 열쇠 — 0118부터 세션 번호 sid만 오는 토큰도 받는다). 맞으면 sub·sid(없으면 null)와
 * 로그아웃 시각(iat, 지금보다 늦지 않게)
 */
export function verifyLogoutToken(
  token: string,
  expect: { issuer: string; clientId: string; keys: JsonWebKey[]; nowMs: number },
): { ok: true; subject: string | null; sid: string | null; loggedOutAtMs: number } | { ok: false; reason: string } {
  const signed = verifyJwtSignature(token, expect.keys);
  if (!signed.ok) return signed;
  const c = signed.claims;
  const nowS = Math.floor(expect.nowMs / 1000);
  if (typeof c.iss !== 'string' || normalizeIssuer(c.iss) !== expect.issuer) return { ok: false, reason: 'iss' };
  if (!audiences(c).includes(expect.clientId)) return { ok: false, reason: 'aud' };
  if (typeof c.iat !== 'number' || !Number.isFinite(c.iat) || c.iat - CLOCK_SKEW_S > nowS) return { ok: false, reason: 'iat' };
  if (c.iat + LOGOUT_TOKEN_MAX_AGE_S < nowS) return { ok: false, reason: 'stale' };
  if (c.exp !== undefined && (typeof c.exp !== 'number' || c.exp + CLOCK_SKEW_S < nowS)) return { ok: false, reason: 'exp' };
  const events = c.events as Record<string, unknown> | null | undefined;
  const event = events && typeof events === 'object' && !Array.isArray(events) ? events[BACKCHANNEL_LOGOUT_EVENT] : undefined;
  if (!event || typeof event !== 'object' || Array.isArray(event)) return { ok: false, reason: 'events' };
  if (c.nonce !== undefined) return { ok: false, reason: 'nonce' };
  const subject = ssoKey(c.sub);
  const sid = ssoKey(c.sid);
  // 있는데 꼴이 틀리면(빈 글·255자 넘음·글 아님) 거절 — 없는 것과 다르다
  if ((c.sub !== undefined && !subject) || (c.sid !== undefined && !sid)) return { ok: false, reason: 'bad_sub_sid' };
  if (!subject && !sid) return { ok: false, reason: 'no_sub_sid' };
  return { ok: true, subject, sid, loggedOutAtMs: Math.min(Math.floor(c.iat) * 1000, expect.nowMs) };
}

/** sub·sid 꼴 — 1~255자 글만 */
function ssoKey(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= 255 ? v : null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 로그인할 이메일 — email(검증 표시가 false면 안 씀) → preferred_username·upn이 이메일 꼴일 때. 허용 도메인이 있으면 그 안만 */
export function ssoEmail(claims: IdClaims, domains: string[]): { ok: true; email: string } | { ok: false; code: SsoErrorCode } {
  const pick = [claims.email_verified === false ? null : claims.email, claims.preferred_username, claims.upn]
    .find((v): v is string => typeof v === 'string' && EMAIL.test(v.trim()));
  if (!pick) return { ok: false, code: 'sso_no_account' };
  const email = pick.trim().toLowerCase();
  const domain = email.slice(email.lastIndexOf('@') + 1);
  if (domains.length && !domains.includes(domain)) return { ok: false, code: 'sso_domain' };
  return { ok: true, email };
}

// ── 바깥과 닿는 일 ───────────────────────────────────────────────────────

export type SsoConfigRow = {
  organization_id: string; issuer: string; client_id: string; client_secret_encrypted: string | null;
  email_domains: string[] | null; enabled: boolean; button_label: string | null; updated_at: string | null;
  /** 0109 — 칸이 없던 옛 행은 undefined(= 끔) */
  sso_only?: boolean | null;
  /** 0110 — 그룹 → 부서 맞추기(칸이 없던 옛 행은 undefined = 맞추지 않음) */
  group_claim?: string | null;
  group_mappings?: unknown;
  /** 0115 — 그룹 → 관리자 역할(칸이 없던 옛 행은 undefined = 올리지 않음) */
  admin_groups?: unknown;
  /** 0111 — 함께 로그아웃(칸이 없던 옛 행은 undefined = 끔) */
  single_logout?: boolean | null;
};
export type SsoUserRow = {
  id: string; email: string | null; full_name: string | null; role: string | null; department_id: string | null;
  is_active: boolean | null; deleted_at: string | null; is_super_admin: boolean | null;
  /** (0115) 그룹 → 관리자 역할로 올린 관리자인가 — 이 사람만 그룹에서 빠지면 내린다 */
  role_from_sso?: boolean | null;
};
export type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; /** 로그아웃 주소(선택 — 0111) */ end_session_endpoint: string | null };

export interface SsoIo {
  loadOrgBySlug(slug: string): Promise<{ id: string; slug: string; status: string | null } | null>;
  loadConfig(organizationId: string): Promise<SsoConfigRow | null>;
  decrypt(text: string): string;
  fetch: typeof fetch;
  /** 공개 주소인가(이름을 다시 풀어 내부망·특수 IP가 아니면 참) */
  publicHost(host: string): Promise<boolean>;
  /** 이 기관 부서에 속한 직원(이메일 대소문자 무시) — 없으면 null, 못 읽으면 던진다 */
  findUser(email: string, organizationId: string): Promise<SsoUserRow | null>;
  lockIfDormant(userId: string): Promise<boolean>;
  record(outcome: SignInOutcome, email: string | null, user: { id: string; departmentId: string | null } | null): Promise<void>;
  mintSession(user: { id: string; email: string; name: string | null; role: 'ADMIN' | 'USER'; departmentId: string }): Promise<string>;
  /**
   * (0110) 그룹 → 부서 맞추기 — 일반 직원을 `to` 부서로 옮긴다(부서가 이 기관 것인지 다시 보고, 지금 부서가 `from`일 때만).
   * 옮겼으면 true, 그 사이 바뀌어 옮기지 않았으면 false, 못 읽거나 못 쓰면(또는 다른 기관 부서면) 던진다. 없으면 맞추지 않는다
   */
  syncDepartment?(a: { userId: string; organizationId: string; from: string; to: string; group: string }): Promise<boolean>;
  /**
   * (0115) 그룹 → 관리자 역할 — `to: 'ADMIN'`은 일반 직원을 올리고(표시 참), `to: 'USER'`는 이 길로 올린 관리자만 내린다(표시 거짓).
   * 바꿨으면 true, 그 사이 바뀌어 안 바꿨으면 false, 못 쓰면 던진다. 없으면 바꾸지 않는다
   */
  syncRole?(a: { userId: string; organizationId: string; departmentId: string; to: 'ADMIN' | 'USER'; group: string | null }): Promise<boolean>;
  /** (0114) 계정 서비스의 사용자 번호(sub) → 이 직원 — back-channel 로그아웃이 sub만 보내므로. 못 쓰면 던진다(로그인은 그대로) */
  rememberSubject?(a: { organizationId: string; issuer: string; subject: string; userId: string }): Promise<void>;
  /** (0118) 계정 서비스의 세션 번호(sid) → 이 직원 — sid만 보내는 back-channel 로그아웃용. 못 쓰면 던진다(로그인은 그대로) */
  rememberSession?(a: { organizationId: string; issuer: string; sid: string; userId: string }): Promise<void>;
  now(): number;
  random(bytes: number): Buffer;
}

async function fetchJson(io: SsoIo, url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new SsoError('sso_unavailable', 'not_https');
  if (!(await io.publicHost(u.hostname))) throw new SsoError('sso_unavailable', 'private_host');
  const res = await io.fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(SSO_TIMEOUT_MS), headers: { Accept: 'application/json', ...(init.headers as Record<string, string> | undefined) } });
  const text = (await res.text()).slice(0, 200_000);
  if (!res.ok) throw new SsoError('sso_unavailable', `http_${res.status}`);
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('shape');
    return body as Record<string, unknown>;
  } catch {
    throw new SsoError('sso_unavailable', 'json');
  }
}

/** 발견 문서 — issuer가 설정과 같아야 하고 주소 셋은 https */
export async function discover(issuer: string, io: SsoIo): Promise<Discovery> {
  const doc = await fetchJson(io, `${issuer}/.well-known/openid-configuration`);
  const out = { issuer: doc.issuer, authorization_endpoint: doc.authorization_endpoint, token_endpoint: doc.token_endpoint, jwks_uri: doc.jwks_uri };
  if (typeof out.issuer !== 'string' || normalizeIssuer(out.issuer) !== issuer) throw new SsoError('sso_unavailable', 'issuer_mismatch');
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    const v = out[k];
    if (typeof v !== 'string' || !v.startsWith('https://')) throw new SsoError('sso_unavailable', `bad_${k}`);
  }
  // 로그아웃 주소는 선택(Google처럼 없는 곳도 있다) — https가 아니면 없는 것으로
  const endSession = typeof doc.end_session_endpoint === 'string' && doc.end_session_endpoint.startsWith('https://') ? doc.end_session_endpoint : null;
  return { issuer, authorization_endpoint: out.authorization_endpoint as string, token_endpoint: out.token_endpoint as string, jwks_uri: out.jwks_uri as string, end_session_endpoint: endSession };
}

async function usableConfig(slug: string, io: SsoIo): Promise<{ org: { id: string; slug: string }; config: SsoConfigRow & { client_secret_encrypted: string } }> {
  const org = await io.loadOrgBySlug(slug);
  if (!org || isStoppedOrgStatus(org.status)) throw new SsoError('sso_unavailable', 'org');
  const config = await io.loadConfig(org.id);
  if (!config?.enabled || !config.client_secret_encrypted) throw new SsoError('sso_unavailable', 'disabled');
  return { org, config: config as SsoConfigRow & { client_secret_encrypted: string } };
}

const failTo = (slug: string | null, code: SsoErrorCode) => `${slug ? `/signin/${encodeURIComponent(slug)}` : '/login'}?error=${code}`;

/** ① 시작 — 계정 서비스의 인가 주소로 보낼 주소와 상태 쿠키 */
export async function startSso(slug: string, io: SsoIo, appUrl: string, secret: string): Promise<{ redirect: string; stateCookie?: string }> {
  try {
    const { org, config } = await usableConfig(slug, io);
    const issuer = normalizeIssuer(config.issuer);
    if (!issuer) throw new SsoError('sso_unavailable', 'issuer');
    const disc = await discover(issuer, io);
    const st: SsoState = {
      org: org.id, slug: org.slug,
      state: b64url(io.random(24)), nonce: b64url(io.random(24)), verifier: b64url(io.random(32)),
      exp: io.now() + SSO_STATE_TTL_MS,
    };
    const url = new URL(disc.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.client_id);
    url.searchParams.set('redirect_uri', `${appUrl}${SSO_CALLBACK_PATH}`);
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', st.state);
    url.searchParams.set('nonce', st.nonce);
    url.searchParams.set('code_challenge', pkceChallenge(st.verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    return { redirect: url.toString(), stateCookie: sealState(st, secret) };
  } catch (error) {
    await reportFailure('start', error);
    return { redirect: failTo(slug, error instanceof SsoError ? error.code : 'sso_unavailable') };
  }
}

/** ② 돌아옴 — 확인을 마치면 세션 토큰과 '/', 아니면 로그인 화면과 까닭 */
export async function finishSso(
  query: URLSearchParams,
  stateCookie: string | null | undefined,
  io: SsoIo,
  appUrl: string,
  secret: string,
): Promise<{ redirect: string; session?: string }> {
  const st = openState(stateCookie, secret, io.now());
  if (!st) return { redirect: failTo(null, 'sso_expired') };
  const gotState = query.get('state') ?? '';
  if (!gotState || !safeEqual(gotState, st.state)) return { redirect: failTo(st.slug, 'sso_expired') };
  if (query.get('error') || !query.get('code')) return { redirect: failTo(st.slug, 'sso_denied') };
  let email: string | null = null;
  try {
    const { org, config } = await usableConfig(st.slug, io);
    if (org.id !== st.org) throw new SsoError('sso_expired', 'org_changed');
    const issuer = normalizeIssuer(config.issuer);
    if (!issuer) throw new SsoError('sso_unavailable', 'issuer');
    const disc = await discover(issuer, io);
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: query.get('code')!,
      redirect_uri: `${appUrl}${SSO_CALLBACK_PATH}`,
      client_id: config.client_id,
      client_secret: io.decrypt(config.client_secret_encrypted),
      code_verifier: st.verifier,
    });
    const tokens = await fetchJson(io, disc.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    if (typeof tokens.id_token !== 'string') throw new SsoError('sso_unavailable', 'no_id_token');
    const jwks = await fetchJson(io, disc.jwks_uri);
    const keys = Array.isArray(jwks.keys) ? (jwks.keys as JsonWebKey[]) : [];
    const checked = verifyIdToken(tokens.id_token, { issuer, clientId: config.client_id, nonce: st.nonce, keys, nowMs: io.now() });
    if (!checked.ok) throw new SsoError('sso_unavailable', `id_token_${checked.reason}`);

    const picked = ssoEmail(checked.claims, config.email_domains ?? []);
    if (!picked.ok) {
      await io.record('login_rejected', null, null);
      return { redirect: failTo(st.slug, picked.code) };
    }
    email = picked.email;
    const user = await io.findUser(email, org.id);
    if (!user || user.is_super_admin) {
      await io.record('login_rejected', email, null);
      return { redirect: failTo(st.slug, 'sso_no_account') };
    }
    const who = { id: user.id, departmentId: user.department_id ?? null };
    if (!canSignIn(user)) {
      await io.record('login_rejected', email, who);
      return { redirect: failTo(st.slug, 'sso_rejected') };
    }
    const decision = decideSignIn(user, false);
    if (!decision.ok) {
      await io.record('login_rejected', email, who);
      return { redirect: failTo(st.slug, 'sso_no_account') };
    }
    if (await io.lockIfDormant(user.id)) {
      await io.record('login_rejected', email, who);
      return { redirect: failTo(st.slug, 'sso_dormant') };
    }
    // (0115) 그룹 → 관리자 역할 — 목록이 있을 때만. 이 길로 올린 관리자가 그룹에서 빠졌으면 먼저 내린다(못 내리면 들이지 않는다 —
    // 관리자 권한을 거둘 사람을 관리자로 들이지 않게). 손으로 지정한 관리자는 건드리지 않는다
    let role = decision.role;
    const adminGroups = readAdminGroups(config.admin_groups);
    const adminMatch = adminGroupMatch(checked.claims, config.group_claim, adminGroups);
    if (adminGroups.length && role === 'ADMIN' && user.role_from_sso === true && !adminMatch) {
      try {
        if (!io.syncRole) throw new SsoError('sso_unavailable', 'role_sync_missing');
        if (await io.syncRole({ userId: user.id, organizationId: org.id, departmentId: decision.departmentId, to: 'USER', group: null })) role = 'USER';
        else throw new SsoError('sso_unavailable', 'role_changed');
      } catch (error) {
        await reportFailure('role_sync', error, org.id);
        await io.record('login_rejected', email, who);
        return { redirect: failTo(st.slug, 'sso_unavailable') };
      }
    }
    // (0110) 그룹 → 부서 맞추기 — 일반 직원만, 맞는 그룹이 있고 지금 부서와 다를 때. 실패해도 소속 그대로 들인다
    let departmentId = decision.departmentId;
    const mapped = groupDepartment(checked.claims, config.group_claim, readGroupMappings(config.group_mappings));
    if (mapped && role === 'USER' && mapped.departmentId !== departmentId.toLowerCase() && io.syncDepartment) {
      try {
        if (await io.syncDepartment({ userId: user.id, organizationId: org.id, from: departmentId, to: mapped.departmentId, group: mapped.value })) departmentId = mapped.departmentId;
      } catch (error) {
        await reportFailure('group_sync', error, org.id);
      }
    }
    // (0115) 관리자 그룹에 든 일반 직원은 관리자로(옮긴 부서에서). 못 올리면 일반 직원으로 들인다
    if (adminMatch && role === 'USER' && io.syncRole) {
      try {
        if (await io.syncRole({ userId: user.id, organizationId: org.id, departmentId, to: 'ADMIN', group: adminMatch })) role = 'ADMIN';
      } catch (error) {
        await reportFailure('role_sync', error, org.id);
      }
    }
    const session = await io.mintSession({ id: user.id, email: user.email ?? email, name: decision.name, role, departmentId });
    // (0114) back-channel 로그아웃이 sub만 보내므로 sub → 직원을 적어 둔다. 못 적으면 그 로그아웃만 못 받는다(로그인은 그대로)
    const subject = checked.claims.sub;
    if (io.rememberSubject && typeof subject === 'string' && subject && subject.length <= 255) {
      try {
        await io.rememberSubject({ organizationId: org.id, issuer, subject, userId: user.id });
      } catch (error) {
        await reportFailure('subject', error, org.id);
      }
    }
    // (0118) sid만 보내는 계정 서비스도 있어 sid → 직원도 적어 둔다(id_token에 sid가 있을 때만)
    const sid = checked.claims.sid;
    if (io.rememberSession && typeof sid === 'string' && sid && sid.length <= 255) {
      try {
        await io.rememberSession({ organizationId: org.id, issuer, sid, userId: user.id });
      } catch (error) {
        await reportFailure('session', error, org.id);
      }
    }
    await io.record('login', email, { id: user.id, departmentId });
    return { redirect: '/', session };
  } catch (error) {
    await reportFailure('callback', error, st.org);
    return { redirect: failTo(st.slug, error instanceof SsoError ? error.code : 'sso_unavailable') };
  }
}

async function reportFailure(step: string, error: unknown, orgId?: string): Promise<void> {
  // 토큰·코드·이메일은 남기지 않는다 — 단계·까닭 코드만
  const detail = error instanceof SsoError ? error.detail ?? error.code : error instanceof Error ? error.name : 'unknown';
  await logSystem({ level: 'warning', category: 'auth', message: `기관 SSO 로그인 실패(${step})`, details: { detail }, ...(orgId ? { orgId } : {}) }).catch(() => {});
}

// ── 관리자 설정 ──────────────────────────────────────────────────────────

export function configView(row: SsoConfigRow | null): SsoConfigView | null {
  if (!row) return null;
  return {
    issuer: row.issuer,
    clientId: row.client_id,
    hasSecret: Boolean(row.client_secret_encrypted),
    emailDomains: row.email_domains ?? [],
    enabled: row.enabled,
    ssoOnly: row.enabled && row.sso_only === true,
    groupClaim: row.group_claim ?? null,
    groupMappings: readGroupMappings(row.group_mappings),
    adminGroups: readAdminGroups(row.admin_groups),
    singleLogout: row.enabled && row.single_logout === true,
    buttonLabel: row.button_label || SSO_DEFAULT_LABEL,
    updatedAt: row.updated_at,
  };
}

/**
 * 저장 — 켤 때는 비밀값이 있어야 하고 발견 문서를 실제로 읽어 본다(못 읽으면 저장하지 않음). 비밀값은 비우면 그대로 둔다.
 * 바뀐 칸 이름 목록을 돌려준다(보안 로그용 — 값·비밀값 없음)
 */
export async function saveSsoConfig(
  organizationId: string,
  userId: string,
  input: SsoConfigInput,
  io: Pick<SsoIo, 'loadConfig' | 'fetch' | 'publicHost' | 'now'> & { upsert(row: Record<string, unknown>): Promise<SsoConfigRow>; encrypt(text: string): string },
): Promise<{ ok: true; view: SsoConfigView; changed: string[] } | { ok: false; status: number; message: string }> {
  const before = await io.loadConfig(organizationId);
  const secretEncrypted = input.clientSecret ? io.encrypt(input.clientSecret) : before?.client_secret_encrypted ?? null;
  if (input.enabled && !secretEncrypted) return { ok: false, status: 400, message: '켜려면 클라이언트 비밀값을 적어 주세요.' };
  if (input.enabled) {
    try {
      const disc = await discover(input.issuer, io as unknown as SsoIo);
      // (0111) 함께 로그아웃은 계정 서비스가 로그아웃 주소를 알려 줄 때만
      if (input.singleLogout && !disc.end_session_endpoint) {
        return { ok: false, status: 400, message: '이 계정 서비스는 OIDC 발견 문서에 로그아웃 주소(end_session_endpoint)를 알려 주지 않아 함께 로그아웃을 켤 수 없습니다.' };
      }
    } catch (error) {
      const detail = error instanceof SsoError ? error.detail : 'unknown';
      return { ok: false, status: 400, message: `발급자 주소의 OIDC 발견 문서를 읽지 못했습니다(${detail ?? 'unknown'}). 주소와 공개 여부를 확인해 주세요.` };
    }
  }
  const changed: string[] = [];
  if (!before || before.issuer !== input.issuer) changed.push('issuer');
  if (!before || before.client_id !== input.clientId) changed.push('client_id');
  if (input.clientSecret) changed.push('client_secret');
  if (!before || JSON.stringify(before.email_domains ?? []) !== JSON.stringify(input.emailDomains)) changed.push('email_domains');
  if (!before || before.enabled !== input.enabled) changed.push('enabled');
  const ssoOnly = input.enabled && input.ssoOnly; // 꺼진 SSO에는 걸지 않는다(0109 CHECK)
  if ((before?.sso_only === true) !== ssoOnly) changed.push('sso_only');
  if (!before || (before.button_label || SSO_DEFAULT_LABEL) !== input.buttonLabel) changed.push('button_label');
  const singleLogout = input.enabled && input.singleLogout; // 꺼진 SSO에는 걸지 않는다(0111 CHECK)
  if ((before?.single_logout === true) !== singleLogout) changed.push('single_logout');
  if ((before?.group_claim ?? null) !== input.groupClaim) changed.push('group_claim');
  if (JSON.stringify(readGroupMappings(before?.group_mappings)) !== JSON.stringify(input.groupMappings)) changed.push('group_mappings');
  if (JSON.stringify(readAdminGroups(before?.admin_groups)) !== JSON.stringify(input.adminGroups)) changed.push('admin_groups');
  const row = await io.upsert({
    organization_id: organizationId,
    issuer: input.issuer,
    client_id: input.clientId,
    client_secret_encrypted: secretEncrypted,
    email_domains: input.emailDomains,
    enabled: input.enabled,
    sso_only: ssoOnly,
    group_claim: input.groupClaim,
    group_mappings: input.groupMappings,
    admin_groups: input.adminGroups,
    single_logout: singleLogout,
    button_label: input.buttonLabel === SSO_DEFAULT_LABEL ? null : input.buttonLabel,
    updated_by: userId,
    updated_at: new Date(io.now()).toISOString(),
  });
  return { ok: true, view: configView(row)!, changed };
}

/**
 * 로그인 화면의 기관 계정 로그인 — 켜진 기관이면 단추 글과 SSO 전용(0109) 여부, 아니면 null
 * (못 읽으면 null — 비밀번호 로그인 칸은 그대로 보이고, 막을지는 서버가 로그인 때 다시 본다)
 */
export async function ssoLoginForSlug(slug: string, io: SsoIo = defaultSsoIo()): Promise<{ label: string; ssoOnly: boolean } | null> {
  try {
    const org = await io.loadOrgBySlug(slug);
    if (!org || isStoppedOrgStatus(org.status)) return null;
    const config = await io.loadConfig(org.id);
    if (!config?.enabled || !config.client_secret_encrypted) return null;
    return { label: config.button_label || SSO_DEFAULT_LABEL, ssoOnly: config.sso_only === true };
  } catch {
    return null;
  }
}

/** 로그인 화면 단추 글 — 켜진 기관이면 단추 글, 아니면 null */
export async function ssoButtonForSlug(slug: string, io: SsoIo = defaultSsoIo()): Promise<string | null> {
  return (await ssoLoginForSlug(slug, io))?.label ?? null;
}

// ── 함께 로그아웃(0111) ─────────────────────────────────────────────────

export interface SsoLogoutIo {
  /** 부서의 기관 — 없으면 null, 못 읽으면 던진다 */
  orgOfDepartment(departmentId: string): Promise<{ id: string; slug: string | null; status: string | null } | null>;
  loadConfig: SsoIo['loadConfig'];
  fetch: typeof fetch;
  publicHost: SsoIo['publicHost'];
}

/**
 * 기관 계정(SSO)으로 들어온 직원이 로그아웃할 때 보낼 계정 서비스의 로그아웃 주소 — 기관이 '함께 로그아웃'을 켰고 발견 문서에
 * end_session_endpoint가 있을 때만(OIDC RP-Initiated Logout: client_id·post_logout_redirect_uri = 그 기관 로그인 화면).
 * 아니면 null. 던지지 않는다 — 못 읽으면 WORKON 로그아웃만 하고 운영 기록에 남긴다. 토큰(id_token)은 저장하지 않으므로 싣지 않는다
 */
export async function ssoLogoutUrl(departmentId: string, io: SsoLogoutIo, appUrl: string): Promise<string | null> {
  try {
    const org = await io.orgOfDepartment(departmentId);
    if (!org?.slug) return null;
    const config = await io.loadConfig(org.id);
    if (!config?.enabled || config.single_logout !== true) return null;
    const issuer = normalizeIssuer(config.issuer);
    if (!issuer) return null;
    const disc = await discover(issuer, io as unknown as SsoIo);
    if (!disc.end_session_endpoint) return null;
    const url = new URL(disc.end_session_endpoint);
    url.searchParams.set('client_id', config.client_id);
    url.searchParams.set('post_logout_redirect_uri', `${appUrl}/signin/${encodeURIComponent(org.slug)}`);
    return url.toString();
  } catch (error) {
    await reportFailure('logout', error);
    return null;
  }
}

export function defaultSsoLogoutIo(): SsoLogoutIo {
  const base = defaultSsoIo();
  return {
    async orgOfDepartment(departmentId) {
      const { data: dept, error } = await supabaseAdmin.from('departments').select('organization_id').eq('id', departmentId).maybeSingle();
      if (error) throw new SsoError('sso_unavailable', 'dept_read');
      const orgId = (dept as { organization_id: string | null } | null)?.organization_id;
      if (!orgId) return null;
      const { data: org, error: orgError } = await supabaseAdmin.from('organizations').select('id, slug, status').eq('id', orgId).maybeSingle();
      if (orgError) throw new SsoError('sso_unavailable', 'org_read');
      return (org as { id: string; slug: string | null; status: string | null } | null) ?? null;
    },
    loadConfig: base.loadConfig,
    fetch: base.fetch,
    publicHost: base.publicHost,
  };
}

// ── back-channel 로그아웃(0114) ─────────────────────────────────────────

export const SSO_BACKCHANNEL_PATH = '/api/sso/backchannel-logout';
/** (0118) 세션 번호 줄을 남기는 기간 — WORKON 기관 계정 로그인(30일)보다 하루 더 */
export const SSO_SESSION_ROW_TTL_MS = 31 * 24 * 60 * 60 * 1000;

export interface SsoBackchannelIo {
  /** 이 발급자의 SSO 설정들(켜짐과 상관없이 — 로그아웃은 끝내는 쪽이라) — 못 읽으면 던진다 */
  configsByIssuer(issuer: string): Promise<SsoConfigRow[]>;
  fetch: typeof fetch;
  publicHost: SsoIo['publicHost'];
  /** 기관·발급자·sub로 적어 둔 직원 id — 못 읽으면 던진다 */
  subjectUsers(a: { organizationId: string; issuer: string; subject: string }): Promise<string[]>;
  /** (0118) 기관·발급자·sid로 적어 둔 직원 id — 못 읽으면 던진다. 없으면 sid만 온 토큰은 아무도 끝내지 않는다 */
  sessionUsers?(a: { organizationId: string; issuer: string; sid: string }): Promise<string[]>;
  /** 기관 계정 로그아웃 시각을 적는다(지금 값보다 늦을 때만 — 다시 온 옛 토큰은 새 로그인을 끝내지 않게). 바꿨으면 true, 못 쓰면 던진다 */
  markLoggedOut(a: { userId: string; organizationId: string; atMs: number }): Promise<boolean>;
  now(): number;
}

/**
 * 계정 서비스가 보낸 logout_token(OIDC Back-Channel Logout)을 받아, 그 sub(없으면 sid — 0118)로 기관 계정 로그인한 직원의 로그아웃 시각을 적는다 —
 * sid만 와도 그 세션 하나가 아니라 그 직원의 그 전 기관 계정 로그인을 모두 끝낸다(WORKON 로그인에 sid를 싣지 않아 하나만 가려 끝낼 수 없다 — 더 넓게 끝내는 쪽).
 * 미들웨어가 그 전에 기관 계정으로 들어온 WORKON 로그인을 끝낸다('sso_logged_out', 30초 안). 비밀번호 로그인·대리 접근은 그대로.
 * 서명 전에는 iss·aud로 설정만 고른다(그 값으로 무엇을 바꾸지 않음). 틀린 토큰 400, 못 읽음 503(계정 서비스가 다시 보낸다), 맞으면 200
 */
export async function handleBackchannelLogout(raw: unknown, io: SsoBackchannelIo): Promise<{ status: 200 | 400 | 503; ended: number }> {
  const bad = { status: 400 as const, ended: 0 };
  if (typeof raw !== 'string' || !raw || raw.length > LOGOUT_TOKEN_MAX_LENGTH) return bad;
  let peek: IdClaims;
  try {
    const parts = raw.split('.');
    if (parts.length !== 3) return bad;
    peek = JSON.parse(fromB64url(parts[1]).toString('utf8'));
  } catch {
    return bad;
  }
  if (!peek || typeof peek !== 'object' || Array.isArray(peek) || typeof peek.iss !== 'string') return bad;
  const issuer = normalizeIssuer(peek.iss);
  if (!issuer) return bad;
  const auds = audiences(peek);
  let configs: SsoConfigRow[];
  try {
    configs = (await io.configsByIssuer(issuer)).filter((c) => normalizeIssuer(c.issuer) === issuer && auds.includes(c.client_id));
  } catch (error) {
    await reportFailure('backchannel', error);
    return { status: 503, ended: 0 };
  }
  if (!configs.length) return bad;
  let keys: JsonWebKey[];
  try {
    const disc = await discover(issuer, io as unknown as SsoIo);
    const jwks = await fetchJson(io as unknown as SsoIo, disc.jwks_uri);
    keys = Array.isArray(jwks.keys) ? (jwks.keys as JsonWebKey[]) : [];
  } catch (error) {
    await reportFailure('backchannel', error, configs[0].organization_id);
    return { status: 503, ended: 0 };
  }
  let ended = 0;
  let accepted = false;
  let reason = 'none';
  for (const config of configs) {
    const checked = verifyLogoutToken(raw, { issuer, clientId: config.client_id, keys, nowMs: io.now() });
    if (!checked.ok) { reason = checked.reason; continue; }
    accepted = true;
    try {
      const users = checked.subject
        ? await io.subjectUsers({ organizationId: config.organization_id, issuer, subject: checked.subject })
        : checked.sid && io.sessionUsers
          ? await io.sessionUsers({ organizationId: config.organization_id, issuer, sid: checked.sid })
          : [];
      for (const userId of users) {
        if (await io.markLoggedOut({ userId, organizationId: config.organization_id, atMs: checked.loggedOutAtMs })) ended += 1;
      }
    } catch (error) {
      await reportFailure('backchannel', error, config.organization_id);
      return { status: 503, ended };
    }
  }
  if (!accepted) {
    await reportFailure('backchannel', new SsoError('sso_unavailable', `logout_token_${reason}`), configs[0].organization_id);
    return bad;
  }
  return { status: 200, ended };
}

export function defaultSsoBackchannelIo(): SsoBackchannelIo {
  const base = defaultSsoIo();
  return {
    async configsByIssuer(issuer) {
      const { data, error } = await supabaseAdmin.from('org_sso_providers').select(SSO_CONFIG_COLUMNS).in('issuer', [issuer, `${issuer}/`]).limit(100);
      if (error) throw new SsoError('sso_unavailable', 'config_read');
      return (data ?? []) as SsoConfigRow[];
    },
    fetch: base.fetch,
    publicHost: base.publicHost,
    async subjectUsers({ organizationId, issuer, subject }) {
      const { data, error } = await supabaseAdmin.from('org_sso_subjects').select('user_id')
        .eq('organization_id', organizationId).eq('issuer', issuer).eq('subject', subject).limit(10);
      if (error) throw new SsoError('sso_unavailable', 'subject_read');
      return ((data ?? []) as { user_id: string }[]).map((r) => r.user_id);
    },
    async sessionUsers({ organizationId, issuer, sid }) {
      const { data, error } = await supabaseAdmin.from('org_sso_sessions').select('user_id')
        .eq('organization_id', organizationId).eq('issuer', issuer).eq('sid', sid).limit(10);
      if (error) throw new SsoError('sso_unavailable', 'session_read');
      return ((data ?? []) as { user_id: string }[]).map((r) => r.user_id);
    },
    async markLoggedOut({ userId, atMs }) {
      const at = new Date(atMs).toISOString();
      const { data, error } = await supabaseAdmin.from('users')
        .update({ sso_logout_at: at })
        .eq('id', userId).is('deleted_at', null)
        .or(`sso_logout_at.is.null,sso_logout_at.lt."${at}"`)
        .select('id, department_id');
      if (error) throw new SsoError('sso_unavailable', 'logout_write');
      const row = ((data ?? []) as { id: string; department_id: string | null }[])[0];
      if (!row) return false;
      await logSecurityEvent(row.department_id, userId, 'sso_backchannel_logout', { target_user_id: userId, via: 'sso_backchannel', logged_out_at: at }, 'low');
      return true;
    },
    now: () => Date.now(),
  };
}

export function sessionCookieName(appUrl = NEXTAUTH_URL ?? ''): string {
  return appUrl.startsWith('https://') ? '__Secure-next-auth.session-token' : 'next-auth.session-token';
}

export function appBaseUrl(): string {
  return (NEXTAUTH_URL ?? '').replace(/\/+$/, '');
}

export const SSO_CONFIG_COLUMNS = 'organization_id, issuer, client_id, client_secret_encrypted, email_domains, enabled, sso_only, group_claim, group_mappings, admin_groups, single_logout, button_label, updated_at';

/** 접속 기록에 남길 요청 주소·브라우저 — 라우트가 넘긴다 */
export function defaultSsoIo(meta: { ip: string | null; userAgent: string | null } = { ip: null, userAgent: null }): SsoIo {
  return {
    async loadOrgBySlug(slug) {
      const { data, error } = await supabaseAdmin.from('organizations').select('id, slug, status').eq('slug', slug).maybeSingle();
      if (error) throw new SsoError('sso_unavailable', 'org_read');
      return (data as { id: string; slug: string; status: string | null } | null) ?? null;
    },
    async loadConfig(organizationId) {
      const { data, error } = await supabaseAdmin.from('org_sso_providers').select(SSO_CONFIG_COLUMNS).eq('organization_id', organizationId).maybeSingle();
      if (error) throw new SsoError('sso_unavailable', 'config_read');
      return (data as SsoConfigRow | null) ?? null;
    },
    decrypt: decryptApiKey,
    fetch: (...args) => fetch(...args),
    async publicHost(host) {
      return (await checkPublicHost(host)).ok;
    },
    async findUser(email, organizationId) {
      const pattern = email.replace(/[\\%_]/g, (c) => `\\${c}`);
      const { data, error } = await supabaseAdmin.from('users')
        .select('id, email, full_name, role, department_id, is_active, deleted_at, is_super_admin, role_from_sso')
        .ilike('email', pattern).limit(2);
      if (error) throw new SsoError('sso_unavailable', 'user_read');
      const rows = (data ?? []) as SsoUserRow[];
      if (rows.length !== 1) return null; // 없거나 같은 주소가 둘이면 고르지 않는다
      const user = rows[0];
      if (!user.department_id) return user;
      const { data: dept, error: deptError } = await supabaseAdmin.from('departments').select('organization_id').eq('id', user.department_id).maybeSingle();
      if (deptError) throw new SsoError('sso_unavailable', 'dept_read');
      return (dept as { organization_id: string | null } | null)?.organization_id === organizationId ? user : null;
    },
    lockIfDormant: (userId) => lockIfDormant(dormantDeps(), userId),
    async record(outcome, email, user) {
      await recordSignIn(signInRecordDeps(), { outcome, email, ip: meta.ip, userAgent: `SSO · ${meta.userAgent ?? ''}`.slice(0, 300), user });
    },
    async mintSession(user) {
      const nowS = Math.floor(Date.now() / 1000);
      return encode({
        token: {
          sub: user.id, id: user.id, name: user.name ?? user.email, email: user.email, role: user.role, departmentId: user.departmentId,
          authAt: Date.now(), sso: true, iat: nowS, exp: nowS + SSO_SESSION_MAX_AGE_S,
        },
        secret: NEXTAUTH_SECRET,
        maxAge: SSO_SESSION_MAX_AGE_S,
      });
    },
    now: () => Date.now(),
    random: (n) => randomBytes(n),
    async rememberSubject({ organizationId, issuer, subject, userId }) {
      const { error } = await supabaseAdmin.from('org_sso_subjects').upsert(
        { organization_id: organizationId, issuer, subject, user_id: userId, updated_at: new Date().toISOString() },
        { onConflict: 'organization_id,issuer,subject' },
      );
      if (error) throw new SsoError('sso_unavailable', 'subject_write');
    },
    async rememberSession({ organizationId, issuer, sid, userId }) {
      const { error } = await supabaseAdmin.from('org_sso_sessions').upsert(
        { organization_id: organizationId, issuer, sid, user_id: userId, created_at: new Date().toISOString() },
        { onConflict: 'organization_id,issuer,sid' },
      );
      if (error) throw new SsoError('sso_unavailable', 'session_write');
      // 이 직원의 오래된 세션 번호는 치운다 — WORKON 로그인은 30일이라 그보다 오래된 줄은 끝낼 로그인이 없다(못 치우면 다음 로그인 때)
      const { error: pruneError } = await supabaseAdmin.from('org_sso_sessions').delete()
        .eq('user_id', userId).lt('created_at', new Date(Date.now() - SSO_SESSION_ROW_TTL_MS).toISOString());
      if (pruneError) throw new SsoError('sso_unavailable', 'session_prune');
    },
    async syncRole({ userId, organizationId, departmentId, to, group }) {
      // 올리기는 일반 직원만, 내리기는 이 길로 올린 관리자만 — 조건부로(그 사이 손으로 바꿨으면 바꾸지 않음)
      let q = supabaseAdmin.from('users')
        .update({ role: to, role_from_sso: to === 'ADMIN' })
        .eq('id', userId).eq('department_id', departmentId).is('deleted_at', null).eq('is_active', true).eq('is_super_admin', false);
      q = to === 'ADMIN' ? q.eq('role', 'USER') : q.eq('role', 'ADMIN').eq('role_from_sso', true);
      const { data, error } = await q.select('id');
      if (error) throw new SsoError('sso_unavailable', 'role_write');
      if (!data || data.length === 0) return false;
      await logSecurityEvent(departmentId, userId, 'user_role_synced', {
        target_user_id: userId,
        from_role: to === 'ADMIN' ? 'USER' : 'ADMIN',
        to_role: to,
        via: 'sso_group',
        ...(group ? { sso_group: group.slice(0, 200) } : {}),
        organization_id: organizationId,
      }, 'high');
      return true;
    },
    async syncDepartment({ userId, organizationId, from, to, group }) {
      const { data: depts, error: deptError } = await supabaseAdmin.from('departments').select('id, name, organization_id').in('id', [from, to]);
      if (deptError) throw new SsoError('sso_unavailable', 'group_dept_read');
      const rows = (depts ?? []) as { id: string; name: string | null; organization_id: string | null }[];
      const target = rows.find((d) => d.id === to);
      // 목록을 저장한 뒤 부서가 지워졌거나 다른 기관 부서가 되었으면 옮기지 않는다
      if (!target || target.organization_id !== organizationId) throw new SsoError('sso_unavailable', 'group_dept_outside');
      const { data: moved, error: moveError } = await supabaseAdmin.from('users')
        .update({ department_id: to })
        .eq('id', userId).eq('department_id', from).eq('role', 'USER').is('deleted_at', null)
        .select('id');
      if (moveError) throw new SsoError('sso_unavailable', 'group_move');
      if (!moved || moved.length === 0) return false;
      await logSecurityEvent(to, userId, 'user_department_synced', {
        target_user_id: userId,
        from_department_id: from,
        to_department_id: to,
        from_department_name: rows.find((d) => d.id === from)?.name ?? null,
        to_department_name: target.name ?? null,
        via: 'sso_group',
        sso_group: group.slice(0, 200),
      }, 'medium');
      return true;
    },
  };
}

export function defaultSsoAdminIo() {
  const base = defaultSsoIo();
  return {
    loadConfig: base.loadConfig,
    fetch: base.fetch,
    publicHost: base.publicHost,
    now: base.now,
    encrypt: (text: string) => encryptApiKey(text),
    async upsert(row: Record<string, unknown>): Promise<SsoConfigRow> {
      const { data, error } = await supabaseAdmin.from('org_sso_providers').upsert(row, { onConflict: 'organization_id' }).select(SSO_CONFIG_COLUMNS).single();
      if (error) throw new Error(`org_sso_providers: ${error.code ?? ''}`);
      return data as SsoConfigRow;
    },
  };
}
