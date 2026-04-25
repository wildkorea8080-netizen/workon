// @ts-nocheck
/* eslint-disable @typescript-eslint/no-require-imports */
import crypto from 'crypto';

function getKey(): Buffer {
  const hexKey = process.env.ENCRYPTION_KEY;
  if (hexKey && hexKey.length === 64) return Buffer.from(hexKey, 'hex');
  const str = (process.env.API_KEY_ENCRYPTION_SECRET ?? 'workon-api-key-enc-secret-32byte')
    .slice(0, 32).padEnd(32, '0');
  return Buffer.from(str, 'utf8');
}

export function encryptApiKey(text: string): string {
  const iv     = crypto.randomBytes(16);
  const key    = getKey();
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const enc    = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + enc.toString('hex');
}

export function decryptApiKey(text: string): string {
  try {
    const [ivHex, encHex] = text.split(':');
    if (!ivHex || !encHex) return '';
    const key      = getKey();
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
    const dec      = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
    return dec.toString('utf8');
  } catch { return ''; }
}

export function maskApiKey(key: string): string {
  if (!key || key.length <= 8) return '••••••••';
  return key.substring(0, 10) + '••••••••••••' + key.substring(key.length - 4);
}

// backward-compat alias
export const maskKey = maskApiKey;
