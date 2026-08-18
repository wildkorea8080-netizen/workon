'use client';

import { useState, useEffect } from 'react';
import { DEFAULT_AI_NOTICE } from '@/lib/branding';

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
}

/** 서버가 답하기 전 화면. 여기서 빈 문자열을 쓰면 제목이 잠깐 사라진다. */
const FALLBACK: Branding = {
  name: 'AI 업무도우미',
  logoUrl: null,
  slug: null,
  aiNotice: DEFAULT_AI_NOTICE,
};

let cached: Branding | null = null;
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
}

export function useBranding(slug?: string): Branding {
  const [branding, setBranding] = useState<Branding>(cached ?? FALLBACK);

  useEffect(() => {
    let alive = true;
    load(slug).then((data) => {
      if (alive) setBranding(data);
    });
    return () => {
      alive = false;
    };
  }, [slug]);

  return branding;
}
