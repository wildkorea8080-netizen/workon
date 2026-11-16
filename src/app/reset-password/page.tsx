'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PASSWORD_RULE_TEXT, passwordPolicyError } from '@/lib/password-policy';
import { tokenFromHash } from '@/lib/password-reset-spec';

/**
 * 메일 링크로 새 비밀번호 정하기(2026-11-16). 열쇠는 주소의 `#token=`(조각)에 있어 서버 기록에 남지 않는다 —
 * 읽자마자 주소에서 지운다(화면을 공유하거나 방문 기록에 남지 않게). 검사는 서버가 다시 한다.
 */
export default function ResetPasswordPage() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    // 효과가 두 번 돌아도(개발 모드) 처음 읽은 열쇠를 지킨다 — 첫 번째가 주소를 지우므로 두 번째는 빈 주소를 읽는다
    const read = tokenFromHash(window.location.hash);
    setToken((prev) => prev ?? read);
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!token) return;
    const policy = passwordPolicyError(next);
    if (policy) { setError(policy); return; }
    if (next !== confirm) { setError('새 비밀번호가 서로 다릅니다.'); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/password-reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, next }),
      });
      const data = await res.json().catch(() => null);
      if (!data?.ok) { setError(data?.error?.message ?? '비밀번호를 바꾸지 못했습니다.'); return; }
      setDone(true);
      setNext(''); setConfirm('');
    } catch {
      setError('비밀번호를 바꾸지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
    } finally {
      setSaving(false);
    }
  };

  const input = 'w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 focus:border-[#003087] focus:outline-none focus:ring-2 focus:ring-[#003087]/30';

  return (
    <main className="min-h-screen bg-gradient-to-br from-[#001a5c] via-[#003087] to-[#0066CC] flex items-center justify-center px-4">
      <div className="w-full max-w-[420px] rounded-2xl bg-white p-8 shadow-2xl">
        <h1 className="text-lg font-bold text-slate-900">새 비밀번호 정하기</h1>
        {token === undefined ? null : done ? (
          <>
            <p className="mt-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
              비밀번호를 바꿨습니다. 열려 있던 로그인은 모두 끝났습니다 — 새 비밀번호로 로그인해 주세요.
            </p>
            <Link href="/login" className="mt-5 block w-full rounded-xl bg-[#003087] py-3 text-center text-sm font-semibold text-white hover:bg-[#002070]">로그인하기</Link>
          </>
        ) : !token ? (
          <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            링크가 올바르지 않습니다. 메일의 버튼을 다시 누르거나{' '}
            <Link href="/forgot-password" className="font-semibold underline">비밀번호 찾기</Link>를 다시 요청해 주세요.
          </p>
        ) : (
          <form onSubmit={submit} className="mt-5 space-y-4">
            {error && <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-slate-600">새 비밀번호</span>
              <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} className={input} />
              <span className="mt-1 block text-xs text-slate-400">{PASSWORD_RULE_TEXT}</span>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-slate-600">새 비밀번호 확인</span>
              <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={input} />
            </label>
            <button
              type="submit"
              disabled={saving}
              className="w-full rounded-xl bg-[#003087] py-3 text-sm font-semibold text-white hover:bg-[#002070] disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {saving ? '바꾸는 중…' : '비밀번호 바꾸기'}
            </button>
          </form>
        )}
        <p className="mt-5 border-t border-slate-100 pt-5 text-xs text-slate-500">
          <Link href="/login" className="font-semibold text-[#003087]">로그인으로 돌아가기</Link>
        </p>
      </div>
    </main>
  );
}
