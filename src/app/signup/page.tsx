'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);

    const response = await fetch('/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, fullName, password, confirmPassword })
    });

    const result = await response.json();
    setLoading(false);

    if (!result.ok) {
      setError(result.error?.message || '회원가입 중 오류가 발생했습니다.');
      return;
    }

    setMessage(result.data?.message || '회원가입이 완료되었습니다.');
    setEmail('');
    setFullName('');
    setPassword('');
    setConfirmPassword('');

    // 성공 메시지 표시 후 로그인 페이지로 리디렉트
    setTimeout(() => {
      router.push('/login?role=user&message=signup-success');
    }, 2000);
  }

  return (
    <main className="min-h-screen px-6 py-16 mx-auto max-w-md">
      <section className="space-y-6">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full mb-4 bg-green-100 text-green-600">
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>
          <h1 className="text-3xl font-semibold">회원가입</h1>
          <p className="text-slate-600 mt-2">이메일로 새 WORKON 계정을 생성하세요.</p>
        </div>

        {error ? (
          <div className="p-4 text-sm text-red-700 bg-red-100 rounded-lg">{error}</div>
        ) : null}

        {message ? (
          <div className="p-4 text-sm text-green-700 bg-green-100 rounded-lg">{message}</div>
        ) : null}

        <form className="space-y-4" onSubmit={handleSubmit}>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">이름</span>
            <input
              type="text"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              required
              className="w-full px-4 py-2 mt-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-400"
              placeholder="홍길동"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-slate-700">이메일</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              className="w-full px-4 py-2 mt-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-400"
              placeholder="example@company.com"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-slate-700">비밀번호</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={8}
              className="w-full px-4 py-2 mt-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-400"
              placeholder="8자 이상"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-slate-700">비밀번호 확인</span>
            <input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
              minLength={8}
              className="w-full px-4 py-2 mt-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-400"
              placeholder="비밀번호를 다시 입력하세요"
            />
          </label>

          <button
            type="submit"
            disabled={loading}
            className="w-full px-4 py-3 text-white rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-50"
          >
            {loading ? '가입 중...' : '회원가입'}
          </button>
        </form>

        <div className="text-center">
          <p className="text-sm text-slate-500">이미 계정이 있으신가요?</p>
          <Link href="/login?role=user" className="text-sm text-green-700 hover:text-green-900 underline">
            로그인으로 이동하기
          </Link>
        </div>
      </section>
    </main>
  );
}
