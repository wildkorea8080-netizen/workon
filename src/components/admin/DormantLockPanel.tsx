'use client';

import { useEffect, useState } from 'react';
import { actionErrorText } from '@/lib/ok-json';

const CHOICES = [30, 60, 90, 180, 365];

/** 장기 미접속 계정 잠금(2026-11-16, 0095) — 기관 전체 관리자가 켜고 끈다. 기본은 꺼짐 */
export default function DormantLockPanel() {
  const [days, setDays] = useState<number | null>(null);
  const [since, setSince] = useState<string | null>(null);
  const [choice, setChoice] = useState<string>('off');
  const [loaded, setLoaded] = useState(false);
  // 지금 설정을 못 읽은 것(2026-11-20) — 예전엔 칸이 통째로 사라져 이 설정이 있는지조차 알 수 없었다.
  // 못 읽은 채로는 고르게 두지 않는다(지금 값을 모르고 저장하면 켜 둔 잠금을 끌 수 있다)
  const [unread, setUnread] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    fetch('/api/admin/organization')
      .then(async (r) => ({ status: r.status, d: await r.json().catch(() => null) }))
      .then(({ status, d }) => {
        // 권한이 없어 거절된 것(401·403)은 예전처럼 칸을 보이지 않는다 — 못 읽은 것만 알린다
        if (!d?.ok) { if (status !== 401 && status !== 403) setUnread(true); return; }
        setDays(d.data.dormant_lock_days ?? null);
        setSince(d.data.dormant_lock_since ?? null);
        setChoice(d.data.dormant_lock_days ? String(d.data.dormant_lock_days) : 'off');
        setLoaded(true);
      })
      .catch(() => setUnread(true));
  }, []);

  if (unread) {
    return (
      <section className="mt-6 rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">장기 미접속 계정 잠금</h2>
        <p role="alert" className="mt-2 text-sm text-amber-700">지금 설정을 불러오지 못했습니다. 화면을 새로 고쳐 주세요.</p>
      </section>
    );
  }
  if (!loaded) return null;

  const save = async () => {
    const next = choice === 'off' ? null : Number(choice);
    if (next !== null && days === null && !confirm(`${next}일 넘게 로그인하지 않은 직원 계정을 자동으로 사용 중지합니다.\n오늘부터 세므로 지금 바로 잠기는 계정은 없습니다. 켤까요?`)) return;
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch('/api/admin/organization/dormant-lock', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: next }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error?.message);
      setDays(d.data.dormant_lock_days ?? null);
      setSince(d.data.dormant_lock_since ?? null);
      setMsg({ ok: true, text: '저장했습니다.' });
    } catch (e) {
      setMsg({ ok: false, text: actionErrorText(e, '저장하지 못했습니다.') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mt-6 rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
      <h2 className="text-base font-semibold text-slate-900">장기 미접속 계정 잠금</h2>
      <p className="mt-1 text-sm text-slate-500">
        정한 기간 넘게 로그인하지 않은 직원은 다음 로그인 때 계정이 &lsquo;사용 중지&rsquo;되고, 관리자가 사용자 관리에서 &lsquo;다시 사용&rsquo;으로 풉니다.
        기간은 켠 날부터 셉니다. 기관 전체 관리자만 바꿀 수 있습니다.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <select value={choice} onChange={(e) => setChoice(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
          <option value="off">끄기</option>
          {CHOICES.map((d) => <option key={d} value={String(d)}>{d}일</option>)}
        </select>
        <button
          type="button"
          onClick={save}
          disabled={saving || choice === (days ? String(days) : 'off')}
          className="rounded-lg bg-[#003087] px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
        >
          {saving ? '저장 중…' : '저장'}
        </button>
        <span className="text-xs text-slate-400">
          {days ? `지금: ${days}일 · ${since ? new Date(since).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' }) : ''}부터 셈` : '지금: 꺼짐'}
        </span>
      </div>
      {msg && <p className={`mt-3 text-sm ${msg.ok ? 'text-emerald-600' : 'text-red-600'}`}>{msg.text}</p>}
    </section>
  );
}
