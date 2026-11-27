'use client';

import { useState, useEffect } from 'react';
import { actionErrorText } from '@/lib/ok-json';
import UsageChart from './UsageChart';

interface Stats {
  /** 센 범위 — 내 부서 + 하위 부서(기관 직속 부서 관리자는 기관 전체)의 부서 수 */
  departmentCount: number;
  totalDocuments: number;
  totalAgents: number;
  totalConversations: number;
  totalMessages: number;
  totalUsers: number;
  /** 이번 달(한국 시간) 토큰 */
  monthlyTokens: number;
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
      setError(actionErrorText(err, '통계 로드 중 오류가 발생했습니다.'));
    } finally {
      setLoading(false);
    }
  };

  const getActionLabel = (action: string) => {
    // 이용통계(`USAGE_ACTION_LABELS`)와 같은 어휘 — 빠지면 코드가 그대로 보인다(예전엔 가장 흔한 chat_message가 없었다)
    const labels: Record<string, string> = {
      login: '로그인',
      upload_document: '문서 업로드',
      generate_report: '보고서 생성',
      create_template: '템플릿 생성',
      update_template: '템플릿 수정',
      delete_document: '문서 삭제',
      chat_query: '질문하기',
      chat_message: 'AI 대화',
      qna_search: '문서 질의',
      document_ocr: '스캔 문서 판독',
      file_attached: '파일 첨부',
      table_merged: '표 합치기',
      document_tag_suggest: '문서 태그 초안(AI)',
      answer_revised: '근거로 고쳐 쓰기(AI)',
      public_ask: '시민 상담(AI)',
      create_agent: '비서 생성',
      add_forbidden_word: '금지어 추가',
      delete_forbidden_word: '금지어 삭제',
      activate_forbidden_word: '금지어 활성화',
      deactivate_forbidden_word: '금지어 비활성화',
      conversation_title: '대화 제목 생성',
      document_generated: '문서 파일 생성',
      work_generate: '업무 파일 만들기(AI)',
      work_revise: '업무 문서 AI 수정',
      prompt_enhance: '프롬프트 다듬기',
      rag_eval_answer: '문서 찾기 평가 답변(AI)',
      rag_eval_judge: '문서 찾기 평가 채점(AI)',
      app_batch_judge: '앱 일괄 실행 채점(AI)',
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
        <h2 className="text-xl font-semibold">관리 범위 현황</h2>
        <p className="text-slate-600 mt-1">
          내 부서와 하위 부서{stats?.departmentCount ? `(부서 ${stats.departmentCount}곳)` : ''}의 현황입니다. 기관 직속 부서의 관리자는 기관 전체를 봅니다.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="p-6 border rounded-lg bg-white">
          <h3 className="text-lg font-medium text-slate-900">문서</h3>
          <p className="text-3xl font-bold text-slate-700 mt-2">{(stats?.totalDocuments ?? 0).toLocaleString()}</p>
          <p className="text-sm text-slate-500 mt-1">올린 문서 수(지난 판 제외)</p>
        </div>

        <div className="p-6 border rounded-lg bg-white">
          <h3 className="text-lg font-medium text-slate-900">AI 비서</h3>
          <p className="text-3xl font-bold text-slate-700 mt-2">{(stats?.totalAgents ?? 0).toLocaleString()}</p>
          <p className="text-sm text-slate-500 mt-1">공식·부서 비서 수(나만의 비서·지운 비서 제외)</p>
        </div>

        <div className="p-6 border rounded-lg bg-white">
          <h3 className="text-lg font-medium text-slate-900">활성 사용자</h3>
          <p className="text-3xl font-bold text-slate-700 mt-2">{(stats?.totalUsers ?? 0).toLocaleString()}</p>
          <p className="text-sm text-slate-500 mt-1">사용 중인 계정 수(사용 중지·탈퇴 제외)</p>
        </div>

        <div className="p-6 border rounded-lg bg-white">
          <h3 className="text-lg font-medium text-slate-900">대화 세션</h3>
          <p className="text-3xl font-bold text-slate-700 mt-2">{(stats?.totalConversations ?? 0).toLocaleString()}</p>
          <p className="text-sm text-slate-500 mt-1">진행된 대화 수</p>
        </div>

        <div className="p-6 border rounded-lg bg-white">
          <h3 className="text-lg font-medium text-slate-900">메시지</h3>
          <p className="text-3xl font-bold text-slate-700 mt-2">{(stats?.totalMessages ?? 0).toLocaleString()}</p>
          <p className="text-sm text-slate-500 mt-1">전송된 메시지 수</p>
        </div>

        <div className="p-6 border rounded-lg bg-white">
          <h3 className="text-lg font-medium text-slate-900">이번 달 토큰</h3>
          <p className="text-3xl font-bold text-slate-700 mt-2">{(stats?.monthlyTokens ?? 0).toLocaleString()}</p>
          <p className="text-sm text-slate-500 mt-1">이번 달(한국 시간) AI 사용 토큰</p>
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