'use client';

import { useState, useEffect } from 'react';

interface QuickStatsData {
  totalDocuments: number;
  totalUsers: number;
  totalAgents: number;
  monthlyTokens: number;
}

export default function QuickStats() {
  const [stats, setStats] = useState<QuickStatsData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch('/api/stats')
      .then((r) => r.json())
      .then((result) => {
        if (result.ok) setStats(result.data);
        else setFailed(true);
      })
      .catch(() => setFailed(true));
  }, []);

  const fmt = (n: number | undefined) =>
    n == null ? '--' : n.toLocaleString('ko-KR');

  return (
    <div className="space-y-2">
    {failed && (
      <p className="text-sm text-amber-700">통계를 지금 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요.</p>
    )}
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div className="p-6 border rounded-lg bg-gradient-to-br from-ws-accent-soft to-ws-accent/15 border-ws-accent/30">
        <h3 className="text-lg font-medium text-ws-accent-text">총 문서</h3>
        <p className="text-3xl font-bold text-ws-accent-text mt-2">{fmt(stats?.totalDocuments)}</p>
        <p className="text-sm text-ws-accent-text mt-1">관리 범위의 문서(지난 판 제외)</p>
      </div>

      <div className="p-6 border rounded-lg bg-gradient-to-br from-green-50 to-green-100 border-green-200">
        <h3 className="text-lg font-medium text-green-900">활성 사용자</h3>
        <p className="text-3xl font-bold text-green-700 mt-2">{fmt(stats?.totalUsers)}</p>
        <p className="text-sm text-green-600 mt-1">관리 범위의 사용 중인 계정</p>
      </div>

      <div className="p-6 border rounded-lg bg-gradient-to-br from-purple-50 to-purple-100 border-purple-200">
        <h3 className="text-lg font-medium text-purple-900">AI 비서</h3>
        <p className="text-3xl font-bold text-purple-700 mt-2">{fmt(stats?.totalAgents)}</p>
        <p className="text-sm text-purple-600 mt-1">공식·부서 비서(나만의 비서 제외)</p>
      </div>

      <div className="p-6 border rounded-lg bg-gradient-to-br from-orange-50 to-orange-100 border-orange-200">
        <h3 className="text-lg font-medium text-orange-900">이번 달 토큰</h3>
        <p className="text-3xl font-bold text-orange-700 mt-2">{fmt(stats?.monthlyTokens)}</p>
        <p className="text-sm text-orange-600 mt-1">이번 달 AI 사용 토큰(한국 시간)</p>
      </div>
    </div>
    </div>
  );
}
