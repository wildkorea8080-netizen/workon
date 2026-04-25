'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, BarChart,
} from 'recharts';

const fmt = (n: number) =>
  n >= 1_000_000 ? `${(n/1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n/1_000).toFixed(0)}K` : String(n ?? 0);

function barColor(pct: number) {
  if (pct >= 90) return '#EF4444';
  if (pct >= 70) return '#F59E0B';
  return '#7C3AED';
}

type Period = 'today' | 'week' | 'month' | 'custom';

// ═══════════════════════════════════════════════════════════
export default function UsagePage() {
  const router = useRouter();
  const [period, setPeriod]       = useState<Period>('month');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate]     = useState('');
  const [orgId, setOrgId]         = useState('all');
  const [orgs, setOrgs]           = useState<any[]>([]);
  const [data, setData]           = useState<any>(null);
  const [alerts, setAlerts]       = useState<any>(null);
  const [realtime, setRealtime]   = useState<any>(null);
  const [loading, setLoading]     = useState(true);
  const [limitModal, setLimitModal] = useState<any>(null);
  const realtimeRef = useRef<NodeJS.Timeout>();

  // 기관 목록
  useEffect(() => {
    fetch('/api/super/organizations?limit=100').then(r => r.json())
      .then(d => { if (d.ok) setOrgs(d.data); });
  }, []);

  const fetchMain = useCallback(async () => {
    setLoading(true);
    const p = new URLSearchParams({ period, orgId });
    if (period === 'custom' && startDate) p.set('startDate', startDate);
    if (period === 'custom' && endDate)   p.set('endDate',   endDate);
    const [main, alertRes] = await Promise.all([
      fetch(`/api/super/usage?${p}`).then(r => r.json()),
      fetch('/api/super/usage/alerts').then(r => r.json()),
    ]);
    if (main.ok)    setData(main.data);
    if (alertRes.ok) setAlerts(alertRes.data);
    setLoading(false);
  }, [period, orgId, startDate, endDate]);

  const fetchRealtime = useCallback(async () => {
    const res = await fetch('/api/super/usage/realtime');
    const d   = await res.json();
    if (d.ok) setRealtime(d.data);
  }, []);

  useEffect(() => { fetchMain(); }, [fetchMain]);

  // 실시간 30초 자동 새로고침 (오늘 선택 시)
  useEffect(() => {
    if (period === 'today') {
      fetchRealtime();
      realtimeRef.current = setInterval(fetchRealtime, 30000);
    }
    return () => clearInterval(realtimeRef.current);
  }, [period, fetchRealtime]);

  const handleLimitSave = async (orgId: string, newLimit: number) => {
    await fetch(`/api/super/organizations/${orgId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monthly_token_limit: newLimit }),
    });
    setLimitModal(null);
    fetchMain();
  };

  const exportCsv = () => {
    if (!data?.orgStats) return;
    const rows = [
      '기관명,플랜,대화수,입력토큰,출력토큰,비용(USD),활성사용자,한도사용률(%)',
      ...data.orgStats.map((s: any) =>
        `${s.orgName},${s.plan},${s.conversations},${s.inputTokens},${s.outputTokens},${s.estimatedCost},${s.activeUsers},${s.usagePercent}`
      ),
    ].join('\n');
    const blob = new Blob(['﻿' + rows], { type: 'text/csv;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = '사용량_리포트.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const s = data?.summary ?? {};
  const SUMMARY_CARDS = [
    { icon: '💬', label: '총 대화 수',       value: (s.totalConversations ?? 0).toLocaleString() + '건' },
    { icon: '🔤', label: '입력 토큰',         value: fmt(s.totalInputTokens  ?? 0) },
    { icon: '📤', label: '출력 토큰',         value: fmt(s.totalOutputTokens ?? 0) },
    { icon: '👥', label: '활성 사용자',       value: (s.totalActiveUsers ?? 0) + '명' },
    { icon: '💰', label: '예상 비용 (USD)',   value: `$${s.estimatedCostUsd ?? 0}` },
  ];

  return (
    <div className="space-y-6">
      {/* 헤더 */}
      <div>
        <h1 className="text-2xl font-bold text-white">사용량 모니터링</h1>
        <p className="text-slate-400 text-sm mt-1">전체 기관 API 사용량 집계</p>
      </div>

      {/* 필터 바 */}
      <div className="flex flex-wrap items-center gap-3 p-4 bg-[#1E293B] border border-slate-700/50 rounded-2xl">
        <div className="flex gap-1">
          {(['today','week','month','custom'] as Period[]).map(p => (
            <button key={p} onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                period === p ? 'bg-[#7C3AED] text-white' : 'bg-[#0F172A] text-slate-400 hover:text-white border border-slate-700'
              }`}>
              {p === 'today' ? '오늘' : p === 'week' ? '이번 주' : p === 'month' ? '이번달' : '직접 입력'}
            </button>
          ))}
        </div>
        {period === 'custom' && (
          <div className="flex items-center gap-2">
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
              className="px-3 py-1.5 bg-[#0F172A] border border-slate-700 rounded-lg text-sm text-white focus:outline-none focus:border-[#7C3AED]" />
            <span className="text-slate-500">~</span>
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
              className="px-3 py-1.5 bg-[#0F172A] border border-slate-700 rounded-lg text-sm text-white focus:outline-none focus:border-[#7C3AED]" />
          </div>
        )}
        <select value={orgId} onChange={e => setOrgId(e.target.value)}
          className="px-3 py-1.5 bg-[#0F172A] border border-slate-700 rounded-lg text-sm text-white focus:outline-none focus:border-[#7C3AED]">
          <option value="all">전체 기관</option>
          {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <button onClick={fetchMain} className="px-5 py-1.5 bg-[#7C3AED] hover:bg-[#6D28D9] text-white text-sm font-semibold rounded-lg transition-colors">
          조회
        </button>
      </div>

      {/* 실시간 현황 (오늘 선택 시) */}
      {period === 'today' && realtime && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-slate-400 uppercase tracking-wider">실시간 현황</h2>
            <span className="text-xs text-slate-600">
              🔄 마지막 업데이트: {realtime.timestamp ? new Date(realtime.timestamp).toLocaleTimeString('ko-KR') : '—'}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-4">
            {[
              { icon: '🟢', label: '현재 활성 사용자 (5분 내)', value: `${realtime.activeNow}명` },
              { icon: '💬', label: '최근 1시간 대화',            value: `${realtime.lastHourConversations}건` },
              { icon: '🔤', label: '최근 1시간 토큰',            value: fmt(realtime.lastHourTokens) },
            ].map(c => (
              <div key={c.label} className="bg-[#1E293B] border border-emerald-700/20 rounded-2xl p-4">
                <span className="text-xl">{c.icon}</span>
                <p className="text-2xl font-bold text-white mt-2">{c.value}</p>
                <p className="text-xs text-slate-500">{c.label}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 요약 카드 */}
      <div className="grid grid-cols-5 gap-3">
        {loading ? (
          Array.from({length:5}).map((_,i) => (
            <div key={i} className="bg-[#1E293B] border border-slate-700/50 rounded-2xl p-4">
              <div className="h-6 w-6 bg-slate-700/50 rounded mb-2 animate-pulse" />
              <div className="h-6 bg-slate-700/50 rounded mb-1 animate-pulse" />
              <div className="h-3 bg-slate-700/30 rounded animate-pulse" />
            </div>
          ))
        ) : SUMMARY_CARDS.map(c => (
          <div key={c.label} className="bg-[#1E293B] border border-slate-700/50 rounded-2xl p-4">
            <span className="text-xl">{c.icon}</span>
            <p className="text-xl font-bold text-white mt-2">{c.value}</p>
            <p className="text-xs text-slate-500 mt-0.5">{c.label}</p>
          </div>
        ))}
      </div>

      {/* 차트 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 차트 1: 시간/일별 대화 + 토큰 */}
        <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl p-6">
          <h3 className="text-sm font-bold text-white mb-4">
            {period === 'today' ? '시간대별 현황' : '일별 현황'}
          </h3>
          {loading ? (
            <div className="h-48 flex items-center justify-center">
              <div className="w-6 h-6 border-2 border-[#7C3AED]/30 border-t-[#7C3AED] rounded-full animate-spin" />
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart data={data?.timeStats ?? []} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis
                  dataKey={period === 'today' ? 'hour' : 'date'}
                  tickFormatter={v => period === 'today' ? v : (v as string).slice(5)}
                  tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false}
                />
                <YAxis yAxisId="left"  tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} allowDecimals={false} />
                <YAxis yAxisId="right" orientation="right" tickFormatter={fmt} tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{ background: '#1E293B', border: '1px solid #334155', borderRadius: 8, fontSize: 11 }}
                  formatter={(v, name) => [
                    String(name ?? '').includes('토큰') ? fmt(Number(v ?? 0)) : (v ?? 0),
                    name ?? '',
                  ]}
                />
                <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />
                <Bar yAxisId="left" dataKey="conversations" name="대화 수" fill="#3B82F6" radius={[2,2,0,0]} maxBarSize={20} />
                <Line yAxisId="right" type="monotone" dataKey="outputTokens" name="출력 토큰" stroke="#7C3AED" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* 차트 2: 기관별 토큰 Top 10 수평 막대 */}
        <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl p-6">
          <h3 className="text-sm font-bold text-white mb-4">기관별 토큰 사용량 Top 10</h3>
          {loading ? (
            <div className="h-48 flex items-center justify-center">
              <div className="w-6 h-6 border-2 border-[#7C3AED]/30 border-t-[#7C3AED] rounded-full animate-spin" />
            </div>
          ) : (data?.orgStats?.length ?? 0) === 0 ? (
            <div className="h-48 flex items-center justify-center text-slate-500 text-sm">데이터 없음</div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart
                layout="vertical"
                data={(data?.orgStats ?? []).slice(0, 10).map((o: any) => ({
                  name: o.orgName.length > 8 ? o.orgName.slice(0, 8) + '…' : o.orgName,
                  tokens: o.totalTokens,
                  pct: o.usagePercent,
                }))}
                margin={{ top: 0, right: 40, bottom: 0, left: 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" horizontal={false} />
                <XAxis type="number" tickFormatter={fmt} tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="name" width={80} tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{ background: '#1E293B', border: '1px solid #334155', borderRadius: 8, fontSize: 11 }}
                  formatter={(v: any) => [fmt(Number(v)), '토큰']}
                />
                <Bar dataKey="tokens" radius={[0,4,4,0]} maxBarSize={16} fill="#7C3AED" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* 한도 알림 섹션 */}
      {alerts && (alerts.exceeded?.length > 0 || alerts.warning?.length > 0) && (
        <div className="space-y-3">
          {alerts.exceeded?.length > 0 && (
            <div className="bg-red-950/30 border border-red-700/40 rounded-2xl p-5 space-y-3">
              <h3 className="text-sm font-bold text-red-400">🚨 한도 초과 기관 ({alerts.exceeded.length}개)</h3>
              <table className="w-full text-sm">
                <thead><tr>
                  {['기관명','사용량','한도','초과량','조치'].map(h => (
                    <th key={h} className="text-left pb-2 text-xs font-semibold text-red-400/70">{h}</th>
                  ))}
                </tr></thead>
                <tbody className="divide-y divide-red-900/20">
                  {alerts.exceeded.map((a: any) => (
                    <tr key={a.orgId}>
                      <td className="py-2 font-medium text-white">{a.orgName}</td>
                      <td className="py-2 text-red-400">{fmt(a.usedTokens)}</td>
                      <td className="py-2 text-slate-400">{fmt(a.limit)}</td>
                      <td className="py-2 text-red-400 font-semibold">{fmt(a.excessTokens)}</td>
                      <td className="py-2">
                        <div className="flex gap-1.5">
                          <button onClick={() => setLimitModal(a)}
                            className="px-2.5 py-1 bg-slate-700 hover:bg-slate-600 text-white text-xs rounded-lg">한도 증량</button>
                          <button onClick={() => fetch(`/api/super/organizations/${a.orgId}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({status:'suspended'}) }).then(() => fetchMain())}
                            className="px-2.5 py-1 bg-red-900/40 hover:bg-red-900/60 text-red-400 text-xs rounded-lg">서비스 정지</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {alerts.warning?.length > 0 && (
            <div className="bg-amber-950/20 border border-amber-700/30 rounded-2xl p-5 space-y-3">
              <h3 className="text-sm font-bold text-amber-400">⚠️ 한도 80% 이상 경고 ({alerts.warning.length}개)</h3>
              <table className="w-full text-sm">
                <thead><tr>
                  {['기관명','사용량','한도','사용률','조치'].map(h => (
                    <th key={h} className="text-left pb-2 text-xs font-semibold text-amber-400/70">{h}</th>
                  ))}
                </tr></thead>
                <tbody className="divide-y divide-amber-900/20">
                  {alerts.warning.map((a: any) => (
                    <tr key={a.orgId}>
                      <td className="py-2 font-medium text-white">{a.orgName}</td>
                      <td className="py-2 text-amber-400">{fmt(a.usedTokens)}</td>
                      <td className="py-2 text-slate-400">{fmt(a.limit)}</td>
                      <td className="py-2">
                        <span className="font-semibold text-amber-400">{a.usagePercent}%</span>
                      </td>
                      <td className="py-2">
                        <button onClick={() => setLimitModal(a)}
                          className="px-2.5 py-1 bg-amber-900/30 hover:bg-amber-900/50 text-amber-400 text-xs rounded-lg">한도 증량</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* 기관별 상세 테이블 */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-400 uppercase tracking-wider">기관별 상세 현황</h2>
          <button onClick={exportCsv}
            className="flex items-center gap-1.5 px-4 py-2 bg-[#1E293B] border border-slate-700 hover:border-[#7C3AED] text-slate-300 text-xs font-semibold rounded-xl transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            CSV 내보내기
          </button>
        </div>

        <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-700/50">
              <tr>
                {['기관명','플랜','대화수','입력 토큰','출력 토큰','비용(USD)','활성 사용자','한도 사용률'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/30">
              {loading ? (
                Array.from({length:3}).map((_,i) => (
                  <tr key={i}>{Array.from({length:8}).map((_,j) => (
                    <td key={j} className="px-4 py-4"><div className="h-3 bg-slate-700/50 rounded animate-pulse"/></td>
                  ))}</tr>
                ))
              ) : (data?.orgStats?.length ?? 0) === 0 ? (
                <tr><td colSpan={8} className="px-4 py-10 text-center text-slate-500">데이터 없음</td></tr>
              ) : (
                data.orgStats.map((o: any) => (
                  <tr key={o.orgId}
                    className="hover:bg-slate-700/20 transition-colors cursor-pointer"
                    onClick={() => router.push(`/super/organizations/${o.orgId}?tab=usage`)}>
                    <td className="px-4 py-3 font-semibold text-white">{o.orgName}</td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 bg-slate-700 text-slate-300 text-xs rounded-full">{(o.plan ?? '—').toUpperCase()}</span>
                    </td>
                    <td className="px-4 py-3 text-slate-300">{o.conversations.toLocaleString()}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs font-mono">{fmt(o.inputTokens)}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs font-mono">{fmt(o.outputTokens)}</td>
                    <td className="px-4 py-3 text-slate-300">${o.estimatedCost}</td>
                    <td className="px-4 py-3 text-slate-400">{o.activeUsers}명</td>
                    <td className="px-4 py-3 min-w-[120px]">
                      {o.tokenLimit > 0 ? (
                        <div className="space-y-1">
                          <div className="flex justify-between text-xs">
                            <span className={o.usagePercent >= 90 ? 'text-red-400 font-semibold' : o.usagePercent >= 70 ? 'text-amber-400' : 'text-emerald-400'}>
                              {o.usagePercent}%
                            </span>
                          </div>
                          <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
                            <div className="h-full rounded-full transition-all"
                              style={{ width: `${Math.min(o.usagePercent, 100)}%`, backgroundColor: barColor(o.usagePercent) }} />
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-600">한도 없음</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 한도 증량 모달 */}
      {limitModal && (
        <LimitModal org={limitModal} onClose={() => setLimitModal(null)} onSave={handleLimitSave} />
      )}
    </div>
  );
}

// ─── 한도 증량 모달 ───────────────────────────────────────────
function LimitModal({ org, onClose, onSave }: { org: any; onClose: () => void; onSave: (id: string, v: number) => void }) {
  const [val, setVal] = useState(String(Math.ceil((org.limit ?? 2000000) * 1.5 / 1000000) * 1000000));
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
      <div className="bg-[#1E293B] border border-slate-700 rounded-2xl p-6 w-full max-w-sm space-y-4">
        <h3 className="text-base font-bold text-white">한도 증량 — {org.orgName}</h3>
        <div>
          <p className="text-xs text-slate-400 mb-1">현재 한도: {(org.limit ?? 0).toLocaleString()} 토큰</p>
          <label className="block text-xs font-semibold text-slate-400 mb-1.5">새 한도 (토큰)</label>
          <input type="number" value={val} onChange={e => setVal(e.target.value)} min={1000000} step={1000000}
            className="w-full px-4 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]" />
        </div>
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-2.5 border border-slate-700 rounded-xl text-sm text-slate-400 hover:text-white">취소</button>
          <button onClick={() => onSave(org.orgId, Number(val))}
            className="flex-1 py-2.5 bg-[#7C3AED] hover:bg-[#6D28D9] text-white font-semibold rounded-xl text-sm">저장</button>
        </div>
      </div>
    </div>
  );
}
