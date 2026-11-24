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
import { normalizeIssuer, SSO_DEFAULT_LABEL, type SsoConfigInput, type SsoConfigView, type SsoErrorCode } from '@/lib/org-sso-spec';

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

/**
 * id_token 서명·내용 검증 — RS256·ES256만, kid가 맞는 공개키로. iss(다듬어 같음)·aud(클라이언트 ID 포함, 여럿이면 azp도)·
 * exp(2분 여유)·iat(앞서지 않음)·nonce. 맞으면 클레임, 아니면 까닭(기록용 — 화면에는 내보내지 않음)
 */
export function verifyIdToken(
  token: string,
  expect: { issuer: string; clientId: string; nonce: string; keys: JsonWebKey[]; nowMs: number },
): { ok: true; claims: IdClaims } | { ok: false; reason: string } {
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
  const candidates = expect.keys.filter((k) => k && k.kty === kty && (k.use === undefined || k.use === 'sig')
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

  const nowS = Math.floor(expect.nowMs / 1000);
  if (typeof claims.iss !== 'string' || normalizeIssuer(claims.iss) !== expect.issuer) return { ok: false, reason: 'iss' };
  const aud = claims.aud;
  const auds = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud.filter((a): a is string => typeof a === 'string') : [];
  if (!auds.includes(expect.clientId)) return { ok: false, reason: 'aud' };
  if (auds.length > 1 && claims.azp !== undefined && claims.azp !== expect.clientId) return { ok: false, reason: 'azp' };
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < nowS) return { ok: false, reason: 'exp' };
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_S > nowS) return { ok: false, reason: 'iat' };
  if (typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, expect.nonce)) return { ok: false, reason: 'nonce' };
  return { ok: true, claims };
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
};
export type SsoUserRow = {
  id: string; email: string | null; full_name: string | null; role: string | null; department_id: string | null;
  is_active: boolean | null; deleted_at: string | null; is_super_admin: boolean | null;
};
export type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string };

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
  return { issuer, authorization_endpoint: out.authorization_endpoint as string, token_endpoint: out.token_endpoint as string, jwks_uri: out.jwks_uri as string };
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
    const session = await io.mintSession({ id: user.id, email: user.email ?? email, name: decision.name, role: decision.role, departmentId: decision.departmentId });
    await io.record('login', email, who);
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
      await discover(input.issuer, io as unknown as SsoIo);
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
  if (!before || (before.button_label || SSO_DEFAULT_LABEL) !== input.buttonLabel) changed.push('button_label');
  const row = await io.upsert({
    organization_id: organizationId,
    issuer: input.issuer,
    client_id: input.clientId,
    client_secret_encrypted: secretEncrypted,
    email_domains: input.emailDomains,
    enabled: input.enabled,
    button_label: input.buttonLabel === SSO_DEFAULT_LABEL ? null : input.buttonLabel,
    updated_by: userId,
    updated_at: new Date(io.now()).toISOString(),
  });
  return { ok: true, view: configView(row)!, changed };
}

/** 로그인 화면 단추 — 켜진 기관이면 단추 글, 아니면 null(못 읽으면 null — 비밀번호 로그인은 그대로) */
export async function ssoButtonForSlug(slug: string, io: SsoIo = defaultSsoIo()): Promise<string | null> {
  try {
    const org = await io.loadOrgBySlug(slug);
    if (!org || isStoppedOrgStatus(org.status)) return null;
    const config = await io.loadConfig(org.id);
    return config?.enabled && config.client_secret_encrypted ? config.button_label || SSO_DEFAULT_LABEL : null;
  } catch {
    return null;
  }
}

export function sessionCookieName(appUrl = NEXTAUTH_URL ?? ''): string {
  return appUrl.startsWith('https://') ? '__Secure-next-auth.session-token' : 'next-auth.session-token';
}

export function appBaseUrl(): string {
  return (NEXTAUTH_URL ?? '').replace(/\/+$/, '');
}

export const SSO_CONFIG_COLUMNS = 'organization_id, issuer, client_id, client_secret_encrypted, email_domains, enabled, button_label, updated_at';

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
        .select('id, email, full_name, role, department_id, is_active, deleted_at, is_super_admin')
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
