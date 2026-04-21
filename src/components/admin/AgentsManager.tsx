'use client';

import { useState, useEffect } from 'react';
import type { Agent } from '@/lib/db';

type AgentFormData = {
  name: string;
  description: string;
  system_prompt: string;
};

export default function AgentsManager() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [formData, setFormData] = useState<AgentFormData>({
    name: '',
    description: '',
    system_prompt: '',
  });
  const [editFormData, setEditFormData] = useState<AgentFormData>({
    name: '',
    description: '',
    system_prompt: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadAgents();
  }, []);

  const loadAgents = async () => {
    try {
      const response = await fetch('/api/agents');
      const result = await response.json();
      if (!result.ok) throw new Error(result.error?.message || '에이전트 목록을 불러올 수 없습니다.');
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
      if (!result.ok) throw new Error(result.error?.message || '에이전트 생성 실패');
      setAgents(prev => [...prev, result.data]);
      setFormData({ name: '', description: '', system_prompt: '' });
      setShowCreateForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '알 수 없는 오류');
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = (agent: Agent) => {
    setEditingAgent(agent);
    setEditFormData({
      name: agent.name,
      description: agent.description || '',
      system_prompt: agent.system_prompt || '',
    });
    setError(null);
  };

  const cancelEdit = () => {
    setEditingAgent(null);
    setError(null);
  };

  const handleUpdateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingAgent) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/agents/${editingAgent.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editFormData),
      });
      const result = await response.json();
      if (!result.ok) throw new Error(result.error?.message || '에이전트 수정 실패');
      setAgents(prev => prev.map(a => a.id === editingAgent.id ? result.data : a));
      setEditingAgent(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '알 수 없는 오류');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteAgent = async (agent: Agent) => {
    if (!confirm(`"${agent.name}" 에이전트를 삭제하시겠습니까?`)) return;
    setDeletingId(agent.id);
    setError(null);
    try {
      const response = await fetch(`/api/agents/${agent.id}`, { method: 'DELETE' });
      const result = await response.json();
      if (!result.ok) throw new Error(result.error?.message || '에이전트 삭제 실패');
      setAgents(prev => prev.filter(a => a.id !== agent.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : '알 수 없는 오류');
    } finally {
      setDeletingId(null);
    }
  };

  const handleToggleActive = async (agent: Agent) => {
    try {
      const response = await fetch(`/api/agents/${agent.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !agent.is_active }),
      });
      const result = await response.json();
      if (!result.ok) throw new Error(result.error?.message || '상태 변경 실패');
      setAgents(prev => prev.map(a => a.id === agent.id ? result.data : a));
    } catch (err) {
      setError(err instanceof Error ? err.message : '알 수 없는 오류');
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
          onClick={() => { setShowCreateForm(true); setEditingAgent(null); }}
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
                className="px-4 py-2 border border-slate-300 rounded-md hover:bg-slate-100"
              >
                취소
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="grid gap-4">
        {agents.map((agent) => (
          <div key={agent.id} className="border rounded-lg bg-white overflow-hidden">
            {editingAgent?.id === agent.id ? (
              <div className="p-6">
                <h3 className="text-lg font-medium mb-4">에이전트 수정</h3>
                <form onSubmit={handleUpdateAgent} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700">이름</label>
                    <input
                      type="text"
                      required
                      value={editFormData.name}
                      onChange={(e) => setEditFormData(prev => ({ ...prev, name: e.target.value }))}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md mt-1"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700">설명</label>
                    <input
                      type="text"
                      value={editFormData.description}
                      onChange={(e) => setEditFormData(prev => ({ ...prev, description: e.target.value }))}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md mt-1"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700">시스템 프롬프트</label>
                    <textarea
                      value={editFormData.system_prompt}
                      onChange={(e) => setEditFormData(prev => ({ ...prev, system_prompt: e.target.value }))}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md mt-1"
                      rows={5}
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={submitting}
                      className="px-4 py-2 bg-slate-900 text-white rounded-md hover:bg-slate-800 disabled:opacity-50"
                    >
                      {submitting ? '저장 중...' : '저장'}
                    </button>
                    <button
                      type="button"
                      onClick={cancelEdit}
                      className="px-4 py-2 border border-slate-300 rounded-md hover:bg-slate-100"
                    >
                      취소
                    </button>
                  </div>
                </form>
              </div>
            ) : (
              <div className="p-4">
                <div className="flex justify-between items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <h3 className="text-lg font-medium">{agent.name}</h3>
                    {agent.description && (
                      <p className="text-slate-600 mt-1 text-sm">{agent.description}</p>
                    )}
                    {agent.system_prompt && (
                      <p className="text-sm text-slate-500 mt-2">
                        프롬프트: {agent.system_prompt.length > 100
                          ? `${agent.system_prompt.slice(0, 100)}...`
                          : agent.system_prompt}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => handleToggleActive(agent)}
                      className={`px-2 py-1 text-xs rounded-full font-medium ${
                        agent.is_active
                          ? 'bg-green-100 text-green-700 hover:bg-green-200'
                          : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                      }`}
                    >
                      {agent.is_active ? '활성' : '비활성'}
                    </button>
                    <button
                      onClick={() => startEdit(agent)}
                      className="px-3 py-1 text-sm border border-slate-300 rounded-md hover:bg-slate-50"
                    >
                      수정
                    </button>
                    <button
                      onClick={() => handleDeleteAgent(agent)}
                      disabled={deletingId === agent.id}
                      className="px-3 py-1 text-sm border border-red-200 text-red-600 rounded-md hover:bg-red-50 disabled:opacity-50"
                    >
                      {deletingId === agent.id ? '삭제 중...' : '삭제'}
                    </button>
                  </div>
                </div>
              </div>
            )}
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
