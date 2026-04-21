'use client';

import { useState, useEffect } from 'react';
import UsageChart from './UsageChart';

interface Stats {
  totalDocuments: number;
  totalAgents: number;
  totalConversations: number;
  totalMessages: number;
  totalReports: number;
  totalTemplates: number;
  totalUsers: number;
  totalTokens: number;
  recentReports: number;
  recentActivity: Array<{
    action: string;
    created_at: string;
  }>;
}

export default function StatsDashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    try {
      const response = await fetch('/api/stats');
      const result = await response.json();

      if (!result.ok) {
        throw new Error(result.error?.message || '통계 로드 실패');
      }

      setStats(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '통계 로드 중 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const getActionLabel = (action: string) => {
    const labels: Record<string, string> = {
      login: '로그인',
      upload_document: '문서 업로드',
      generate_report: '보고서 생성',
      create_template: '템플릿 생성',
      update_template: '템플릿 수정',
      delete_document: '문서 삭제',
      chat_query: '질문하기',
    };
    return labels[action] || action;
  };

  if (loading) {
    return <div className="text-center py-8">로딩 중...</div>;
  }

  if (error) {
    return <div className="p-4 text-red-700 bg-red-100 rounded-lg">{error}</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">부서 통계</h2>
        <p className="text-slate-600 mt-1">현재 부서의 사용 현황을 확인하세요.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="p-6 border rounded-lg bg-white">
          <h3 className="text-lg font-medium text-slate-900">문서</h3>
          <p className="text-3xl font-bold text-slate-700 mt-2">{stats?.totalDocuments || 0}</p>
          <p className="text-sm text-slate-500 mt-1">업로드된 문서 수</p>
        </div>

        <div className="p-6 border rounded-lg bg-white">
          <h3 className="text-lg font-medium text-slate-900">AI 에이전트</h3>
          <p className="text-3xl font-bold text-slate-700 mt-2">{stats?.totalAgents || 0}</p>
          <p className="text-sm text-slate-500 mt-1">등록된 AI 에이전트 수</p>
        </div>

        <div className="p-6 border rounded-lg bg-white">
          <h3 className="text-lg font-medium text-slate-900">대화 세션</h3>
          <p className="text-3xl font-bold text-slate-700 mt-2">{stats?.totalConversations || 0}</p>
          <p className="text-sm text-slate-500 mt-1">진행된 대화 수</p>
        </div>

        <div className="p-6 border rounded-lg bg-white">
          <h3 className="text-lg font-medium text-slate-900">메시지</h3>
          <p className="text-3xl font-bold text-slate-700 mt-2">{stats?.totalMessages || 0}</p>
          <p className="text-sm text-slate-500 mt-1">전송된 메시지 수</p>
        </div>

        <div className="p-6 border rounded-lg bg-white">
          <h3 className="text-lg font-medium text-slate-900">보고서</h3>
          <p className="text-3xl font-bold text-slate-700 mt-2">{stats?.totalReports || 0}</p>
          <p className="text-sm text-slate-500 mt-1">생성된 보고서 수</p>
        </div>

        <div className="p-6 border rounded-lg bg-white">
          <h3 className="text-lg font-medium text-slate-900">템플릿</h3>
          <p className="text-3xl font-bold text-slate-700 mt-2">{stats?.totalTemplates || 0}</p>
          <p className="text-sm text-slate-500 mt-1">활성 보고서 템플릿 수</p>
        </div>

        <div className="p-6 border rounded-lg bg-white">
          <h3 className="text-lg font-medium text-slate-900">토큰 사용량</h3>
          <p className="text-3xl font-bold text-slate-700 mt-2">{stats?.totalTokens?.toLocaleString() || 0}</p>
          <p className="text-sm text-slate-500 mt-1">AI API 토큰 총 사용량</p>
        </div>

        <div className="p-6 border rounded-lg bg-white">
          <h3 className="text-lg font-medium text-slate-900">최근 보고서</h3>
          <p className="text-3xl font-bold text-slate-700 mt-2">{stats?.recentReports || 0}</p>
          <p className="text-sm text-slate-500 mt-1">최근 30일 생성 수</p>
        </div>

        <div className="p-6 border rounded-lg bg-white">
          <h3 className="text-lg font-medium text-slate-900">활성 상태</h3>
          <p className="text-3xl font-bold text-green-600 mt-2">정상</p>
          <p className="text-sm text-slate-500 mt-1">시스템 상태</p>
        </div>
      </div>

      {/* Usage Chart */}
      <div className="p-6 border rounded-lg bg-white">
        <h3 className="text-lg font-medium mb-4">사용량 추이</h3>
        <UsageChart />
      </div>

      {/* 최근 활동 */}
      <div className="p-6 border rounded-lg bg-white">
        <h3 className="text-lg font-medium mb-4">최근 활동 (7일)</h3>
        {stats?.recentActivity && stats.recentActivity.length > 0 ? (
          <div className="space-y-2">
            {stats.recentActivity.map((activity, index) => (
              <div key={index} className="flex justify-between items-center py-2 border-b border-slate-100 last:border-b-0">
                <span className="text-sm text-slate-700">{getActionLabel(activity.action)}</span>
                <span className="text-sm text-slate-500">
                  {new Date(activity.created_at).toLocaleDateString('ko-KR', {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-slate-500 text-sm">최근 활동이 없습니다.</p>
        )}
      </div>
    </div>
  );
}