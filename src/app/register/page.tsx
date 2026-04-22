'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';

interface TokenInfo {
  email: string;
  departmentId: string;
  role: string;
  expiresAt: string;
}

function RegisterForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get('token') ?? '';

  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [validating, setValidating] = useState(true);

  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) {
      setTokenError('초대 링크가 유효하지 않습니다.');
      setValidating(false);
      return;
    }

    fetch(`/api/register/validate-token?token=${encodeURIComponent(token)}`)
      .then(r => r.json())
      .then(result => {
        if (result.ok) {
          setTokenInfo(result.data);
        } else {
          setTokenError(result.error?.message || '유효하지 않거나 만료된 초대 링크입니다.');
        }
      })
      .catch(() => setTokenError('토큰 확인 중 오류가 발생했습니다.'))
      .finally(() => setValidating(false));
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);

    if (password.length < 8) {
      setSubmitError('비밀번호는 8자 이상이어야 합니다.');
      return;
    }
    if (password !== passwordConfirm) {
      setSubmitError('비밀번호가 일치하지 않습니다.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, name, password }),
      });
      const result = await res.json();

      if (!result.ok) {
        setSubmitError(result.error?.message || '회원가입에 실패했습니다.');
        return;
      }

      setDone(true);
      setTimeout(() => router.push('/login'), 3000);
    } catch {
      setSubmitError('네트워크 오류가 발생했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  // 로딩
  if (validating) {
    return (
      <div className="text-center py-12">
        <div className="inline-block w-8 h-8 border-4 border-brand-600 border-t-transparent rounded-full animate-spin mb-4" />
        <p className="text-slate-500 text-sm">초대 링크 확인 중...</p>
      </div>
    );
  }

  // 토큰 오류
  if (tokenError) {
    return (
      <div className="text-center py-8 space-y-4">
        <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto">
          <svg className="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-slate-800">링크가 유효하지 않습니다</h2>
        <p className="text-slate-500 text-sm">{tokenError}</p>
        <Link href="/login" className="inline-block mt-4 text-brand-600 hover:text-brand-700 text-sm font-medium">
          로그인 페이지로 이동
        </Link>
      </div>
    );
  }

  // 가입 완료
  if (done) {
    return (
      <div className="text-center py-8 space-y-4">
        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto">
          <svg className="w-8 h-8 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-slate-800">가입이 완료됐습니다!</h2>
        <p className="text-slate-500 text-sm">3초 후 로그인 페이지로 이동합니다.</p>
      </div>
    );
  }

  // 가입 폼
  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* 이메일 (수정 불가) */}
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">이메일</label>
        <input
          type="email"
          value={tokenInfo?.email ?? ''}
          disabled
          className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-500 text-sm cursor-not-allowed"
        />
        <p className="mt-1 text-xs text-slate-400">초대받은 이메일이 자동 입력됩니다.</p>
      </div>

      {/* 권한 표시 */}
      <div className="flex items-center gap-2 px-3 py-2 bg-brand-50 border border-brand-100 rounded-xl">
        <svg className="w-4 h-4 text-brand-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
        <span className="text-sm text-brand-700 font-medium">
          {tokenInfo?.role === 'ADMIN' ? '관리자' : '일반 직원'} 권한으로 가입합니다
        </span>
      </div>

      {/* 이름 */}
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">이름</label>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="홍길동"
          className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-400 focus:border-transparent"
        />
      </div>

      {/* 비밀번호 */}
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">비밀번호 <span className="text-red-400">*</span></label>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="8자 이상"
          required
          className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-400 focus:border-transparent"
        />
      </div>

      {/* 비밀번호 확인 */}
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">비밀번호 확인 <span className="text-red-400">*</span></label>
        <input
          type="password"
          value={passwordConfirm}
          onChange={e => setPasswordConfirm(e.target.value)}
          placeholder="비밀번호 재입력"
          required
          className={`w-full px-3 py-2.5 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-400 focus:border-transparent ${
            passwordConfirm && password !== passwordConfirm
              ? 'border-red-300 bg-red-50'
              : 'border-slate-200'
          }`}
        />
        {passwordConfirm && password !== passwordConfirm && (
          <p className="mt-1 text-xs text-red-500">비밀번호가 일치하지 않습니다.</p>
        )}
      </div>

      {submitError && (
        <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">
          {submitError}
        </div>
      )}

      <button
        type="submit"
        disabled={submitting || (!!passwordConfirm && password !== passwordConfirm)}
        className="w-full py-2.5 bg-brand-600 hover:bg-brand-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-semibold rounded-xl text-sm transition-colors"
      >
        {submitting ? '가입 처리 중...' : '가입 완료'}
      </button>
    </form>
  );
}

export default function RegisterPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-brand-50 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* 헤더 */}
        <div className="text-center mb-8">
          <div className="w-12 h-12 bg-brand-600 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-slate-900">WORKON 가입</h1>
          <p className="text-slate-500 text-sm mt-1">초대를 통해 계정을 생성합니다</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 px-8 py-8">
          <Suspense fallback={
            <div className="text-center py-8 text-slate-400 text-sm">로딩 중...</div>
          }>
            <RegisterForm />
          </Suspense>
        </div>

        <p className="text-center text-xs text-slate-400 mt-6">
          이미 계정이 있으신가요?{' '}
          <Link href="/login" className="text-brand-600 hover:text-brand-700 font-medium">
            로그인
          </Link>
        </p>
      </div>
    </div>
  );
}
