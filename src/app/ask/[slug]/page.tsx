import type { CSSProperties } from 'react';
import type { Metadata } from 'next';
import { loadPublicConfig } from '@/lib/public-ask/service';
import { publicAskDeps } from '@/lib/public-ask/deps';
import { themeStyle } from '@/lib/theme-color';
import PublicAskChat from '@/components/public-ask/PublicAskChat';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  try {
    const r = await loadPublicConfig(params.slug, publicAskDeps());
    return { title: r.ok ? `${r.config.orgName} AI 민원 상담` : 'AI 민원 상담', robots: { index: false } };
  } catch {
    return { title: 'AI 민원 상담', robots: { index: false } };
  }
}

/**
 * 시민용 민원 상담 창(2026-11-27, 0136) — 로그인 없이 열린다. 기관 홈페이지에는 `/ask/embed.js`가 이 화면을 작은 창(iframe)으로 띄운다
 * (넣을 수 있는 홈페이지는 미들웨어가 frame-ancestors로 건다). `?embed=1`이면 머리를 줄인다
 */
export default async function PublicAskPage({ params, searchParams }: { params: { slug: string }; searchParams: { embed?: string } }) {
  let result: Awaited<ReturnType<typeof loadPublicConfig>> | null = null;
  try {
    result = await loadPublicConfig(params.slug, publicAskDeps());
  } catch {
    result = null;
  }
  const embed = searchParams.embed === '1';
  const style = { fontFamily: 'Pretendard, -apple-system, sans-serif', ...((result?.ok ? themeStyle(result.config.themeColor) : null) ?? {}) } as CSSProperties;

  if (!result || !result.ok) {
    const message = result ? result.message : '지금 상담 창을 열지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
    return (
      <main style={style} className="flex min-h-screen items-center justify-center bg-[#F7F8FC] px-4 text-[#22283D]">
        <p className="rounded-2xl border border-[#E7E9F1] bg-white px-6 py-8 text-center text-[15px] text-slate-600">{message}</p>
      </main>
    );
  }
  return (
    <main style={style} className="min-h-screen bg-[#F7F8FC] text-[#22283D]">
      <PublicAskChat slug={params.slug} config={result.config} embed={embed} />
    </main>
  );
}
