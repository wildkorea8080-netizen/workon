'use client';

import { useState, useEffect } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
} from 'recharts';

interface UsageData {
  date: string;
  documents: number;
  conversations: number;
  reports: number;
  tokens: number;
}

interface UsageChartProps {
  period?: '7d' | '30d' | '90d';
}

const COLORS = ['#3B82F6', '#10B981', '#8B5CF6', '#F59E0B'];

export default function UsageChart({ period = '30d' }: UsageChartProps) {
  const [usageData, setUsageData] = useState<UsageData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState(period);

  useEffect(() => {
    loadUsageData();
  }, [selectedPeriod]);

  const loadUsageData = async () => {
    try {
      // Calculate date range
      const endDate = new Date();
      const startDate = new Date();

      switch (selectedPeriod) {
        case '7d':
          startDate.setDate(endDate.getDate() - 7);
          break;
        case '30d':
          startDate.setDate(endDate.getDate() - 30);
          break;
        case '90d':
          startDate.setDate(endDate.getDate() - 90);
          break;
      }

      const response = await fetch(
        `/api/stats/usage?start=${startDate.toISOString()}&end=${endDate.toISOString()}`
      );


      const result = await response.json();

      if (!result.ok) {
        throw new Error(result.error?.message || '사용량 데이터 로드 실패');
      }

      setUsageData(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '사용량 데이터 로드 중 오류가 발생했습니다.');
      // 가짜 데이터로 채우지 않는다. 이 화면을 보고 집행률을 보고하는데,
      // 무작위 숫자를 '사용량 추이'라는 이름으로 띄우면 아무것도 안 보여주는
      // 것보다 나쁘다. 실패했으면 실패했다고 두고 빈 차트를 보여준다.
      setUsageData([]);
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
  };

  const getTotalStats = () => {
    return usageData.reduce(
      (acc, day) => ({
        documents: acc.documents + day.documents,
        conversations: acc.conversations + day.conversations,
        reports: acc.reports + day.reports,
        tokens: acc.tokens + day.tokens,
      }),
      { documents: 0, conversations: 0, reports: 0, tokens: 0 }
    );
  };

  const getPieData = () => {
    const totals = getTotalStats();
    return [
      { name: '문서', value: totals.documents, color: COLORS[0] },
      { name: '대화', value: totals.conversations, color: COLORS[1] },
      { name: '보고서', value: totals.reports, color: COLORS[2] },
      { name: '토큰', value: totals.tokens / 100, color: COLORS[3] }, // Scale down tokens for pie chart
    ].filter(item => item.value > 0);
  };

  if (loading) {
    return <div className="text-center py-8">차트 로딩 중...</div>;
  }

  if (error && usageData.length === 0) {
    return <div className="p-4 text-red-700 bg-red-100 rounded-lg">{error}</div>;
  }

  return (
    <div className="space-y-6">
      {/* Period selector */}
      <div className="flex gap-2">
        {[
          { key: '7d', label: '7일' },
          { key: '30d', label: '30일' },
          { key: '90d', label: '90일' },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setSelectedPeriod(key as '7d' | '30d' | '90d')}
            className={`px-3 py-1 text-sm rounded transition-colors ${
              selectedPeriod === key
                ? 'bg-slate-900 text-white'
                : 'border border-slate-300 hover:bg-slate-50'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Object.entries(getTotalStats()).map(([key, value], index) => {
          const labels = {
            documents: '문서',
            conversations: '대화',
            reports: '보고서',
            tokens: '토큰',
          };
          return (
            <div key={key} className="p-4 border rounded-lg bg-white">
              <div className="flex items-center space-x-2">
                <div
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: COLORS[index] }}
                />
                <span className="text-sm font-medium text-slate-600">
                  {labels[key as keyof typeof labels]}
                </span>
              </div>
              <p className="text-2xl font-bold text-slate-900 mt-2">
                {key === 'tokens' ? value.toLocaleString() : value}
              </p>
            </div>
          );
        })}
      </div>

      {/* Charts */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Line Chart */}
        <div className="p-6 border rounded-lg bg-white">
          <h3 className="text-lg font-medium mb-4">사용량 추이</h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={usageData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tickFormatter={formatDate}
                fontSize={12}
              />
              <YAxis fontSize={12} />
              <Tooltip
                labelFormatter={(value) => formatDate(value as string)}
                formatter={(value, name) => {
                  const labels: Record<string, string> = {
                    documents: '문서',
                    conversations: '대화',
                    reports: '보고서',
                    tokens: '토큰',
                  };
                  return [value, labels[name as string] ?? String(name)];
                }}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="documents"
                stroke={COLORS[0]}
                strokeWidth={2}
                name="documents"
              />
              <Line
                type="monotone"
                dataKey="conversations"
                stroke={COLORS[1]}
                strokeWidth={2}
                name="conversations"
              />
              <Line
                type="monotone"
                dataKey="reports"
                stroke={COLORS[2]}
                strokeWidth={2}
                name="reports"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Bar Chart */}
        <div className="p-6 border rounded-lg bg-white">
          <h3 className="text-lg font-medium mb-4">토큰 사용량</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={usageData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tickFormatter={formatDate}
                fontSize={12}
              />
              <YAxis fontSize={12} />
              <Tooltip
                labelFormatter={(value) => formatDate(value as string)}
                formatter={(value) => {
                  const num = typeof value === 'number' ? value : 0;
                  return [num.toLocaleString(), '토큰'];
                }}
              />
              <Bar dataKey="tokens" fill={COLORS[3]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Pie Chart */}
      <div className="p-6 border rounded-lg bg-white">
        <h3 className="text-lg font-medium mb-4">활동 분포</h3>
        <div className="flex flex-col lg:flex-row items-center">
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={getPieData()}
                cx="50%"
                cy="50%"
                labelLine={false}
                label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
                outerRadius={80}
                fill="#8884d8"
                dataKey="value"
              >
                {getPieData().map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {error && (
        <div className="p-4 text-amber-700 bg-amber-100 rounded-lg">
          <p className="text-sm">해당 기간에 사용 내역이 없습니다.</p>
        </div>
      )}
    </div>
  );
}