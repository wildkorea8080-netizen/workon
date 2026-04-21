import { useState, useEffect } from 'react';
import type { Agent } from '@/lib/db';

interface AgentSelectorProps {
  selectedAgent: Agent | null;
  onAgentSelect: (agent: Agent | null) => void;
}

export default function AgentSelector({ selectedAgent, onAgentSelect }: AgentSelectorProps) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAgents();
  }, []);

  const fetchAgents = async () => {
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

  if (loading) {
    return (
      <div className="p-6 border-b border-slate-200 bg-slate-50">
        <div className="flex items-center justify-center">
          <div className="text-sm text-slate-600">에이전트 로딩 중...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 border-b border-slate-200 bg-red-50">
        <div className="text-sm text-red-600">{error}</div>
      </div>
    );
  }

  return (
    <div className="p-6 border-b border-slate-200 bg-gradient-to-r from-slate-50 to-white">
      <h2 className="text-lg font-semibold text-slate-900 mb-4">AI 비서 선택</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((agent) => (
          <div
            key={agent.id}
            onClick={() => onAgentSelect(selectedAgent?.id === agent.id ? null : agent)}
            className={`p-4 border rounded-lg cursor-pointer transition-all duration-200 hover:shadow-md ${
              selectedAgent?.id === agent.id
                ? 'border-slate-900 bg-slate-900 text-white shadow-md'
                : 'border-slate-300 bg-white hover:border-slate-400'
            }`}
          >
            <div className="flex items-start space-x-3">
              <div className={`w-3 h-3 rounded-full mt-1 ${
                selectedAgent?.id === agent.id ? 'bg-white' : 'bg-slate-900'
              }`} />
              <div className="flex-1">
                <h3 className={`font-medium text-sm ${
                  selectedAgent?.id === agent.id ? 'text-white' : 'text-slate-900'
                }`}>
                  {agent.name}
                </h3>
                {agent.description && (
                  <p className={`text-xs mt-1 line-clamp-2 ${
                    selectedAgent?.id === agent.id ? 'text-slate-200' : 'text-slate-600'
                  }`}>
                    {agent.description}
                  </p>
                )}
                {agent.system_prompt && (
                  <p className={`text-xs mt-2 italic ${
                    selectedAgent?.id === agent.id ? 'text-slate-300' : 'text-slate-500'
                  }`}>
                    "{agent.system_prompt.length > 50
                      ? `${agent.system_prompt.substring(0, 50)}...`
                      : agent.system_prompt}"
                  </p>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      {agents.length === 0 && (
        <div className="text-center py-8 text-slate-500">
          <div className="text-sm">등록된 에이전트가 없습니다.</div>
          <div className="text-xs mt-1">관리자에게 문의하세요.</div>
        </div>
      )}
    </div>
  );
}