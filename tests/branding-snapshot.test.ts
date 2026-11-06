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
    expect(hook).toContain("r.ok ? { data: { ...FALLBACK, ...r.data }, real: true } : { data: FALLBACK, real: false }");
    expect(hook).toContain('if (snapshotUser && current?.real) writeBrandingSnapshot(snapshotUser, current.data);');
    expect(hook).toContain("const snapshotUser = !slug && status === 'authenticated' ? userId : null;");
    expect(hook).toContain('snapshotUser && !current ? readBrandingSnapshot(snapshotUser) : null');
    expect(hook).toContain('return current?.data ?? remembered ?? FALLBACK;');
  });
});

describe('브랜딩 받기 열쇠 — 누구의·어느 경로의 값인지(2026-11-06)', () => {
  it('기관 경로·로그인한 사람·로그인 전을 가르고, 세션 확인 중에는 받지 않는다', async () => {
    const { brandingKey } = await import('@/lib/use-branding');
    expect(brandingKey('kc', 'loading', null)).toBe('slug:kc');
    expect(brandingKey('kc', 'authenticated', 'u1')).toBe('slug:kc');
    expect(brandingKey(undefined, 'loading', null)).toBeNull();
    expect(brandingKey(undefined, 'unauthenticated', null)).toBe('anon');
    expect(brandingKey(undefined, 'authenticated', 'u1')).toBe('user:u1');
    expect(brandingKey(undefined, 'authenticated', 'u2')).toBe('user:u2');
    // 세션은 있는데 id가 없으면 로그인 전과 같은 열쇠(사람의 기억에 쓰지 않음)
    expect(brandingKey(undefined, 'authenticated', null)).toBe('anon');
  });

  it('한 벌만 담던 캐시가 돌아오지 않는다 — 열쇠별로 담고 열쇠가 바뀌면 예전 값을 안 씀', () => {
    const hook = read('src/lib/use-branding.ts');
    expect(hook).toContain('const cache = new Map<string, Entry>();');
    expect(hook).not.toMatch(/^let cached/m);
    expect(hook).toContain('const current = entry && entry.key === key ? entry.value : key ? cache.get(key) ?? null : null;');
  });
});
