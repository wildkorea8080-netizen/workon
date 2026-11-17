'use client';

import { useState } from 'react';
import { PASSWORD_RULE_TEXT, passwordPolicyError } from '@/lib/password-policy';

/**
 * 슈퍼관리자 비밀번호 바꾸기(2026-11-17). 다른 슈퍼관리자가 추가하며 준 임시 비밀번호(0093 `password_must_change`)인 동안
 * 미들웨어가 이 화면과 바꾸기 API만 열어 둔다. 바꾸면 모든 슈퍼관리자 로그인이 끝나 새 비밀번호로 다시 로그인한다.
 */
export default function SuperPasswordPage() {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.next !== form.confirm) { setError('새 비밀번호가 일치하지 않습니다.'); return; }
    const policy = passwordPolicyError(form.next);
    if (policy) { setError(policy); return; }
    setSaving(true); setError(null);
    try {
      const res = await fetch('/api/super/accounts/me/password', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: form.current, newPassword: form.next }),
      });
      const data = await res.json().catch(() => null);
      if (data?.ok) { window.location.href = '/super/login'; return; }
      setError(typeof data?.error === 'string' ? data.error : data?.error?.message ?? '비밀번호를 바꾸지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
    } catch {
      setError('비밀번호를 바꾸지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
    }
    setSaving(false);
  };

  const field = 'w-full px-4 py-2.5 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]';

  return (
    <div className="max-w-md space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">비밀번호 바꾸기</h1>
        <p className="text-slate-400 text-sm mt-1">받은 임시 비밀번호를 쓰는 동안에는 다른 화면을 쓸 수 없습니다. 본인만 아는 비밀번호로 바꿔 주세요.</p>
      </div>
      <form onSubmit={submit} className="bg-[#1E293B] border border-slate-700/50 rounded-2xl p-6 space-y-4">
        <label className="block space-y-1.5">
          <span className="text-xs text-slate-400">지금 비밀번호(받은 임시 비밀번호)</span>
          <input type="password" autoComplete="current-password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} className={field} required />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs text-slate-400">새 비밀번호</span>
          <input type="password" autoComplete="new-password" value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} className={field} required />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs text-slate-400">새 비밀번호 확인</span>
          <input type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} className={field} required />
        </label>
        <p className="text-xs text-slate-500">{PASSWORD_RULE_TEXT}. 공백·같은 글자 네 번 넘게·이메일 아이디는 쓸 수 없습니다.</p>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button type="submit" disabled={saving} className="w-full py-2.5 bg-[#7C3AED] hover:bg-[#6D28D9] disabled:opacity-50 text-white text-sm font-semibold rounded-xl">
          {saving ? '바꾸는 중…' : '바꾸고 다시 로그인'}
        </button>
      </form>
    </div>
  );
}
