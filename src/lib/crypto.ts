import crypto from 'crypto';

/**
 * 보관하는 비밀값(API 키·앱 결과 보낼 곳 서명 비밀값) 암호화.
 *
 * 2026-11-17 — 예전엔 AES-256-CBC(인증 없음)였고, `ENCRYPTION_KEY`가 64자가 아니면 **소스에 적힌 고정 값**으로 조용히 바꿔 암호화했다.
 * 운영에는 키가 있다(Sensitive 변수라 `vercel env pull`이 빈 값으로 내려준다 — 운영 런타임이 저장한 키를 푸는 것으로 확인).
 *  - 새 암호문은 `v2:` 꼴(AES-256-GCM — 위조·다른 키를 알아챔)로 쓴다.
 *  - 옛 꼴(`iv:암호문`, CBC)은 `ENCRYPTION_KEY` → 옛 비밀값(`API_KEY_ENCRYPTION_SECRET` 또는 고정 값) 순으로 풀어 본다(옛 꼴은 그대로 읽힌다).
 *  - **운영(`NODE_ENV=production`)에서 키가 없으면 암호화를 거절한다** — 고정 값으로 저장하지 않는다. 로컬·시험은 옛 꼴로 쓴다.
 * 환경 값은 이 모듈만 읽는다(`config.ts`는 가져오는 순간 필수 값을 요구해 시험·스크립트에서 쓰기 어렵다).
 */

const LEGACY_FIXED_SECRET = 'workon-api-key-enc-secret-32byte';
const V2 = 'v2:';

export interface Keyring {
  /** `ENCRYPTION_KEY` — 없으면 null */
  primary: Buffer | null;
  /** 옛 꼴을 풀어 볼 키, 앞에서부터 */
  legacy: Buffer[];
}

export function keyringFrom(env: { ENCRYPTION_KEY?: string; API_KEY_ENCRYPTION_SECRET?: string }): Keyring {
  const hex = (env.ENCRYPTION_KEY ?? '').trim();
  const primary = /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : null;
  const secret = Buffer.from((env.API_KEY_ENCRYPTION_SECRET || LEGACY_FIXED_SECRET).slice(0, 32).padEnd(32, '0'), 'utf8');
  return { primary, legacy: primary ? [primary, secret] : [secret] };
}

/** 운영에서 키가 없을 때 — 고정 값으로 암호화하지 않는다 */
export class EncryptionKeyMissingError extends Error {
  constructor() { super('ENCRYPTION_KEY가 설정되지 않아 비밀값을 저장할 수 없습니다.'); this.name = 'EncryptionKeyMissingError'; }
}

const envKeyring = (): Keyring =>
  keyringFrom({ ENCRYPTION_KEY: process.env.ENCRYPTION_KEY, API_KEY_ENCRYPTION_SECRET: process.env.API_KEY_ENCRYPTION_SECRET });

/** 지금 쓰는 키로 암호화 — 키가 있으면 `v2:iv:tag:암호문`(GCM), 없으면 옛 꼴 */
export function encryptWith(ring: Keyring, text: string): string {
  if (ring.primary) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', ring.primary, iv);
    const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return `${V2}${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
  }
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ring.legacy[0], iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${enc.toString('hex')}`;
}

const HEX = /^[0-9a-f]+$/i;

/** 풀린 글이 그럴듯한가 — 다른 키로 CBC를 풀면 덧붙임이 우연히 맞아 깨진 글이 나올 수 있다 */
function plausible(buf: Buffer): string | null {
  const s = buf.toString('utf8');
  if (!s || Buffer.from(s, 'utf8').compare(buf) !== 0) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f�]/.test(s)) return null;
  return s;
}

/** 풀기 — 못 풀면 빈 글(예전과 같음) */
export function decryptWith(ring: Keyring, text: string): string {
  if (typeof text !== 'string' || !text) return '';
  if (text.startsWith(V2)) {
    if (!ring.primary) return '';
    const [ivHex, tagHex, encHex] = text.slice(V2.length).split(':');
    if (!ivHex || !tagHex || encHex === undefined || ![ivHex, tagHex].every((h) => HEX.test(h)) || (encHex && !HEX.test(encHex))) return '';
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', ring.primary, Buffer.from(ivHex, 'hex'));
      d.setAuthTag(Buffer.from(tagHex, 'hex'));
      return Buffer.concat([d.update(Buffer.from(encHex, 'hex')), d.final()]).toString('utf8');
    } catch {
      return '';
    }
  }
  const [ivHex, encHex] = text.split(':');
  if (!ivHex || !encHex || !HEX.test(ivHex) || !HEX.test(encHex) || ivHex.length !== 32) return '';
  for (const key of ring.legacy) {
    try {
      const d = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
      const s = plausible(Buffer.concat([d.update(Buffer.from(encHex, 'hex')), d.final()]));
      if (s !== null) return s;
    } catch { /* 다음 키 */ }
  }
  return '';
}

export function encryptApiKey(text: string, env: { NODE_ENV?: string } = { NODE_ENV: process.env.NODE_ENV }): string {
  const ring = envKeyring();
  if (!ring.primary && env.NODE_ENV === 'production') throw new EncryptionKeyMissingError();
  return encryptWith(ring, text);
}

export function decryptApiKey(text: string): string {
  return decryptWith(envKeyring(), text);
}

export function maskApiKey(key: string): string {
  if (!key || key.length <= 8) return '••••••••';
  return key.substring(0, 10) + '••••••••••••' + key.substring(key.length - 4);
}

// backward-compat alias
export const maskKey = maskApiKey;
