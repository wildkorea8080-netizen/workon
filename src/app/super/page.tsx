'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from 'recharts';

const fmt = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` :
  n >= 1_000     ? `${(n / 1_000).toFixed(0)}K`     : String(n ?? 0);

const fmtDate = (s: string) => new Date(s).toLocaleDateString('ko-KR');

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

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch('/api/super/dashboard');
    const d   = await res.json();
    if (d.ok) setData(d.data);
    setLoading(false);
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
    { icon: '🏢', label: '전체 기관',   value: `${o.total ?? 0}개`,  sub: `활성 ${o.active ?? 0}개` },
    { icon: '✅', label: '활성 기관',   value: `${o.active ?? 0}개`, sub: `정지 ${o.suspended ?? 0}개` },
    { icon: '👥', label: '전체 사용자', value: `${u.total ?? 0}명`,  sub: `오늘 활성 ${u.activeToday ?? 0}명` },
    { icon: '🆕', label: '이번달 신규', value: `${u.newThisMonth ?? 0}명`, sub: '신규 가입' },
  ];
  const CARDS_ROW2 = [
    { icon: '💬', label: '오늘 대화',   value: `${us.todayConversations ?? 0}건` },
    { icon: '🔤', label: '이번달 토큰', value: fmt(us.monthTokens ?? 0) },
    { icon: '💰', label: '이번달 매출', value: `${(r.thisMonth ?? 0).toLocaleString()}원` },
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

      {/* 알림 배너 */}
      {(al.tokenExceeded > 0 || al.expiringContracts > 0) && (
        <div className="flex items-center gap-4 p-4 bg-red-950/30 border border-red-700/40 rounded-2xl">
          <span className="text-xl">🚨</span>
          <div className="flex-1 text-sm text-red-300">
            {al.tokenExceeded > 0 && <span className="font-semibold">토큰 한도 초과 기관 {al.tokenExceeded}개</span>}
            {al.tokenExceeded > 0 && al.expiringContracts > 0 && <span className="mx-2 text-red-600">|</span>}
            {al.expiringContracts > 0 && <span className="font-semibold">계약 만료 임박 {al.expiringContracts}개</span>}
            {al.tokenWarnings > 0 && <span className="ml-2 text-amber-400">(경고: {al.tokenWarnings}개)</span>}
          </div>
          <div className="flex gap-2 flex-shrink-0">
            {al.tokenExceeded > 0 && (
              <Link href="/super/usage" className="px-3 py-1.5 bg-red-700/40 hover:bg-red-700/60 text-red-300 text-xs font-semibold rounded-lg transition-colors">사용량 확인</Link>
            )}
            {al.expiringContracts > 0 && (
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
        </div>

        {/* 플랜별 기관 분포 도넛 (40%) */}
        <div className="col-span-2 bg-[#1E293B] border border-slate-700/50 rounded-2xl p-6">
          <h3 className="text-sm font-bold text-white mb-4">플랜별 기관 분포</h3>
          {(data?.planChart?.length ?? 0) === 0 ? (
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
            {(data?.recentOrgs ?? []).length === 0 ? (
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
            {(data?.topUsageOrgs ?? []).length === 0 ? (
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
            {(data?.recentSystemLogs ?? []).length === 0 ? (
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
