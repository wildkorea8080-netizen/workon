'use client';

import { useState, useEffect } from 'react';
import type { Agent } from '@/lib/db';

interface RAGTestProps {
  agents?: Agent[];
}

export default function RAGSearchTester({ agents: initialAgents }: RAGTestProps) {
  const [agents, setAgents] = useState<Agent[]>(initialAgents || []);
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loadingAgents, setLoadingAgents] = useState(!initialAgents);

  useEffect(() => {
    if (!initialAgents) {
      // 클라이언트에서 agents 로드
      fetch('/api/agents')
        .then((res) => res.json())
        .then((data) => {
          if (data.ok) {
            setAgents(data.data);
          }
        })
        .catch((err) => console.error('Failed to load agents:', err))
        .finally(() => setLoadingAgents(false));
    }
  }, [initialAgents]);

  const handleTestSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAgentId || !query.trim()) {
      setError('에이전트와 검색어를 입력해주세요.');
      return;
    }

    setLoading(true);
    setError('');
    setResults([]);

    try {
      // 실제로는 /api/chat 호출 시 반환되는 chunks를 테스트할 수 있는 API 필요
      // 임시로 테스트 엔드포인트 호출
      const response = await fetch('/api/rag-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: selectedAgentId,
          query: query,
        }),
      });

      const result = await response.json();

      if (!result.ok) {
        throw new Error(result.error?.message || '검색 실패');
      }

      setResults(result.data.chunks || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : '알 수 없는 오류');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6 bg-white border rounded-lg shadow-sm">
      <h3 className="text-lg font-semibold mb-4">🔍 RAG 검색 테스트</h3>
      <p className="text-sm text-slate-600 mb-4">
        업로드된 문서가 AI 검색에서 올바르게 검색되는지 테스트합니다.
      </p>

      <form onSubmit={handleTestSearch} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              에이전트 선택
            </label>
            <select
              value={selectedAgentId}
              onChange={(e) => setSelectedAgentId(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">선택하세요</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              검색어
            </label>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="예: 인사규정, 휴가 정책, ..."
              className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 transition-colors"
        >
          {loading ? '검색 중...' : '검색 테스트'}
        </button>
      </form>

      {error && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
          {error}
        </div>
      )}

      {results.length > 0 && (
        <div className="mt-6 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="font-semibold text-slate-900">
              검색 결과 ({results.length}개)
            </h4>
            <span className="text-xs text-slate-500">
              상위 {results.length}개 결과 표시
            </span>
          </div>

          {results.map((chunk, idx) => (
            <div
              key={idx}
              className="p-4 bg-slate-50 border border-slate-200 rounded-lg hover:bg-slate-100 transition-colors"
            >
              <div className="flex items-start justify-between mb-2">
                <div>
                  <div className="font-medium text-slate-900">
                    📄 {chunk.documentTitle || '문서'}
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    청크 #{chunk.chunkIndex || 0}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-semibold text-blue-600">
                    유사도: {((chunk.similarity || 0) * 100).toFixed(1)}%
                  </div>
                </div>
              </div>

              <div className="text-sm text-slate-700 bg-white p-3 rounded border border-slate-200 line-clamp-3">
                {chunk.text || '내용 없음'}
              </div>
            </div>
          ))}
        </div>
      )}

      {!error && results.length === 0 && !loading && (
        <div className="mt-6 p-4 bg-slate-50 border border-slate-200 rounded-md text-center text-slate-600 text-sm">
          검색을 실행하여 결과를 확인하세요
        </div>
      )}
    </div>
  );
}
