import crypto from 'crypto';
import { readFileSync } from 'fs';
import { describe, expect, it, afterEach } from 'vitest';
import { EncryptionKeyMissingError, decryptApiKey, decryptWith, encryptApiKey, encryptWith, keyringFrom } from '@/lib/crypto';

/**
 * 2026-11-17 — 보관하는 비밀값(API 키·앱 결과 보낼 곳 서명 비밀값) 암호화. 예전엔 AES-256-CBC(인증 없음)였고 `ENCRYPTION_KEY`가
 * 64자가 아니면 소스의 고정 값으로 조용히 암호화했다. 새 암호문은 v2(AES-256-GCM), 옛 꼴은 그대로 읽히고,
 * 운영에서 키가 없으면 고정 값으로 저장하지 않고 거절한다.
 */

const KEY = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const FIXED = Buffer.from('workon-api-key-enc-secret-32byte', 'utf8');

/** 옛 코드가 쓰던 꼴(iv:암호문, CBC) */
function legacyEncrypt(key: Buffer, text: string) {
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-256-cbc', key, iv);
  return `${iv.toString('hex')}:${Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('hex')}`;
}

const saved = { ...process.env };
afterEach(() => {
  for (const k of ['ENCRYPTION_KEY', 'API_KEY_ENCRYPTION_SECRET']) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

describe('새 꼴(v2, GCM)', () => {
  const ring = keyringFrom({ ENCRYPTION_KEY: KEY });
  it('키가 있으면 v2로 쓰고 같은 키로 풀림', () => {
    const enc = encryptWith(ring, 'sk-ant-api03-xyz');
    expect(enc.startsWith('v2:')).toBe(true);
    expect(decryptWith(ring, enc)).toBe('sk-ant-api03-xyz');
    expect(encryptWith(ring, 'same')).not.toBe(encryptWith(ring, 'same')); // 매번 다른 iv
  });
  it('다른 키·고친 암호문은 빈 글(깨진 글을 돌려주지 않음)', () => {
    const enc = encryptWith(ring, 'wo_out_secret');
    expect(decryptWith(keyringFrom({ ENCRYPTION_KEY: OTHER }), enc)).toBe('');
    const last = enc.slice(-1) === '0' ? '1' : '0';
    expect(decryptWith(ring, enc.slice(0, -1) + last)).toBe('');
    expect(decryptWith(keyringFrom({}), enc)).toBe(''); // 키가 없으면 v2는 못 풂
  });
  it('이상한 글은 빈 글', () => {
    for (const t of ['', 'v2:', 'v2:zz:yy:xx', 'abc', 'xx:yy', null as unknown as string]) expect(decryptWith(ring, t)).toBe('');
  });
});

describe('옛 꼴(CBC)도 그대로 읽힘', () => {
  it('키로 쓴 옛 꼴 — 키가 있을 때', () => {
    const ring = keyringFrom({ ENCRYPTION_KEY: KEY });
    expect(decryptWith(ring, legacyEncrypt(Buffer.from(KEY, 'hex'), 'sk-ant-old'))).toBe('sk-ant-old');
  });
  it('고정 값으로 쓴 옛 꼴 — 키가 있어도 없어도', () => {
    const enc = legacyEncrypt(FIXED, 'sk-ant-fixed');
    expect(decryptWith(keyringFrom({ ENCRYPTION_KEY: KEY }), enc)).toBe('sk-ant-fixed');
    expect(decryptWith(keyringFrom({}), enc)).toBe('sk-ant-fixed');
  });
  it('API_KEY_ENCRYPTION_SECRET으로 쓴 옛 꼴', () => {
    const secret = 'my-secret';
    const enc = legacyEncrypt(Buffer.from(secret.padEnd(32, '0'), 'utf8'), 'k1');
    expect(decryptWith(keyringFrom({ API_KEY_ENCRYPTION_SECRET: secret }), enc)).toBe('k1');
  });
  it('어느 키로도 못 풀면 빈 글', () => {
    const enc = legacyEncrypt(Buffer.from(OTHER, 'hex'), 'nope');
    expect(decryptWith(keyringFrom({ ENCRYPTION_KEY: KEY }), enc)).toBe('');
  });
  it('64자 16진수가 아닌 키는 키로 보지 않음', () => {
    expect(keyringFrom({ ENCRYPTION_KEY: 'g'.repeat(64) }).primary).toBeNull();
    expect(keyringFrom({ ENCRYPTION_KEY: '' }).primary).toBeNull();
    expect(keyringFrom({ ENCRYPTION_KEY: ` ${KEY}\n` }).primary?.length).toBe(32);
  });
});

describe('운영에서 키가 없으면 고정 값으로 저장하지 않음', () => {
  it('production이면 거절, 그 밖은 옛 꼴로 씀', () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => encryptApiKey('x', { NODE_ENV: 'production' })).toThrow(EncryptionKeyMissingError);
    const enc = encryptApiKey('x', { NODE_ENV: 'test' });
    expect(enc.startsWith('v2:')).toBe(false);
    expect(decryptApiKey(enc)).toBe('x');
  });
  it('키가 있으면 production에서도 v2', () => {
    process.env.ENCRYPTION_KEY = KEY;
    const enc = encryptApiKey('x', { NODE_ENV: 'production' });
    expect(enc.startsWith('v2:')).toBe(true);
    expect(decryptApiKey(enc)).toBe('x');
  });
  it('저장하는 세 곳이 거절을 503 안내로 돌려준다', () => {
    for (const p of ['src/app/api/super/api-keys/system/route.ts', 'src/app/api/super/organizations/[id]/api-keys/route.ts', 'src/lib/apps/outbound/admin.ts']) {
      const s = readFileSync(p, 'utf8');
      expect(s, p).toMatch(/try \{ \w+ = encryptApiKey\([^)]*\); \} catch \{ return [^\n]*503/);
    }
  });
  it('ts-nocheck 없음', () => {
    expect(readFileSync('src/lib/crypto.ts', 'utf8')).not.toMatch(/@ts-nocheck/);
  });
});
