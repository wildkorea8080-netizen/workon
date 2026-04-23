'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

type Period = 'week' | 'month' | 'last_month' | '3months';

const PERIODS: { key: Period; label: string }[] = [
  { key: 'week',       label: '이번 주' },
  { key: 'month',      label: '이번달' },
  { key: 'last_month', label: '지난달' },
  { key: '3months',    label: '3개월' },
];

interface Summary {
  monthlyConvCount: number;
  monthlyTokenEstimate: number;
  topAgent: { name: string; icon?: string; convCount: number } | null;
  streakDays: number;
}

interface DailyPoint {
  date: string;      // "YYYY-MM-DD"
  count: number;
}

interface AgentStat {
  agentId: string;
  name: string;
  icon?: string;
  convCount: number;
  tokenEstimate: number;
  lastUsed: string;
}

interface RecentConv {
  id: string;
  title: string;
  agentName: string | null;
  agentIcon: string | null;
  createdAt: string;
}

interface StatsData {
  summary: Summary;
  dailyChart: DailyPoint[];
  agentStats: AgentStat[];
  recentConversations: RecentConv[];
}

function formatDate(isoStr: string) {
  const d = new Date(isoStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatDateFull(isoStr: string) {
  const d = new Date(isoStr);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function MyStatsPage() {
  const [period, setPeriod] = useState<Period>('month');
  const [data, setData] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async (p: Period) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/my/stats?period=${p}`);
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      setData(result.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : '오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchStats(period); }, [period, fetchStats]);

  const handlePeriodChange = (p: Period) => { setPeriod(p); };

  return (
    <div className="min-h-screen bg-[#F5F7FA] pt-14">
      <div className="max-w-5xl mx-auto px-4 py-8">

        {/* 헤더 */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-slate-900">내 사용현황</h1>
            <p className="text-sm text-slate-500 mt-0.5">AI 업무도우미 사용 통계를 확인하세요.</p>
          </div>
          <Link
            href="/"
            className="text-sm text-brand-600 hover:text-brand-700 font-medium flex items-center gap-1"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            홈으로
          </Link>
        </div>

        {/* 기간 필터 */}
        <div className="flex gap-2 mb-6">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => handlePeriodChange(p.key)}
              className={`px-4 py-2 text-sm font-semibold rounded-lg transition-colors ${
                period === p.key
                  ? 'bg-[#1C2B4A] text-white'
                  : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6 text-sm text-red-600">
            {error}
          </div>
        )}

        {/* 요약 카드 */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <SummaryCard
            emoji="💬"
            label="이번달 대화 수"
            value={loading ? '—' : `${data?.summary.monthlyConvCount ?? 0}건`}
          />
          <SummaryCard
            emoji="🔤"
            label="이번달 사용 토큰"
            value={loading ? '—' : formatTokens(data?.summary.monthlyTokenEstimate ?? 0)}
          />
          <SummaryCard
            emoji="⭐"
            label="가장 많이 쓴 비서"
            value={
              loading
                ? '—'
                : data?.summary.topAgent
                ? `${data.summary.topAgent.icon ?? ''} ${data.summary.topAgent.name}`.trim()
                : '없음'
            }
            sub={
              data?.summary.topAgent
                ? `${data.summary.topAgent.convCount}회 대화`
                : undefined
            }
          />
          <SummaryCard
            emoji="📅"
            label="연속 사용일"
            value={loading ? '—' : `${data?.summary.streakDays ?? 0}일`}
            sub="오늘 포함"
          />
        </div>

        {/* 일별 대화 차트 */}
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 mb-6">
          <h2 className="text-sm font-bold text-slate-700 mb-4">일별 대화 횟수</h2>
          {loading ? (
            <div className="h-48 flex items-center justify-center text-slate-400 text-sm">
              <Spinner />
            </div>
          ) : (data?.dailyChart?.length ?? 0) === 0 ? (
            <div className="h-48 flex items-center justify-center text-slate-400 text-sm">
              이 기간에 대화 기록이 없습니다.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={data!.dailyChart} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatDate}
                  tick={{ fontSize: 11, fill: '#94a3b8' }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 11, fill: '#94a3b8' }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  formatter={(v: number) => [`${v}건`, '대화 수']}
                  labelFormatter={(l: string) => formatDateFull(l)}
                  contentStyle={{
                    fontSize: 12,
                    borderRadius: 8,
                    border: '1px solid #e2e8f0',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="count"
                  stroke="#1C2B4A"
                  strokeWidth={2}
                  dot={{ r: 3, fill: '#1C2B4A', strokeWidth: 0 }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* 비서별 사용 통계 */}
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
            <h2 className="text-sm font-bold text-slate-700 mb-4">비서별 사용 통계</h2>
            {loading ? (
              <div className="flex justify-center py-8"><Spinner /></div>
            ) : (data?.agentStats?.length ?? 0) === 0 ? (
              <p className="text-sm text-slate-400 text-center py-8">이 기간에 사용한 비서가 없습니다.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-slate-400 border-b border-slate-100">
                      <th className="text-left pb-2 font-medium">비서명</th>
                      <th className="text-right pb-2 font-medium">대화</th>
                      <th className="text-right pb-2 font-medium">토큰</th>
                      <th className="text-right pb-2 font-medium">마지막 사용</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data!.agentStats.map((s) => (
                      <tr key={s.agentId} className="border-b border-slate-50 last:border-0">
                        <td className="py-2.5 font-medium text-slate-800">
                          {s.icon && <span className="mr-1">{s.icon}</span>}
                          {s.name}
                        </td>
                        <td className="py-2.5 text-right text-slate-600">{s.convCount}건</td>
                        <td className="py-2.5 text-right text-slate-600">{formatTokens(s.tokenEstimate)}</td>
                        <td className="py-2.5 text-right text-slate-400">{formatDate(s.lastUsed)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* 최근 대화 */}
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
            <h2 className="text-sm font-bold text-slate-700 mb-4">최근 대화</h2>
            {loading ? (
              <div className="flex justify-center py-8"><Spinner /></div>
            ) : (data?.recentConversations?.length ?? 0) === 0 ? (
              <p className="text-sm text-slate-400 text-center py-8">이 기간에 대화 기록이 없습니다.</p>
            ) : (
              <ul className="space-y-1">
                {data!.recentConversations.map((c) => (
                  <li key={c.id}>
                    <Link
                      href={`/?conv=${c.id}`}
                      className="flex items-center gap-3 px-2 py-2.5 rounded-xl hover:bg-slate-50 transition-colors group"
                    >
                      <div className="w-8 h-8 rounded-lg bg-[#1C2B4A]/10 flex items-center justify-center text-base flex-shrink-0">
                        {c.agentIcon ?? '💬'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-800 truncate group-hover:text-[#1C2B4A]">
                          {c.title}
                        </p>
                        {c.agentName && (
                          <p className="text-xs text-slate-400 truncate">{c.agentName}</p>
                        )}
                      </div>
                      <span className="text-xs text-slate-400 flex-shrink-0">{formatDate(c.createdAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({
  emoji,
  label,
  value,
  sub,
}: {
  emoji: string;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5">
      <div className="text-2xl mb-3">{emoji}</div>
      <p className="text-xs text-slate-500 mb-1">{label}</p>
      <p className="text-lg font-bold text-slate-900 truncate">{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function Spinner() {
  return (
    <div className="w-5 h-5 border-2 border-[#1C2B4A]/30 border-t-[#1C2B4A] rounded-full animate-spin" />
  );
}
