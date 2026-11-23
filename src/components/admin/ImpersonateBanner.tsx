'use client';

import { confirmedPost, IMPERSONATION_END_FAILED } from '@/lib/confirmed-post';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface ImpersonateBannerProps {
  orgName: string;
}

export default function ImpersonateBanner({ orgName }: ImpersonateBannerProps) {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const [error, setError] = useState<string | null>(null);

  const handleReturn = async () => {
    setLoading(true);
    setError(null);
    // 서버가 실제로 끝냈을 때만 슈퍼관리자 포털로 — 실패했는데 이동하면 이 기관 관리자 로그인이 남은 채 끝난 줄 안다(2026-11-20)
    if (await confirmedPost('/api/super/impersonate/end')) {
      window.location.href = '/super/organizations';
      return;
    }
    setError(IMPERSONATION_END_FAILED);
    setLoading(false);
  };

  return (
    <div className="fixed top-0 left-0 right-0 z-[200] bg-[#FEF3C7] border-b-2 border-[#F59E0B] px-4 py-2.5">
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="text-lg flex-shrink-0">⚠️</span>
          <div>
            <span className="text-sm font-bold text-[#92400E]">슈퍼관리자 대리 접근 중</span>
            <span className="mx-2 text-[#B45309]">|</span>
            <span className="text-sm font-semibold text-[#92400E]">{orgName}</span>
            <p className="text-xs text-[#B45309] leading-tight">실제 데이터에 영향을 줄 수 있습니다. 업무 확인 후 반드시 복귀하세요.</p>
            {error && <p role="alert" className="text-xs font-bold text-red-700 leading-tight mt-0.5">{error}</p>}
          </div>
        </div>
        <button
          onClick={handleReturn}
          disabled={loading}
          className="flex-shrink-0 flex items-center gap-2 px-4 py-2 bg-[#92400E] hover:bg-[#78350F] disabled:bg-[#B45309] text-white text-xs font-bold rounded-lg transition-colors"
        >
          {loading ? (
            <>
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              복귀 중...
            </>
          ) : (
            <>
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              슈퍼관리자로 복귀
            </>
          )}
        </button>
      </div>
    </div>
  );
}
