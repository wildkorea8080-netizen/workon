'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { signOut, useSession } from 'next-auth/react';
import { PASSWORD_RULE_TEXT, passwordPolicyError } from '@/lib/password-policy';
import MySignIns from '@/components/my/MySignIns';

/** 내 비밀번호 바꾸기(2026-11-16) — 검사는 서버가 다시 한다(`/api/my/password`) */
export default function MyPasswordPage() {
  const { data: session } = useSession();
  // 임시 비밀번호로 들어와 미들웨어가 보낸 경우(0093) — 바꾸기 전에는 다른 화면이 열리지 않는다
  // (useSearchParams는 Suspense 경계가 필요해 주소에서 직접 읽는다)
  const [required, setRequired] = useState(false);
  useEffect(() => { setRequired(new URLSearchParams(window.location.search).get('required') === '1'); }, []);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (!current) { setError('지금 비밀번호를 입력해 주세요.'); return; }
    const policy = passwordPolicyError(next, { email: session?.user?.email });
    if (policy) { setError(policy); return; }
    if (next !== confirm) { setError('새 비밀번호가 서로 다릅니다.'); return; }
    if (next === current) { setError('지금 비밀번호와 다른 비밀번호를 입력해 주세요.'); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/my/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current, next }),
      });
      const data = await res.json().catch(() => null);
      if (!data?.ok) { setError(data?.error?.message ?? '비밀번호를 바꾸지 못했습니다.'); return; }
      setDone(true);
      setCurrent(''); setNext(''); setConfirm('');
      // 바꾼 때가 적혔으면 모든 기기의 로그인이 끝난다 — 여기서도 로그아웃하고 새 비밀번호로 다시 들어오게 한다
      if (data.data?.signedOut) setTimeout(() => { void signOut({ callbackUrl: '/login?error=password_changed' }); }, 1500);
    } catch {
      setError('비밀번호를 바꾸지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
    } finally {
      setSaving(false);
    }
  };

  const input = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-slate-400 focus:outline-none';

  return (
    <div className="min-h-screen bg-[#F5F7FA] pt-14">
      <div className="mx-auto max-w-md px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900">비밀번호 바꾸기</h1>
            <p className="mt-0.5 text-sm text-slate-500">관리자가 준 임시 비밀번호는 처음 로그인한 뒤 바꿔 주세요.</p>
          </div>
          <Link href="/" className="text-sm font-medium text-slate-600 hover:text-slate-900">← 홈</Link>
        </div>

        {required && (
          <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            관리자가 준 임시 비밀번호로 로그인했습니다. 새 비밀번호로 바꿔야 다른 화면을 쓸 수 있습니다.
          </p>
        )}

        <form onSubmit={submit} className="space-y-4 rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-slate-600">지금 비밀번호</span>
            <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className={input} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-slate-600">새 비밀번호</span>
            <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} className={input} />
            <span className="mt-1 block text-xs text-slate-400">{PASSWORD_RULE_TEXT}</span>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-slate-600">새 비밀번호 확인</span>
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={input} />
          </label>

          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
          {done && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">비밀번호를 바꿨습니다. 다른 기기를 포함해 모든 로그인이 끝납니다 — 새 비밀번호로 다시 로그인해 주세요.</p>}

          <button
            type="submit"
            disabled={saving}
            className="w-full rounded-xl bg-[#1C2B4A] py-2.5 text-sm font-semibold text-white hover:bg-[#243660] disabled:opacity-50"
          >
            {saving ? '바꾸는 중…' : '비밀번호 바꾸기'}
          </button>
        </form>

        {/* 임시 비밀번호로 묶인 동안은 다른 API가 막혀 있어 보이지 않는다 */}
        {!required && <MySignIns />}
      </div>
    </div>
  );
}
