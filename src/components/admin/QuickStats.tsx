'use client';

import { useState, useEffect } from 'react';

interface QuickStatsData {
  totalDocuments: number;
  totalUsers: number;
  totalAgents: number;
  totalTokens: number;
}

export default function QuickStats() {
  const [stats, setStats] = useState<QuickStatsData | null>(null);

  useEffect(() => {
    fetch('/api/stats')
      .then((r) => r.json())
      .then((result) => {
        if (result.ok) setStats(result.data);
      })
      .catch(() => {});
  }, []);

  const fmt = (n: number | undefined) =>
    n == null ? '--' : n.toLocaleString('ko-KR');

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div className="p-6 border rounded-lg bg-gradient-to-br from-blue-50 to-blue-100 border-blue-200">
        <h3 className="text-lg font-medium text-blue-900">총 문서</h3>
        <p className="text-3xl font-bold text-blue-700 mt-2">{fmt(stats?.totalDocuments)}</p>
        <p className="text-sm text-blue-600 mt-1">업로드된 문서 수</p>
      </div>

      <div className="p-6 border rounded-lg bg-gradient-to-br from-green-50 to-green-100 border-green-200">
        <h3 className="text-lg font-medium text-green-900">활성 사용자</h3>
        <p className="text-3xl font-bold text-green-700 mt-2">{fmt(stats?.totalUsers)}</p>
        <p className="text-sm text-green-600 mt-1">부서 내 사용자 수</p>
      </div>

      <div className="p-6 border rounded-lg bg-gradient-to-br from-purple-50 to-purple-100 border-purple-200">
        <h3 className="text-lg font-medium text-purple-900">AI 에이전트</h3>
        <p className="text-3xl font-bold text-purple-700 mt-2">{fmt(stats?.totalAgents)}</p>
        <p className="text-sm text-purple-600 mt-1">등록된 AI 비서 수</p>
      </div>

      <div className="p-6 border rounded-lg bg-gradient-to-br from-orange-50 to-orange-100 border-orange-200">
        <h3 className="text-lg font-medium text-orange-900">토큰 사용량</h3>
        <p className="text-3xl font-bold text-orange-700 mt-2">{fmt(stats?.totalTokens)}</p>
        <p className="text-sm text-orange-600 mt-1">AI API 토큰 총 사용량</p>
      </div>
    </div>
  );
}
