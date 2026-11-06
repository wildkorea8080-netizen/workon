import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { BRANDING_SNAPSHOT_KEY, cleanSnapshot, readBrandingSnapshot, writeBrandingSnapshot } from '@/lib/branding-snapshot';

/** 마지막 기관 브랜딩 기억(2026-11-06) — 새로 열 때 기본값('AI 업무도우미'·청록)이 잠깐 뜨지 않게, 사람마다 */
const read = (p: string) => readFileSync(p, 'utf8');
const ORG = '11111111-2222-3333-4444-555555555555';
const good = { name: '한국공사', logoUrl: `/api/branding/logo?org=${ORG}`, slug: 'kc', aiNotice: '안내', themeColor: '#003087' };

function memoryStore() {
  const map = new Map<string, string>();
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
}

describe('브랜딩 기억', () => {
  it('같은 사람이면 되읽고, 다른 사람이면 쓰지 않는다', () => {
    const store = memoryStore();
    writeBrandingSnapshot('u1', good, store);
    expect(readBrandingSnapshot('u1', store)).toEqual(good);
    expect(readBrandingSnapshot('u2', store)).toBeNull();
    expect(readBrandingSnapshot('', store)).toBeNull();
    expect(JSON.parse(store.map.get(BRANDING_SNAPSHOT_KEY)!).userId).toBe('u1');
  });

  it('저장소 값은 다시 본다 — 우리 로고 라우트만, 맞는 색만', () => {
    expect(cleanSnapshot({ ...good, logoUrl: 'https://evil.example/x.png' })).toBeNull();
    expect(cleanSnapshot({ ...good, logoUrl: 'javascript:alert(1)' })).toBeNull();
    expect(cleanSnapshot({ ...good, logoUrl: null })?.logoUrl).toBeNull();
    expect(cleanSnapshot({ ...good, themeColor: '#ffff00' })?.themeColor).toBeNull();
    expect(cleanSnapshot({ ...good, themeColor: '#ABCDEF' })).toBeTruthy();
    expect(cleanSnapshot({ ...good, themeColor: '#003087' })?.themeColor).toBe('#003087');
    expect(cleanSnapshot({ ...good, name: '  ' })).toBeNull();
    expect(cleanSnapshot({ ...good, aiNotice: 3 })).toBeNull();
    expect(cleanSnapshot(null)).toBeNull();
  });

  it('깨진 값·못 쓰는 저장소는 기본값으로(던지지 않음)', () => {
    const store = memoryStore();
    store.map.set(BRANDING_SNAPSHOT_KEY, 'not json');
    expect(readBrandingSnapshot('u1', store)).toBeNull();
    store.map.set(BRANDING_SNAPSHOT_KEY, JSON.stringify({ userId: 'u1', data: { name: 1 } }));
    expect(readBrandingSnapshot('u1', store)).toBeNull();
    const throwing = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(readBrandingSnapshot('u1', throwing)).toBeNull();
    expect(() => writeBrandingSnapshot('u1', good, throwing)).not.toThrow();
    expect(readBrandingSnapshot('u1', null)).toBeNull();
  });

  it('useBranding — 서버가 실제로 답한 값만 기억, 기억은 로그인한 사람·응답 전에만, 로그인 전 기관 화면은 안 씀', () => {
    const hook = read('src/lib/use-branding.ts');
    expect(hook).toContain('cachedReal = Boolean(r.ok);');
    expect(hook).toContain('if (userId && branding && real) writeBrandingSnapshot(userId, branding);');
    expect(hook).toContain('const userId = slug ? null : session?.user?.id ?? null;');
    expect(hook).toContain('userId && !branding ? readBrandingSnapshot(userId) : null');
    expect(hook).toContain('return branding ?? remembered ?? FALLBACK;');
  });
});
