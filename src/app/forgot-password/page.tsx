'use client';

import { useState } from 'react';
import Link from 'next/link';
import { RESET_LINK_MINUTES } from '@/lib/password-reset-spec';

/** 직원 비밀번호 찾기 — 재설정 링크 요청(2026-11-16). 응답은 계정이 있든 없든 같다 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!email.trim()) { setError('이메일을 입력해 주세요.'); return; }
    setSending(true);
    try {
      const res = await fetch('/api/password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json().catch(() => null);
      if (!data?.ok) { setError(data?.error?.message ?? '요청을 보내지 못했습니다.'); return; }
      setNotice(data.data?.message ?? '요청을 받았습니다.');
    } catch {
      setError('요청을 보내지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-[#001a5c] via-[#003087] to-[#0066CC] flex items-center justify-center px-4">
      <div className="w-full max-w-[420px] rounded-2xl bg-white p-8 shadow-2xl">
        <h1 className="text-lg font-bold text-slate-900">비밀번호 찾기</h1>
        <p className="mt-1 text-sm text-slate-500">
          로그인에 쓰는 이메일을 넣으면 새 비밀번호를 정하는 링크를 보내 드립니다. 링크는 {RESET_LINK_MINUTES}분 동안 한 번만 쓸 수 있습니다.
        </p>
        {notice && <p className="mt-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{notice}</p>}
        {error && <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
        <form onSubmit={submit} className="mt-5 space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-slate-600">이메일</span>
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="example@gov.kr"
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 focus:border-[#003087] focus:outline-none focus:ring-2 focus:ring-[#003087]/30"
            />
          </label>
          <button
            type="submit"
            disabled={sending}
            className="w-full rounded-xl bg-[#003087] py-3 text-sm font-semibold text-white hover:bg-[#002070] disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {sending ? '보내는 중…' : '재설정 링크 받기'}
          </button>
        </form>
        <p className="mt-5 border-t border-slate-100 pt-5 text-xs text-slate-500">
          사용 중지된 계정은 메일을 받을 수 없습니다 — 기관 관리자에게 문의해 주세요.{' '}
          <Link href="/login" className="font-semibold text-[#003087]">로그인으로 돌아가기</Link>
        </p>
      </div>
    </main>
  );
}
