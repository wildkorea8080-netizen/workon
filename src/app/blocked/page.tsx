'use client';

import { useEffect, useState, Suspense } from 'react';
import { signOut } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { useBranding } from '@/lib/use-branding';

/**
 * 허용되지 않은 네트워크에서 접속했을 때 보이는 화면.
 *
 * **왜 막혔는지와 지금 내 주소를 함께 보여줍니다.** 그냥 "접근할 수
 * 없습니다"만 띄우면 담당자는 자기 계정이 잘못됐다고 생각하고, 관리자에게는
 * "안 들어가진다"는 말밖에 전할 수 없습니다. 주소를 알려주면 관리자가 그
 * 대역을 허용 목록에 넣을지 바로 판단합니다.
 */

function BlockedBody() {
  const params = useSearchParams();
  const branding = useBranding();
  const ip = params.get('ip');
  const [copied, setCopied] = useState(false);

  // 차단 시도를 남긴다. 미들웨어(Edge)에서는 서비스 키를 쓸 수 없어
  // 여기서 알린다. 서버가 IP를 다시 판정하므로 이 호출로 가짜 기록을
  // 넣을 수는 없다.
  useEffect(() => {
    fetch('/api/access-denied', { method: 'POST' }).catch(() => {});
  }, []);

  const copy = async () => {
    if (!ip) return;
    try {
      await navigator.clipboard.writeText(ip);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* 클립보드가 막힌 환경도 있다. 주소는 화면에 이미 떠 있다. */
    }
  };

  return (
    <div className="min-h-screen bg-[#F5F7FA] flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-sm p-8 text-center">
        <div className="w-14 h-14 rounded-2xl bg-amber-50 border border-amber-200 flex items-center justify-center mx-auto mb-5">
          <svg className="w-7 h-7 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.48 0l-7.1 12.25A2 2 0 004.99 19z" />
          </svg>
        </div>

        <h1 className="text-lg font-bold text-slate-900">
          허용되지 않은 네트워크입니다
        </h1>
        <p className="text-sm text-slate-500 mt-2 leading-relaxed">
          {branding.name}은(는) 기관이 지정한 네트워크에서만 이용할 수 있습니다.
          기관 내부망에서 다시 접속해주세요.
        </p>

        {ip && (
          <div className="mt-5 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
            <p className="text-[11px] text-slate-400 mb-1">지금 접속한 주소</p>
            <div className="flex items-center justify-center gap-2">
              <code className="text-sm font-mono text-slate-800">{ip}</code>
              <button
                onClick={copy}
                className="text-[11px] text-[#003087] hover:underline"
              >
                {copied ? '복사됨' : '복사'}
              </button>
            </div>
          </div>
        )}

        <p className="text-xs text-slate-400 mt-5 leading-relaxed">
          재택근무 등으로 이 주소에서 이용해야 한다면 위 주소를 기관 관리자에게
          알려 허용 목록에 추가를 요청하세요.
        </p>

        <button
          onClick={() => signOut({ callbackUrl: '/login' })}
          className="mt-6 w-full py-2.5 rounded-xl border border-slate-200 text-sm font-semibold text-slate-600 hover:bg-slate-50 transition-colors"
        >
          로그아웃
        </button>
      </div>
    </div>
  );
}

export default function BlockedPage() {
  // useSearchParams는 Suspense 경계 안에서만 쓸 수 있다
  return (
    <Suspense fallback={null}>
      <BlockedBody />
    </Suspense>
  );
}
