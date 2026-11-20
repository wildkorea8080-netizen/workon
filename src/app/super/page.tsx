'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from 'recharts';
import { CRITICAL_LOGS_LINK } from '@/lib/super-log-links';

const fmt = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` :
  n >= 1_000     ? `${(n / 1_000).toFixed(0)}K`     : String(n ?? 0);

const fmtDate = (s: string) => new Date(s).toLocaleDateString('ko-KR');

/** 서버가 못 읽은 숫자(null)는 0으로 보이지 않게 '읽지 못함'(2026-11-20) */
const UNREAD = '읽지 못함';
const shown = (v: number | null | undefined, f: (n: number) => string) => (v == null ? UNREAD : f(v));

const PLAN_COLORS: Record<string, string> = {
  trial:      '#6B7280',
  basic:      '#3B82F6',
  pro:        '#7C3AED',
  enterprise: '#F59E0B',
};

// ═══════════════════════════════════════════════════════════
export default function SuperDashboard() {
  const [data, setData]     = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 못 불러오면 알린다(2026-11-20 — 예전엔 모든 카드가 0으로, 연결이 끊기면 도는 표시가 멈추지 않았다)
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/super/dashboard');
      const d   = await res.json().catch(() => null);
      if (d?.ok) { setData(d.data); setLoadError(null); }
      else setLoadError(typeof d?.error === 'string' ? d.error : '대시보드를 지금 불러오지 못했습니다.');
    } catch {
      setLoadError('대시보드를 지금 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-2 border-[#7C3AED]/30 border-t-[#7C3AED] rounded-full animate-spin" />
    </div>
  );

  const o = data?.organizations ?? {};
  const u = data?.users ?? {};
  const us = data?.usage ?? {};
  const r = data?.revenue ?? {};
  const al = data?.alerts ?? {};

  const CARDS_ROW1 = [
    { icon: '🏢', label: '전체 기관',   value: shown(o.total, (n) => `${n}개`),  sub: `활성 ${shown(o.active, (n) => `${n}개`)}` },
    { icon: '✅', label: '활성 기관',   value: shown(o.active, (n) => `${n}개`), sub: `정지·종료 ${shown(o.suspended, (n) => `${n}개`)}` },
    { icon: '👥', label: '전체 사용자', value: shown(u.total, (n) => `${n}명`),  sub: `오늘 활성 ${shown(u.activeToday, (n) => `${n}명`)}` },
    { icon: '🆕', label: '이번달 신규', value: shown(u.newThisMonth, (n) => `${n}명`), sub: '신규 가입' },
  ];
  const CARDS_ROW2 = [
    { icon: '💬', label: '오늘 대화',   value: shown(us.todayConversations, (n) => `${n}건`) },
    { icon: '🔤', label: '이번달 토큰', value: shown(us.monthTokens, fmt) },
    { icon: '💰', label: '이번달 매출', value: shown(r.thisMonth, (n) => `${n.toLocaleString()}원`) },
    {
      icon: '📈', label: '전월 대비',
      value: r.growthPercent !== null && r.growthPercent !== undefined
        ? `${r.growthPercent >= 0 ? '▲' : '▼'}${Math.abs(r.growthPercent)}%`
        : '—',
      highlight: r.growthPercent > 0,
    },
  ];

  return (
    <div className="space-y-6">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">대시보드</h1>
          <p className="text-slate-400 text-sm mt-0.5">WORKON 전체 운영 현황</p>
        </div>
        <button onClick={load} className="flex items-center gap-1.5 px-3 py-2 bg-[#1E293B] border border-slate-700 hover:border-[#7C3AED] text-slate-400 text-xs rounded-xl transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          새로고침
        </button>
      </div>

      {loadError && (
        <div className="p-4 bg-red-950/30 border border-red-700/40 rounded-2xl text-sm text-red-300">
          {loadError} 아래 숫자는 {data ? '지난번에 불러온 값입니다' : '보이지 않습니다'} — 새로고침해 주세요.
        </div>
      )}

      {/* 심각한 운영 기록(2026-11-17) — 사용 기록·감사 기록·계약 맞추기 실패 등 critical, 최근 24시간 */}
      {al.critical24h === null && (
        <div className="p-4 bg-amber-950/30 border border-amber-700/40 rounded-2xl text-sm text-amber-300">심각한 운영 기록 수를 읽지 못했습니다 — 로그 화면에서 직접 확인해 주세요.</div>
      )}
      {al.critical24h?.count > 0 && (
        <div className="flex items-start gap-4 p-4 bg-red-950/30 border border-red-700/40 rounded-2xl">
          <span className="text-xl">🛑</span>
          <div className="flex-1 text-sm text-red-300">
            <p className="font-semibold">최근 24시간 심각한(CRITICAL) 운영 기록 {al.critical24h.count}건</p>
            <ul className="mt-1 space-y-0.5 text-xs text-red-200/80">
              {(al.critical24h.top ?? []).map((t: { message: string; count: number }) => (
                <li key={t.message} className="truncate">· {t.message} — {t.count}건</li>
              ))}
            </ul>
          </div>
          <Link href={CRITICAL_LOGS_LINK} className="flex-shrink-0 px-3 py-1.5 bg-red-700/40 hover:bg-red-700/60 text-red-300 text-xs font-semibold rounded-lg transition-colors">기록 보기</Link>
        </div>
      )}

      {/* 지금 로그인이 막힌 IP(2026-11-17) — 기관 전체가 바깥 IP 하나를 쓰면 기관 전체가 못 들어온다. 계정 관리에서 IP를 넣어 푼다 */}
      {al.lockedIps?.count > 0 && (
        <div className="flex items-start gap-4 p-4 bg-amber-950/30 border border-amber-700/40 rounded-2xl">
          <span className="text-xl">🔒</span>
          <div className="flex-1 text-sm text-amber-300">
            <p className="font-semibold">지금 로그인이 막힌 인터넷 주소(IP) {al.lockedIps.count}곳</p>
            <p className="mt-1 text-xs text-amber-200/80">
              한 주소에서 30분에 30번 틀리면 그 주소의 로그인을 30분 막습니다. 기관 전체가 한 주소를 쓰면 기관 전체가 못 들어옵니다.
              {(al.lockedIps.masked ?? []).length > 0 && <> 최근 잠긴 주소: {(al.lockedIps.masked as string[]).join(', ')}</>}
            </p>
          </div>
          <Link href="/super/accounts" className="flex-shrink-0 px-3 py-1.5 bg-amber-700/40 hover:bg-amber-700/60 text-amber-200 text-xs font-semibold rounded-lg transition-colors">IP 확인·풀기</Link>
        </div>
      )}

      {/* 사용자 수 상한(2026-11-17) — 닿은 기관은 직원 등록·초대 가입이 막힌다. 계약 인원을 늘리거나 기관이 쓰지 않는 계정을 끄게 한다 */}
      {(al.seats?.orgs ?? []).length > 0 && (
        <div className={`flex items-start gap-4 p-4 rounded-2xl border ${al.seats.full > 0 ? 'bg-red-950/30 border-red-700/40' : 'bg-amber-950/30 border-amber-700/40'}`}>
          <span className="text-xl">👥</span>
          <div className={`flex-1 text-sm ${al.seats.full > 0 ? 'text-red-300' : 'text-amber-300'}`}>
            <p className="font-semibold">
              {al.seats.full > 0 && <>사용자 수 상한에 닿은 기관 {al.seats.full}곳 — 새 계정·초대 가입이 막힙니다</>}
              {al.seats.full > 0 && al.seats.near > 0 && <span className="mx-2 opacity-60">|</span>}
              {al.seats.near > 0 && <>상한에 가까운 기관(90% 이상) {al.seats.near}곳</>}
            </p>
            <ul className="mt-1.5 space-y-0.5 text-xs">
              {(al.seats.orgs as Array<{ id: string; name: string; used: number; limit: number; full: boolean }>).slice(0, 5).map((o) => (
                <li key={o.id}>
                  <Link href={`/super/organizations/${o.id}`} className="underline hover:opacity-80">{o.name}</Link>
                  {' '}{o.used} / {o.limit}명{o.full ? ' (닿음)' : ''}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* 토큰 한도 판정을 못 읽음(2026-11-19) — 0으로 보이면 '한도 넘은 기관 없음'으로 읽힌다 */}
      {data && al.tokenExceeded === null && (
        <div className="p-3 bg-amber-950/30 border border-amber-700/40 rounded-2xl text-xs text-amber-300">
          기관 토큰 한도 사용률을 지금 확인하지 못했습니다 — 한도를 넘은 기관이 있어도 여기에 보이지 않습니다. 잠시 뒤 새로 고침해 주세요.
        </div>
      )}

      {/* 만료 임박 계약 수를 못 읽음(2026-11-20) — 0으로 보이면 띠가 사라져 '만료 임박 없음'으로 읽힌다 */}
      {data && al.expiringContracts === null && (
        <div className="p-3 bg-amber-950/30 border border-amber-700/40 rounded-2xl text-xs text-amber-300">
          만료가 30일 안으로 다가온 계약 수를 지금 확인하지 못했습니다 — <Link href="/super/contracts?tab=expiring" className="underline">계약 화면</Link>에서 직접 확인해 주세요.
        </div>
      )}

      {/* 알림 배너 */}
      {(al.tokenExceeded > 0 || al.expiringContracts > 0 || al.overdueContracts > 0) && (
        <div className="flex items-center gap-4 p-4 bg-red-950/30 border border-red-700/40 rounded-2xl">
          <span className="text-xl">🚨</span>
          <div className="flex-1 text-sm text-red-300">
            {al.tokenExceeded > 0 && <span className="font-semibold">토큰 한도 초과 기관 {al.tokenExceeded}개</span>}
            {al.tokenExceeded > 0 && al.expiringContracts > 0 && <span className="mx-2 text-red-600">|</span>}
            {al.expiringContracts > 0 && <span className="font-semibold">계약 만료 임박 {al.expiringContracts}개</span>}
            {al.overdueContracts > 0 && <span className="ml-2 font-semibold">기한 지난 계약 {al.overdueContracts}개(아직 활성)</span>}
            {al.tokenWarnings > 0 && <span className="ml-2 text-amber-400">(경고: {al.tokenWarnings}개)</span>}
          </div>
          <div className="flex gap-2 flex-shrink-0">
            {al.tokenExceeded > 0 && (
              <Link href="/super/usage" className="px-3 py-1.5 bg-red-700/40 hover:bg-red-700/60 text-red-300 text-xs font-semibold rounded-lg transition-colors">사용량 확인</Link>
            )}
            {(al.expiringContracts > 0 || al.overdueContracts > 0) && (
              <Link href="/super/contracts?tab=expiring" className="px-3 py-1.5 bg-amber-700/30 hover:bg-amber-700/50 text-amber-400 text-xs font-semibold rounded-lg transition-colors">계약 확인</Link>
            )}
          </div>
        </div>
      )}

      {/* 요약 카드 1줄 */}
      <div className="grid grid-cols-4 gap-4">
        {CARDS_ROW1.map(c => (
          <div key={c.label} className="bg-[#1E293B] border border-slate-700/50 rounded-2xl p-5">
            <span className="text-2xl">{c.icon}</span>
            <p className="text-2xl font-bold text-white mt-3">{c.value}</p>
            <p className="text-xs text-slate-500 mt-0.5">{c.label}</p>
            {c.sub && <p className="text-xs text-slate-600 mt-0.5">{c.sub}</p>}
          </div>
        ))}
      </div>

      {/* 요약 카드 2줄 */}
      <div className="grid grid-cols-4 gap-4">
        {CARDS_ROW2.map(c => (
          <div key={c.label} className="bg-[#1E293B] border border-slate-700/50 rounded-2xl p-5">
            <span className="text-2xl">{c.icon}</span>
            <p className={`text-2xl font-bold mt-3 ${(c as any).highlight ? 'text-emerald-400' : 'text-white'}`}>{c.value}</p>
            <p className="text-xs text-slate-500 mt-0.5">{c.label}</p>
          </div>
        ))}
      </div>

      {/* 차트 2개 */}
      <div className="grid grid-cols-5 gap-6">
        {/* 일별 대화수 (60%) */}
        <div className="col-span-3 bg-[#1E293B] border border-slate-700/50 rounded-2xl p-6">
          <h3 className="text-sm font-bold text-white mb-4">최근 30일 일별 대화수</h3>
          {data && data.dailyChart === null ? (
            <div className="h-44 flex items-center justify-center text-amber-400 text-sm">지금 읽지 못했습니다</div>
          ) : (
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={data?.dailyChart ?? []} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="date" tickFormatter={d => d.slice(5)} tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} />
              <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{ background: '#1E293B', border: '1px solid #334155', borderRadius: 8, fontSize: 11 }}
                formatter={(v: any) => [`${v}건`, '대화']}
              />
              <Line type="monotone" dataKey="count" stroke="#7C3AED" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
          )}
        </div>

        {/* 플랜별 기관 분포 도넛 (40%) */}
        <div className="col-span-2 bg-[#1E293B] border border-slate-700/50 rounded-2xl p-6">
          <h3 className="text-sm font-bold text-white mb-4">플랜별 기관 분포</h3>
          {data && data.planChart === null ? (
            <div className="h-44 flex items-center justify-center text-amber-400 text-sm">지금 읽지 못했습니다</div>
          ) : (data?.planChart?.length ?? 0) === 0 ? (
            <div className="h-44 flex items-center justify-center text-slate-500 text-sm">데이터 없음</div>
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <PieChart>
                <Pie data={data.planChart} cx="50%" cy="50%" innerRadius={45} outerRadius={70}
                  dataKey="value" nameKey="name" paddingAngle={2}>
                  {data.planChart.map((entry: any, i: number) => (
                    <Cell key={i} fill={PLAN_COLORS[entry.name] ?? '#6B7280'} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ background: '#1E293B', border: '1px solid #334155', borderRadius: 8, fontSize: 11 }} />
                <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* 하단 3열 */}
      <div className="grid grid-cols-3 gap-6">
        {/* 최근 가입 기관 */}
        <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700/50">
            <h3 className="text-sm font-bold text-white">최근 가입 기관</h3>
            <Link href="/super/organizations" className="text-xs text-[#A78BFA] hover:text-violet-300">전체 보기 →</Link>
          </div>
          <ul className="divide-y divide-slate-700/30">
            {data && data.recentOrgs === null ? (
              <li className="px-5 py-6 text-center text-amber-400 text-sm">지금 읽지 못했습니다</li>
            ) : (data?.recentOrgs ?? []).length === 0 ? (
              <li className="px-5 py-6 text-center text-slate-500 text-sm">없음</li>
            ) : (data.recentOrgs ?? []).map((o: any) => (
              <li key={o.id} className="flex items-center justify-between px-5 py-3 hover:bg-slate-700/20 transition-colors">
                <div>
                  <p className="text-sm font-medium text-white">{o.name}</p>
                  <p className="text-xs text-slate-500">{fmtDate(o.created_at)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${o.plan === 'pro' ? 'bg-violet-900/50 text-violet-300' : o.plan === 'enterprise' ? 'bg-yellow-900/50 text-yellow-300' : o.plan === 'basic' ? 'bg-blue-900/50 text-blue-300' : 'bg-slate-700 text-slate-300'}`}>
                    {(o.plan ?? 'trial').toUpperCase()}
                  </span>
                  <Link href={`/super/organizations/${o.id}`} className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-white text-xs rounded-lg transition-colors">상세</Link>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* 이번달 사용량 Top 5 */}
        <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700/50">
            <h3 className="text-sm font-bold text-white">이번달 사용량 Top 5</h3>
            <Link href="/super/usage" className="text-xs text-[#A78BFA] hover:text-violet-300">자세히 →</Link>
          </div>
          <ul className="divide-y divide-slate-700/30">
            {data && data.topUsageOrgs === null ? (
              <li className="px-5 py-6 text-center text-amber-400 text-sm">지금 읽지 못했습니다</li>
            ) : (data?.topUsageOrgs ?? []).length === 0 ? (
              <li className="px-5 py-6 text-center text-slate-500 text-sm">데이터 없음</li>
            ) : (data.topUsageOrgs ?? []).map((o: any, i: number) => (
              <li key={o.id} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-700/20 transition-colors">
                <span className="text-slate-600 text-sm font-bold w-4">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate">{o.name}</p>
                  <p className="text-xs text-slate-500">{fmt(o.tokens)} 토큰</p>
                </div>
                <div className="flex-shrink-0 w-16">
                  <div className="flex justify-between text-[10px] mb-0.5">
                    <span className={o.usagePct >= 90 ? 'text-red-400' : o.usagePct >= 70 ? 'text-amber-400' : 'text-slate-400'}>{o.usagePct}%</span>
                  </div>
                  <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
                    <div className="h-full rounded-full"
                      style={{ width: `${Math.min(o.usagePct, 100)}%`, backgroundColor: o.usagePct >= 90 ? '#EF4444' : o.usagePct >= 70 ? '#F59E0B' : '#7C3AED' }} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* 최근 시스템 로그 */}
        <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700/50">
            <h3 className="text-sm font-bold text-white">최근 시스템 로그</h3>
            <Link href="/super/logs?tab=system" className="text-xs text-[#A78BFA] hover:text-violet-300">전체 보기 →</Link>
          </div>
          <ul className="divide-y divide-slate-700/30">
            {data && data.recentSystemLogs === null ? (
              <li className="px-5 py-6 text-center text-amber-400 text-sm">지금 읽지 못했습니다</li>
            ) : (data?.recentSystemLogs ?? []).length === 0 ? (
              <li className="px-5 py-6 text-center text-slate-500 text-sm">로그 없음</li>
            ) : (data.recentSystemLogs ?? []).map((l: any, i: number) => (
              <li key={i} className="px-5 py-3">
                <div className="flex items-start gap-2">
                  <span className={`text-xs font-bold flex-shrink-0 ${l.level === 'critical' ? 'text-red-400' : 'text-amber-400'}`}>
                    {l.level?.toUpperCase()}
                  </span>
                  <p className="text-xs text-slate-300 truncate">{l.message}</p>
                </div>
                <p className="text-[10px] text-slate-600 mt-0.5">{new Date(l.created_at).toLocaleString('ko-KR')}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* 빠른 실행 버튼 */}
      <div className="flex gap-3">
        <Link href="/super/organizations"
          className="flex items-center gap-2 px-5 py-2.5 bg-[#7C3AED] hover:bg-[#6D28D9] text-white text-sm font-semibold rounded-xl transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4"/></svg>
          새 기관 등록
        </Link>
        <Link href="/super/notices"
          className="flex items-center gap-2 px-5 py-2.5 bg-[#1E293B] border border-slate-700 hover:border-[#7C3AED] text-slate-300 text-sm font-semibold rounded-xl transition-colors">
          📢 공지 작성
        </Link>
        <Link href="/super/usage"
          className="flex items-center gap-2 px-5 py-2.5 bg-[#1E293B] border border-slate-700 hover:border-[#7C3AED] text-slate-300 text-sm font-semibold rounded-xl transition-colors">
          📊 사용량 리포트
        </Link>
      </div>
    </div>
  );
}
