'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';

function SignupForm() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const inviteToken  = searchParams.get('invite') ?? '';

  const [email,           setEmail]           = useState('');
  const [fullName,        setFullName]         = useState('');
  const [password,        setPassword]         = useState('');
  const [confirmPassword, setConfirmPassword]  = useState('');
  const [message,         setMessage]          = useState('');
  const [error,           setError]            = useState('');
  const [loading,         setLoading]          = useState(false);
  const [inviteInfo,      setInviteInfo]       = useState<{ orgName?: string; role?: string; email?: string } | null>(null);

  useEffect(() => {
    if (!inviteToken) return;
    fetch(`/api/signup/invite-info?token=${inviteToken}`)
      .then(r => r.json())
      .then(d => {
        if (d.ok) {
          setInviteInfo(d.data);
          // 초대 이메일이 있으면 기본값으로 채워주되 수정 가능
          if (d.data?.email) setEmail(d.data.email);
        }
      })
      .catch(() => {});
  }, [inviteToken]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(''); setMessage(''); setLoading(true);

    const response = await fetch('/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, fullName, password, confirmPassword, inviteToken }),
    });

    const result = await response.json();
    setLoading(false);

    if (!result.ok) { setError(result.error?.message || '회원가입 중 오류가 발생했습니다.'); return; }
    setMessage(result.data?.message || '회원가입이 완료됐습니다.');
    setTimeout(() => { router.push('/login?message=signup-success'); }, 2000);
  }

  return (
    <main className="min-h-screen bg-[#F5F7FA] flex items-center justify-center px-4">
      <div className="w-full max-w-[420px]">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-[#003087]/10 mb-4">
            <span className="text-3xl">🏛️</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-900">
            {inviteToken ? '초대 수락 — 회원가입' : '회원가입'}
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            {inviteToken ? 'AI 업무도우미에 오신 것을 환영합니다.' : 'WORKON 계정을 생성하세요.'}
          </p>
        </div>

        {inviteToken && inviteInfo && (
          <div className="mb-4 px-4 py-3 bg-blue-50 border border-blue-200 rounded-xl text-sm text-[#003087] space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-base">🏢</span>
              <span>
                <strong>{inviteInfo.orgName}</strong> 기관의&nbsp;
                <strong>{inviteInfo.role === 'ADMIN' ? '관리자' : '직원'}</strong>으로 초대됐습니다.
              </span>
            </div>
            <p className="text-xs text-slate-500 pl-6">
              아래 이메일로 가입하면 해당 기관에 자동으로 소속됩니다.
            </p>
          </div>
        )}

        <div className="bg-white rounded-2xl shadow-md p-8 space-y-4">
          {error   && <div className="px-4 py-3 bg-red-50   border border-red-200   rounded-xl text-sm text-red-700">{error}</div>}
          {message && <div className="px-4 py-3 bg-green-50 border border-green-200 rounded-xl text-sm text-green-700">{message}</div>}

          <form onSubmit={handleSubmit} className="space-y-4">
            {[
              { label: '이름',        val: fullName,        set: setFullName,        type: 'text',     ph: '홍길동' },
              { label: '이메일',      val: email,           set: setEmail,           type: 'email',    ph: 'example@gov.kr' },
              { label: '비밀번호',    val: password,        set: setPassword,        type: 'password', ph: '8자 이상' },
              { label: '비밀번호 확인',val: confirmPassword, set: setConfirmPassword, type: 'password', ph: '비밀번호 재입력' },
            ].map(({ label, val, set, type, ph }) => (
              <div key={label}>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">{label}</label>
                <input type={type} value={val} onChange={e => set(e.target.value)} required
                  minLength={type === 'password' ? 8 : undefined} placeholder={ph}
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#003087]/30 focus:border-[#003087]" />
              </div>
            ))}
            <button type="submit" disabled={loading}
              className="w-full py-3 bg-[#003087] hover:bg-[#002070] disabled:bg-slate-300 text-white font-semibold rounded-xl text-sm transition-colors">
              {loading ? '가입 중...' : '회원가입'}
            </button>
          </form>

          <div className="pt-4 border-t border-slate-100 text-center">
            <p className="text-xs text-slate-500">
              이미 계정이 있으신가요?{' '}
              <Link href="/login" className="font-semibold text-[#003087] hover:underline">로그인</Link>
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-[#F5F7FA] flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-[#003087]/30 border-t-[#003087] rounded-full animate-spin" />
      </div>
    }>
      <SignupForm />
    </Suspense>
  );
}
