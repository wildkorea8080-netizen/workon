import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

function getKey(): Buffer {
  const secret = process.env.API_KEY_ENCRYPTION_SECRET ?? 'workon-api-key-enc-secret-32byte';
  return Buffer.from(secret.slice(0, 32).padEnd(32, '0'), 'utf8');
}

export function encryptApiKey(plaintext: string): string {
  const iv = randomBytes(16);
  const key = getKey();
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

export function decryptApiKey(encrypted: string): string {
  try {
    const [ivHex, encHex] = encrypted.split(':');
    if (!ivHex || !encHex) return '';
    const iv  = Buffer.from(ivHex, 'hex');
    const enc = Buffer.from(encHex, 'hex');
    const decipher = createDecipheriv('aes-256-cbc', getKey(), iv);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

export function maskKey(plaintext: string): string {
  if (!plaintext || plaintext.length < 8) return '••••••••';
  return plaintext.slice(0, 8) + '••••••••••••••••';
}
