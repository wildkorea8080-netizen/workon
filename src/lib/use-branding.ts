'use client';

import { useState, useEffect, useMemo } from 'react';
import { useSession } from 'next-auth/react';
import { DEFAULT_AI_NOTICE } from '@/lib/branding';
import { readBrandingSnapshot, writeBrandingSnapshot } from '@/lib/branding-snapshot';

/**
 * 기관 브랜딩 조회 (0020).
 *
 * 화면마다 fetch를 따로 쓰면 같은 값을 여러 번 받아오고, 실패했을 때
 * 어떤 화면은 기관명이 나오고 어떤 화면은 안 나오는 상태가 된다.
 * 모듈 수준에 한 번 담아 두고 나눠 쓴다.
 */

export interface Branding {
  name: string;
  logoUrl: string | null;
  slug: string | null;
  aiNotice: string;
  /** 기관 테마 색(0067, `#rrggbb`). null = 기본 청록 */
  themeColor: string | null;
}

/** 서버가 답하기 전 화면. 여기서 빈 문자열을 쓰면 제목이 잠깐 사라진다. */
const FALLBACK: Branding = {
  name: 'AI 업무도우미',
  logoUrl: null,
  slug: null,
  aiNotice: DEFAULT_AI_NOTICE,
  themeColor: null,
};

type Entry = {
  data: Branding;
  /** 서버가 실제로 답한 값인가(실패해 기본값으로 채운 것은 기억하지 않는다) */
  real: boolean;
};

/**
 * 받은 브랜딩은 **누구의·어느 경로의** 것인지 열쇠와 함께 담는다(2026-11-06).
 * 예전에는 한 벌만 담아 공용 로그인(`/login`, 로그인 전이라 기본 브랜딩)에서 받은 값이 로그인 뒤 화면 이동(새로 읽지 않음)에도
 * 그대로 쓰여, 다시 읽기 전까지 기관명·로고·테마 색이 기본값이었다(기억까지 기본값으로 덮였다). 기관 전용 로그인(slug)도 마찬가지
 */
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry>>();

/**
 * 열쇠 — 기관 경로면 `slug:경로`, 로그인했으면 `user:id`, 로그인 전이면 `anon`.
 * 세션을 확인하는 중('loading')에는 null — 누구의 것인지 모르니 받지 않는다
 */
export function brandingKey(
  slug: string | undefined,
  status: 'loading' | 'authenticated' | 'unauthenticated',
  userId: string | null,
): string | null {
  if (slug) return `slug:${slug}`;
  if (status === 'loading') return null;
  return status === 'authenticated' && userId ? `user:${userId}` : 'anon';
}

function load(key: string, slug?: string): Promise<Entry> {
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(key);
  if (running) return running;

  const url = slug ? `/api/branding?slug=${encodeURIComponent(slug)}` : '/api/branding';
  const p = fetch(url)
    .then((r) => r.json())
    .then((r): Entry => {
      const entry: Entry = r.ok ? { data: { ...FALLBACK, ...r.data }, real: true } : { data: FALLBACK, real: false };
      cache.set(key, entry);
      return entry;
    })
    .catch((): Entry => ({ data: FALLBACK, real: false }))
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

/** 로고·테마 색을 바꾼 뒤 다시 받아오게 한다 */
export function resetBrandingCache() {
  cache.clear();
}

export function useBranding(slug?: string): Branding {
  const { data: session, status } = useSession();
  const userId = session?.user?.id ?? null;
  const key = brandingKey(slug, status, userId);
  const [entry, setEntry] = useState<{ key: string; value: Entry } | null>(() => {
    const hit = key ? cache.get(key) : undefined;
    return key && hit ? { key, value: hit } : null;
  });
  // 열쇠가 바뀌면(로그인·다른 사람) 예전 열쇠의 값은 쓰지 않는다
  const current = entry && entry.key === key ? entry.value : key ? cache.get(key) ?? null : null;

  // 로그인한 화면은 이 사람이 마지막으로 받은 브랜딩을 먼저 보인다(branding-snapshot — 새로 열 때 기본값이 잠깐 뜨지 않게).
  // 세션은 서버 렌더링·첫 그림에서 'loading'이라 그때는 기억을 읽지 않는다(그림이 어긋나지 않음). 로그인 전 기관 화면(slug)은 기억하지 않는다
  const snapshotUser = !slug && status === 'authenticated' ? userId : null;
  const remembered = useMemo(() => (snapshotUser && !current ? readBrandingSnapshot(snapshotUser) : null), [snapshotUser, current]);

  useEffect(() => {
    if (!key) return;
    let alive = true;
    load(key, slug).then((value) => {
      if (alive) setEntry({ key, value });
    });
    return () => {
      alive = false;
    };
  }, [key, slug]);

  useEffect(() => {
    if (snapshotUser && current?.real) writeBrandingSnapshot(snapshotUser, current.data);
  }, [snapshotUser, current]);

  return current?.data ?? remembered ?? FALLBACK;
}
