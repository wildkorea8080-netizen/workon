'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirect = searchParams.get('redirect') ?? '/super';

  const [tab, setTab] = useState<'login' | 'setup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [setupKey, setSetupKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupDone, setSetupDone] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/super/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!data.ok) { setError(data.error); setLoading(false); return; }
      // 쿠키가 브라우저에 반영될 시간을 준 뒤 이동
      setTimeout(() => {
        window.location.href = redirect;
      }, 300);
    } catch {
      setError('네트워크 오류가 발생했습니다.');
      setLoading(false);
    }
  };

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/super/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name, setupKey }),
      });
      const data = await res.json();
      if (!data.ok) { setError(data.error); return; }
      setSetupDone(true);
    } catch {
      setError('네트워크 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#0F172A] flex items-center justify-center px-4">
      <div className="w-full max-w-[400px]">

        {/* 로고 */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-[#7C3AED]/20 border border-[#7C3AED]/30 mb-4">
            <span className="text-3xl">🔐</span>
          </div>
          <h1 className="text-xl font-bold text-white tracking-tight">WORKON SUPER ADMIN</h1>
          <p className="text-slate-400 text-xs mt-1">솔루션 운영자 전용 포털</p>
        </div>

        {/* 카드 */}
        <div className="bg-[#1E293B] border border-slate-700 rounded-2xl p-8 shadow-2xl">

          {/* 탭 */}
          <div className="flex gap-1 p-1 bg-[#0F172A] rounded-xl mb-6">
            {(['login', 'setup'] as const).map(t => (
              <button
                key={t}
                onClick={() => { setTab(t); setError(null); }}
                className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-colors ${
                  tab === t
                    ? 'bg-[#7C3AED] text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {t === 'login' ? '로그인' : '최초 계정 생성'}
              </button>
            ))}
          </div>

          {error && (
            <div className="mb-4 px-4 py-3 bg-red-900/30 border border-red-700/50 rounded-xl text-xs text-red-400">
              {error}
            </div>
          )}

          {setupDone ? (
            <div className="text-center space-y-3">
              <div className="text-3xl">✅</div>
              <p className="text-sm font-semibold text-green-400">슈퍼관리자 계정 생성 완료</p>
              <p className="text-xs text-slate-400">로그인 탭에서 접속하세요.</p>
              <button
                onClick={() => { setTab('login'); setSetupDone(false); setError(null); }}
                className="w-full py-2.5 bg-[#7C3AED] hover:bg-[#6D28D9] text-white text-sm font-semibold rounded-xl transition-colors"
              >
                로그인으로 이동
              </button>
            </div>
          ) : tab === 'login' ? (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">이메일</label>
                <input
                  type="email" required value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="super@workon.ai"
                  className="w-full px-4 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-[#7C3AED]/50 focus:border-[#7C3AED]"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">비밀번호</label>
                <input
                  type="password" required value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full px-4 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-[#7C3AED]/50 focus:border-[#7C3AED]"
                />
              </div>
              <button
                type="submit" disabled={loading}
                className="w-full py-3 bg-[#7C3AED] hover:bg-[#6D28D9] disabled:bg-slate-700 disabled:cursor-not-allowed text-white font-semibold rounded-xl text-sm transition-colors mt-2 flex items-center justify-center gap-2"
              >
                {loading ? (
                  <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                  </svg>인증 중...</>
                ) : '슈퍼관리자 로그인'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleSetup} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">셋업 키 <span className="text-red-400">*</span></label>
                <input
                  type="password" required value={setupKey} onChange={e => setSetupKey(e.target.value)}
                  placeholder="환경변수 SUPER_ADMIN_SETUP_KEY"
                  className="w-full px-4 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-[#7C3AED]/50 focus:border-[#7C3AED]"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">이름</label>
                <input
                  type="text" required value={name} onChange={e => setName(e.target.value)}
                  placeholder="홍길동"
                  className="w-full px-4 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-[#7C3AED]/50 focus:border-[#7C3AED]"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">이메일</label>
                <input
                  type="email" required value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="super@workon.ai"
                  className="w-full px-4 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-[#7C3AED]/50 focus:border-[#7C3AED]"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">비밀번호 (8자 이상)</label>
                <input
                  type="password" required minLength={8} value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full px-4 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-[#7C3AED]/50 focus:border-[#7C3AED]"
                />
              </div>
              <button
                type="submit" disabled={loading}
                className="w-full py-3 bg-[#7C3AED] hover:bg-[#6D28D9] disabled:bg-slate-700 disabled:cursor-not-allowed text-white font-semibold rounded-xl text-sm transition-colors mt-1"
              >
                {loading ? '생성 중...' : '슈퍼관리자 계정 생성'}
              </button>
            </form>
          )}
        </div>

        <p className="text-center text-slate-600 text-xs mt-5">
          일반 사용자 로그인은{' '}
          <a href="/login" className="text-slate-500 hover:text-slate-400 underline">기관 포털</a>을 이용하세요
        </p>
      </div>
    </main>
  );
}

export default function SuperLoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-[#0F172A] flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-[#7C3AED]/30 border-t-[#7C3AED] rounded-full animate-spin" />
      </div>
    }>
      <LoginForm />
    </Suspense>
  );
}
