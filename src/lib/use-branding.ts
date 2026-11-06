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

let cached: Branding | null = null;
// 서버가 실제로 답한 값인가(실패해 기본값으로 채운 것은 기억하지 않는다)
let cachedReal = false;
let inflight: Promise<Branding> | null = null;

function load(slug?: string): Promise<Branding> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;

  const url = slug ? `/api/branding?slug=${encodeURIComponent(slug)}` : '/api/branding';
  inflight = fetch(url)
    .then((r) => r.json())
    .then((r) => {
      const data: Branding = r.ok ? { ...FALLBACK, ...r.data } : FALLBACK;
      cached = data;
      cachedReal = Boolean(r.ok);
      return data;
    })
    .catch(() => FALLBACK)
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/** 로고를 바꾼 뒤 다시 받아오게 한다 */
export function resetBrandingCache() {
  cached = null;
  cachedReal = false;
}

export function useBranding(slug?: string): Branding {
  const [branding, setBranding] = useState<Branding | null>(cached);
  const [real, setReal] = useState(cachedReal);
  // 로그인한 화면은 이 사람이 마지막으로 받은 브랜딩을 먼저 보인다(branding-snapshot — 새로 열 때 기본값이 잠깐 뜨지 않게).
  // 세션은 서버 렌더링·첫 그림에서 'loading'이라 그때는 기억을 읽지 않는다(그림이 어긋나지 않음). 로그인 전 기관 화면(slug)은 기억하지 않는다
  const { data: session } = useSession();
  const userId = slug ? null : session?.user?.id ?? null;
  const remembered = useMemo(() => (userId && !branding ? readBrandingSnapshot(userId) : null), [userId, branding]);

  useEffect(() => {
    let alive = true;
    load(slug).then((data) => {
      if (!alive) return;
      setBranding(data);
      setReal(cachedReal);
    });
    return () => {
      alive = false;
    };
  }, [slug]);

  useEffect(() => {
    if (userId && branding && real) writeBrandingSnapshot(userId, branding);
  }, [userId, branding, real]);

  return branding ?? remembered ?? FALLBACK;
}
