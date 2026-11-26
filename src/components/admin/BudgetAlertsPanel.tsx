'use client';

import { useEffect, useState } from 'react';
import { requestJson } from '@/lib/ok-json';
import type { BudgetAlertView } from '@/lib/budget-alert-history-spec';

type Loaded = { alerts: BudgetAlertView[]; mailConfigured: boolean };

const kst = (iso: string) => new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' });
export const BUDGET_ALERTS_UNREAD = '지금 예산 알림 이력을 불러오지 못했습니다. 화면을 새로 고쳐 주세요.';

/**
 * 예산 알림 이력(2026-11-26) — 예산 알림 메일(기관 예산·월 토큰 한도·부서 월 한도)을 언제·몇 %에서 보냈는지, 받는 사람이 없거나 보내지 못했는지.
 * 기관 알림은 관리자 누구나, 부서 알림은 관리 범위 부서만, 개인 월 한도 알림은 직원 본인에게만 가므로 여기에 없다
 */
export default function BudgetAlertsPanel() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [unread, setUnread] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    void (async () => {
      const r = await requestJson('/api/admin/budget-alerts');
      if (!r.ok) {
        if (r.status === 401 || r.status === 403) setHidden(true); else setUnread(true);
        return;
      }
      setLoaded((r.body as { data: Loaded }).data);
    })();
  }, []);

  if (hidden) return null;
  return (
    <section className="mt-6 rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
      <h2 className="text-base font-semibold text-slate-900">예산 알림 이력</h2>
      <p className="mt-1 text-xs leading-5 text-slate-500">
        기관 예산(연간 정액)·월 토큰 한도·부서 월 한도의 사용률이 기준(80·90·100% 등)을 넘을 때 보낸 메일입니다. 같은 기준은 기간마다 한 번만 보냅니다.
        받는 사람: 기관 알림은 기관 담당자 메일과 최상위 부서 관리자, 부서 알림은 그 부서와 상위 부서의 관리자. 받는 사람 주소는 남기지 않아 수만 보입니다.
        개인 월 한도 알림은 직원 본인에게만 가므로 여기에 없습니다.
      </p>
      {unread && <p role="alert" className="mt-3 text-sm text-amber-700">{BUDGET_ALERTS_UNREAD}</p>}
      {!unread && !loaded && <p role="status" className="mt-3 text-sm text-slate-500">불러오는 중…</p>}
      {loaded && !loaded.mailConfigured && (
        <p role="note" className="mt-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">이 서비스에 메일 보내기가 설정되어 있지 않아 예산 알림 메일을 보내지 않습니다 — 기준을 넘어도 이 화면의 예산 현황으로만 알 수 있습니다.</p>
      )}
      {loaded && (loaded.alerts.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">아직 보낸 예산 알림이 없습니다.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="text-slate-500">
              <tr><th className="py-1 pr-3 font-medium">때</th><th className="py-1 pr-3 font-medium">대상</th><th className="py-1 pr-3 font-medium">종류·기간</th><th className="py-1 pr-3 font-medium">기준 (그때 사용률)</th><th className="py-1 pr-3 font-medium">결과</th><th className="py-1 font-medium">받은 사람</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {loaded.alerts.map((a) => (
                <tr key={a.id}>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{kst(a.createdAt)}</td>
                  <td className="py-1.5 pr-3">{a.target === 'organization' ? '기관 전체' : a.departmentName ?? '(지금 없는 부서)'}</td>
                  <td className="py-1.5 pr-3">{a.kindLabel} · {a.periodLabel}</td>
                  <td className="py-1.5 pr-3">{a.threshold}% ({a.percent}%)</td>
                  <td className={`py-1.5 pr-3 ${a.status === 'sent' ? 'text-emerald-700' : a.status === 'sending' ? 'text-slate-600' : 'text-red-700'}`}>{a.statusLabel}</td>
                  <td className="py-1.5">{a.status === 'sent' ? `${a.recipients}명` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}
