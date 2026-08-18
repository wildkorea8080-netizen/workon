'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useBranding } from '@/lib/use-branding';

/**
 * 로그인 폼.
 *
 * /login 과 /signin/{slug} 가 함께 쓴다. 화면을 복제하면 한쪽만 고치는
 * 사고가 나므로 한 벌만 둔다. slug가 있으면 그 기관 브랜딩으로 그린다.
 */
export default function LoginForm({ slug }: { slug?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // 기관 전용 경로(/signin/{slug})면 그 기관 브랜딩으로 그린다.
  const branding = useBranding(slug);
  const redirectError = searchParams.get('error');
  const role = searchParams.get('role');
  const signupSuccess = searchParams.get('message') === 'signup-success';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const isAdminLogin = role === 'admin';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMessage('');
    const res = await signIn('credentials', { redirect: false, email, password });
    setLoading(false);
    if (res?.error) {
      setMessage('이메일 또는 비밀번호가 올바르지 않습니다.');
      return;
    }
    router.push(isAdminLogin ? '/admin' : '/');
  }

  const errorMsg =
    redirectError === 'unauthorized' ? '관리자 권한이 필요합니다.' :
    redirectError === 'unauthenticated' ? '다시 로그인해주세요.' : null;

  return (
    <main className="min-h-screen bg-gradient-to-br from-[#001a5c] via-[#003087] to-[#0066CC] flex items-center justify-center px-4">
      <div className="w-full max-w-[420px]">

        {/* 로고 영역 */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-white/15 backdrop-blur mb-4 shadow-lg">
            {branding.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={branding.logoUrl} alt="" className="max-w-[44px] max-h-[44px] object-contain" />
            ) : (
              <span className="text-3xl">🏛️</span>
            )}
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">{branding.name}</h1>
          <p className="text-white/60 text-sm mt-1">
            {slug ? '기관 전용 로그인' : '공공기관 전용 AI 비서 플랫폼'}
          </p>
        </div>

        {/* 카드 */}
        <div className="bg-white rounded-2xl shadow-2xl p-8">
          <div className="mb-6">
            <h2 className="text-lg font-bold text-slate-900">
              {isAdminLogin ? '관리자 로그인' : '로그인'}
            </h2>
            <p className="text-sm text-slate-500 mt-0.5">
              {isAdminLogin ? '관리자 계정으로 로그인합니다.' : '계정 정보를 입력해주세요.'}
            </p>
          </div>

          {/* 알림 */}
          {errorMsg && (
            <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 flex items-center gap-2">
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {errorMsg}
            </div>
          )}
          {signupSuccess && (
            <div className="mb-4 px-4 py-3 bg-green-50 border border-green-200 rounded-xl text-sm text-green-700 flex items-center gap-2">
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              회원가입이 완료되었습니다!
            </div>
          )}
          {message && (
            <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
              {message}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">이메일</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                placeholder="example@gov.kr"
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-[#003087]/30 focus:border-[#003087] transition-all"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">비밀번호</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                placeholder="••••••••"
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-[#003087]/30 focus:border-[#003087] transition-all"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-[#003087] hover:bg-[#002070] disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-semibold rounded-xl text-sm transition-colors shadow-sm mt-2"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  로그인 중...
                </span>
              ) : '로그인'}
            </button>
          </form>

          {/* 하단 링크 */}
          <div className="mt-5 pt-5 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
            <Link
              href={isAdminLogin ? '/login' : '/login?role=admin'}
              className="hover:text-[#003087] transition-colors"
            >
              {isAdminLogin ? '일반 사용자 로그인' : '관리자 로그인'}
            </Link>
            {!isAdminLogin && (
              <Link href="/signup" className="hover:text-[#003087] transition-colors">
                계정이 없으신가요? <span className="font-semibold text-[#003087]">회원가입</span>
              </Link>
            )}
          </div>
        </div>

        {/* 하단 문구 */}
        <p className="text-center text-white/40 text-xs mt-6">
          © 2026 WORKON. 공공기관 전용 서비스
        </p>
      </div>
    </main>
  );
}
