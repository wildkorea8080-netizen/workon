'use client';

import { useState, useEffect } from 'react';
import type { Agent } from '@/lib/db';

export default function AgentsManager() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    system_prompt: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadAgents();
  }, []);

  const loadAgents = async () => {
    try {
      const response = await fetch('/api/agents');
      const result = await response.json();

      if (!result.ok) {
        throw new Error(result.error?.message || '에이전트 목록을 불러올 수 없습니다.');
      }

      setAgents(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '알 수 없는 오류');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      const result = await response.json();

      if (!result.ok) {
        throw new Error(result.error?.message || '에이전트 생성 실패');
      }

      setAgents(prev => [...prev, result.data]);
      setFormData({ name: '', description: '', system_prompt: '' });
      setShowCreateForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '알 수 없는 오류');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="text-center py-8">로딩 중...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold">에이전트 목록</h2>
        <button
          onClick={() => setShowCreateForm(true)}
          className="px-4 py-2 bg-slate-900 text-white rounded-md hover:bg-slate-800"
        >
          새 에이전트 생성
        </button>
      </div>

      {error && (
        <div className="p-4 text-red-700 bg-red-100 rounded-lg">{error}</div>
      )}

      {showCreateForm && (
        <div className="p-6 border rounded-lg bg-white">
          <h3 className="text-lg font-medium mb-4">새 에이전트 생성</h3>
          <form onSubmit={handleCreateAgent} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700">이름</label>
              <input
                type="text"
                required
                value={formData.name}
                onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                className="w-full px-3 py-2 border border-slate-300 rounded-md mt-1"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700">설명</label>
              <input
                type="text"
                value={formData.description}
                onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                className="w-full px-3 py-2 border border-slate-300 rounded-md mt-1"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700">시스템 프롬프트</label>
              <textarea
                value={formData.system_prompt}
                onChange={(e) => setFormData(prev => ({ ...prev, system_prompt: e.target.value }))}
                className="w-full px-3 py-2 border border-slate-300 rounded-md mt-1"
                rows={4}
              />
            </div>

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-2 bg-slate-900 text-white rounded-md hover:bg-slate-800 disabled:opacity-50"
              >
                {submitting ? '생성 중...' : '생성'}
              </button>
              <button
                type="button"
                onClick={() => setShowCreateForm(false)}
                className="px-4 py-2 border border-slate-300 rounded-md hover:bg-slate-400"
              >
                취소
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="grid gap-4">
        {agents.map((agent) => (
          <div key={agent.id} className="p-4 border rounded-lg bg-white">
            <div className="flex justify-between items-start">
              <div>
                <h3 className="text-lg font-medium">{agent.name}</h3>
                {agent.description && (
                  <p className="text-slate-600 mt-1">{agent.description}</p>
                )}
                {agent.system_prompt && (
                  <p className="text-sm text-slate-500 mt-2">
                    프롬프트: {agent.system_prompt.length > 100
                      ? `${agent.system_prompt.slice(0, 100)}...`
                      : agent.system_prompt}
                  </p>
                )}
              </div>
              <div className="text-sm text-slate-500">
                {agent.is_active ? '활성' : '비활성'}
              </div>
            </div>
          </div>
        ))}

        {agents.length === 0 && (
          <div className="text-center py-8 text-slate-500">
            생성된 에이전트가 없습니다.
          </div>
        )}
      </div>
    </div>
  );
}