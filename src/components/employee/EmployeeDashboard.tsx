'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface AgentInfo {
  id: string;
  name: string;
  description: string | null;
}

interface RecentConv {
  id: string;
  title: string | null;
  updated_at: string;
  agent: { id: string; name: string } | null;
}

interface DashboardData {
  recentConversations: RecentConv[];
  usedAgents: AgentInfo[];
  monthlyUsageCount: number;
}

export default function EmployeeDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/employee/stats')
      .then((r) => r.json())
      .then((result) => { if (result.ok) setData(result.data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      {/* 요약 카드 */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="p-6 border rounded-lg bg-gradient-to-br from-blue-50 to-blue-100 border-blue-200">
          <h3 className="text-sm font-medium text-blue-800">이번 달 사용 횟수</h3>
          <p className="text-3xl font-bold text-blue-700 mt-2">
            {loading ? '--' : (data?.monthlyUsageCount ?? 0).toLocaleString('ko-KR')}
          </p>
          <p className="text-xs text-blue-600 mt-1">대화 · 보고서 생성 합계</p>
        </div>

        <div className="p-6 border rounded-lg bg-gradient-to-br from-purple-50 to-purple-100 border-purple-200">
          <h3 className="text-sm font-medium text-purple-800">사용한 AI 비서</h3>
          <p className="text-3xl font-bold text-purple-700 mt-2">
            {loading ? '--' : (data?.usedAgents.length ?? 0)}
          </p>
          <p className="text-xs text-purple-600 mt-1">누적 사용 에이전트 수</p>
        </div>

        <div className="p-6 border rounded-lg bg-gradient-to-br from-green-50 to-green-100 border-green-200">
          <h3 className="text-sm font-medium text-green-800">전체 대화 수</h3>
          <p className="text-3xl font-bold text-green-700 mt-2">
            {loading ? '--' : (data?.recentConversations.length === 3 ? '3+' : data?.recentConversations.length ?? 0)}
          </p>
          <p className="text-xs text-green-600 mt-1">최근 대화 기록</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* 내가 사용한 비서 목록 */}
        <div className="p-6 border rounded-lg bg-white">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-base font-semibold text-slate-900">사용한 AI 비서</h2>
            <Link href="/employee/qna" className="text-xs text-slate-500 hover:text-slate-700">
              대화하기 →
            </Link>
          </div>

          {loading ? (
            <div className="space-y-2">
              {[1, 2].map((i) => (
                <div key={i} className="h-12 bg-slate-100 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : data?.usedAgents.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-4">
              아직 사용한 비서가 없습니다.
            </p>
          ) : (
            <div className="space-y-2">
              {data?.usedAgents.map((agent) => (
                <div key={agent.id} className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg">
                  <div className="w-8 h-8 bg-purple-100 rounded-full flex items-center justify-center flex-shrink-0">
                    <svg className="w-4 h-4 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900">{agent.name}</p>
                    {agent.description && (
                      <p className="text-xs text-slate-500 truncate">{agent.description}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 최근 대화 3개 */}
        <div className="p-6 border rounded-lg bg-white">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-base font-semibold text-slate-900">최근 대화</h2>
            <Link href="/employee/history" className="text-xs text-slate-500 hover:text-slate-700">
              전체 보기 →
            </Link>
          </div>

          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-14 bg-slate-100 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : data?.recentConversations.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-4">
              아직 대화 기록이 없습니다.
            </p>
          ) : (
            <div className="space-y-2">
              {data?.recentConversations.map((conv) => (
                <div key={conv.id} className="p-3 bg-slate-50 rounded-lg">
                  <div className="flex justify-between items-start gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 truncate">
                        {conv.title || '제목 없는 대화'}
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {conv.agent?.name ?? '비서 미지정'}
                      </p>
                    </div>
                    <span className="text-xs text-slate-400 flex-shrink-0">
                      {new Date(conv.updated_at).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 빠른 접근 */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Link
          href="/employee/qna"
          className="p-5 border rounded-lg bg-white hover:bg-slate-50 hover:shadow-sm transition-all group"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center group-hover:bg-blue-200 transition-colors">
              <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
              </svg>
            </div>
            <div>
              <p className="font-medium text-slate-900">AI 문서 Q&amp;A</p>
              <p className="text-sm text-slate-500">내부 문서에 대해 질문하기</p>
            </div>
          </div>
        </Link>

        <Link
          href="/employee/reports"
          className="p-5 border rounded-lg bg-white hover:bg-slate-50 hover:shadow-sm transition-all group"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center group-hover:bg-green-200 transition-colors">
              <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div>
              <p className="font-medium text-slate-900">보고서 생성</p>
              <p className="text-sm text-slate-500">템플릿으로 AI 보고서 작성</p>
            </div>
          </div>
        </Link>
      </div>
    </div>
  );
}
