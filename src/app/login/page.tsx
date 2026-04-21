'use client';

import { Suspense, useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectError = searchParams.get('error');
  const role = searchParams.get('role'); // 'admin' or 'user'
  const signupSuccess = searchParams.get('message') === 'signup-success';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage('');

    const response = await signIn('credentials', {
      redirect: false,
      email,
      password
    });

    setLoading(false);

    if (response?.error) {
      setMessage('이메일 또는 비밀번호가 올바르지 않습니다. 다시 시도해주세요.');
      return;
    }

    // 로그인 성공 후 역할에 따라 리다이렉트
    if (role === 'admin') {
      router.push('/admin');
    } else {
      router.push('/user');
    }
  }

  function getErrorMessage() {
    if (redirectError === 'unauthorized') {
      return '관리자 권한이 필요합니다. 관리자 계정으로 다시 로그인해주세요.';
    }

    if (redirectError === 'unauthenticated') {
      return '로그인이 필요합니다. 다시 로그인해주세요.';
    }

    return null;
  }

  const isAdminLogin = role === 'admin';

  return (
    <main className="min-h-screen px-6 py-16 mx-auto max-w-md">
      <section className="space-y-6">
        {/* 역할별 헤더 */}
        <div className="text-center">
          <div className={`inline-flex items-center justify-center w-16 h-16 rounded-full mb-4 ${
            isAdminLogin ? 'bg-blue-100 text-blue-600' : 'bg-green-100 text-green-600'
          }`}>
            {isAdminLogin ? (
              <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            ) : (
              <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
            )}
          </div>
          <h1 className="text-3xl font-semibold">
            {isAdminLogin ? '관리자 로그인' : '사용자 로그인'}
          </h1>
          <p className="text-slate-600 mt-2">
            {isAdminLogin
              ? '관리자 권한으로 시스템을 관리합니다.'
              : '사용자 계정으로 WORKON을 이용합니다.'
            }
          </p>
        </div>

        {getErrorMessage() ? (
          <div className="p-4 text-sm text-red-700 bg-red-100 rounded-lg">
            {getErrorMessage()}
          </div>
        ) : null}

        {signupSuccess ? (
          <div className="p-4 text-sm text-green-700 bg-green-100 rounded-lg">
            회원가입이 완료되었습니다! 로그인 정보를 입력해주세요.
          </div>
        ) : null}

        {message ? (
          <div className="p-4 text-sm text-red-700 bg-red-100 rounded-lg">{message}</div>
        ) : null}

        <form className="space-y-4" onSubmit={handleSubmit}>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">이메일</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              className="w-full px-4 py-2 mt-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-400"
              placeholder={isAdminLogin ? "admin@welfare.org" : "user@welfare.org"}
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-slate-700">비밀번호</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              className="w-full px-4 py-2 mt-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
          </label>

          <button
            type="submit"
            className={`w-full px-4 py-3 text-white rounded-lg disabled:opacity-50 ${
              isAdminLogin ? 'bg-blue-600 hover:bg-blue-700' : 'bg-green-600 hover:bg-green-700'
            }`}
            disabled={loading}
          >
            {loading ? '로그인 중...' : (isAdminLogin ? '관리자로 로그인' : '사용자로 로그인')}
          </button>
        </form>

        {/* 다른 역할로 로그인 링크 */}
        <div className="text-center space-y-2">
          <Link
            href={isAdminLogin ? "/login?role=user" : "/login?role=admin"}
            className="text-sm text-slate-500 hover:text-slate-700 underline"
          >
            {isAdminLogin ? '사용자로 로그인' : '관리자로 로그인'}
          </Link>
          {!isAdminLogin && (
            <Link href="/signup" className="text-sm text-green-700 hover:text-green-900 underline">
              아직 계정이 없으신가요? 회원가입
            </Link>
          )}
        </div>
      </section>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center">로딩 중...</div>}>
      <LoginForm />
    </Suspense>
  );
}
