'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { requestJson, serverErrorText } from '@/lib/ok-json';

// 초대 정보를 확인하는 요청이 끊겼을 때(2026-11-22) — 예전엔 실패를 삼켜 기관 안내도 이메일 고정도 없이 빈 가입 화면이었다
const INVITE_INFO_UNREAD = '초대 정보를 지금 확인하지 못했습니다. 화면을 새로 고쳐 주세요 — 가입할 때 서버가 초대를 다시 확인합니다.';

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
    fetch(`/api/signup/invite-info?token=${encodeURIComponent(inviteToken)}`)
      .then(r => r.json().catch(() => null))
      .then(d => {
        if (d?.ok) {
          setInviteInfo(d.data);
          // 초대 이메일로 채우고 고치지 못하게 한다(초대받은 이메일로만 가입 — 서버가 맞춰 봄)
          if (d.data?.email) setEmail(d.data.email);
        } else if (typeof d?.error === 'string') {
          // 만료·사용됨·멈춘 기관·확인 실패를 가입 버튼을 누르기 전에(2026-11-19)
          setError(d.error);
        } else {
          setError(INVITE_INFO_UNREAD);
        }
      })
      .catch(() => setError(INVITE_INFO_UNREAD));
  }, [inviteToken]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(''); setMessage(''); setLoading(true);

    // 던지지 않는다 — 예전엔 응답을 못 읽거나 연결이 끊기면 '처리 중'이 멈추고 가입됐는지 알 수 없었다(2026-11-22)
    const r = await requestJson('/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, fullName, password, confirmPassword, inviteToken }),
    });
    setLoading(false);

    if (!r.ok) { setError(serverErrorText(r.body, '회원가입을 마치지 못했습니다. 잠시 뒤 로그인해 보고, 안 되면 다시 가입해 주세요.')); return; }
    setMessage(r.body.data?.message || '회원가입이 완료됐습니다.');
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
                {/* 초대 가입은 초대받은 이메일로만 된다(서버가 맞춰 봄) — 초대에서 받은 이메일은 고치지 못하게 */}
                <input type={type} value={val} onChange={e => set(e.target.value)} required
                  readOnly={type === 'email' && Boolean(inviteToken && inviteInfo?.email)}
                  minLength={type === 'password' ? 8 : undefined} placeholder={ph}
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#003087]/30 focus:border-[#003087] read-only:text-slate-500" />
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
