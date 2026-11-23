'use client';

import { useEffect, useState } from 'react';
import { SIGN_IN_ACTION_LABEL, recentFailures, type MySignIn } from '@/lib/my-sign-ins-spec';
import { requestJson } from '@/lib/ok-json';

/** 내 최근 로그인 기록(2026-11-16) — 내가 하지 않은 로그인·실패가 보이면 비밀번호를 바꾸게 */
export default function MySignIns() {
  const [list, setList] = useState<MySignIn[] | null>(null);
  const [failed, setFailed] = useState(false);
  // 대리 접근 중(403)에만 숨긴다 — 예전엔 어떤 실패든 칸이 통째로 사라졌다(2026-11-22)
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let alive = true;
    void requestJson('/api/my/sign-ins').then((r) => {
      if (!alive) return;
      if (r.ok && Array.isArray(r.body.data)) setList(r.body.data);
      else if (r.status === 403) setHidden(true);
      else setFailed(true);
    });
    return () => { alive = false; };
  }, []);

  if (hidden) return null;

  const fails = list ? recentFailures(list) : 0;
  const fmt = (iso: string) => new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <section className="mt-6 rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-900">최근 로그인 기록</h2>
      <p className="mt-0.5 text-xs text-slate-500">최근 90일, 30건까지. 내가 하지 않은 로그인이 보이면 바로 비밀번호를 바꾸고 관리자에게 알려 주세요.</p>
      {fails > 0 && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">최근 30일에 비밀번호가 틀린 로그인 시도가 {fails}번 있었습니다.</p>
      )}
      {failed ? (
        <p role="alert" className="mt-3 text-xs text-red-600">로그인 기록을 지금 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요.</p>
      ) : list === null ? (
        <p className="mt-3 text-xs text-slate-400">불러오는 중…</p>
      ) : list.length === 0 ? (
        <p className="mt-3 text-xs text-slate-400">아직 기록이 없습니다(2026-11-16부터 남깁니다).</p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-50 text-xs">
          {list.map((s, i) => (
            <li key={`${s.at}-${i}`} className="flex items-center justify-between gap-3 py-2">
              <span className="text-slate-500">{fmt(s.at)}</span>
              <span className={s.action === 'login' ? 'text-slate-700' : 'font-medium text-red-600'}>{SIGN_IN_ACTION_LABEL[s.action] ?? s.action}</span>
              <span className="truncate text-right text-slate-400">{s.device}{s.ip ? ` · ${s.ip}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
