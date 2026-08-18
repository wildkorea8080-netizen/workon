'use client';

import { useState, useEffect, useCallback } from 'react';
import type { Agent } from '@/lib/db';

type Tab = 'official' | 'pending' | 'rejected';

interface AgentWithOwner extends Agent {
  owner?: { id: string; email: string; full_name?: string | null } | null;
}

type Visibility = 'organization' | 'department';

type AgentFormData = {
  name: string;
  description: string;
  system_prompt: string;
  enabled_connectors: string[];
  visibility: Visibility;
};

type ConnectorInfo = { id: string; label: string; toolNames: string[] };

export default function AgentsManager() {
  const [activeTab, setActiveTab] = useState<Tab>('official');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [pendingAgents, setPendingAgents] = useState<AgentWithOwner[]>([]);
  const [rejectedAgents, setRejectedAgents] = useState<AgentWithOwner[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 공식 비서 탭 상태
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [formData, setFormData] = useState<AgentFormData>({ name: '', description: '', system_prompt: '', enabled_connectors: [], visibility: 'organization' });
  const [editFormData, setEditFormData] = useState<AgentFormData>({ name: '', description: '', system_prompt: '', enabled_connectors: [], visibility: 'organization' });
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // 승인/반려 모달 상태
  const [approveModal, setApproveModal] = useState<AgentWithOwner | null>(null);
  const [rejectModal, setRejectModal] = useState<AgentWithOwner | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [approveScope, setApproveScope] = useState<'department' | 'all'>('department');
  const [actionSubmitting, setActionSubmitting] = useState(false);

  // 프롬프트 미리보기 접이식
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const loadConnectors = useCallback(async () => {
    const res = await fetch('/api/connectors');
    const result = await res.json();
    if (result.ok) setConnectors(result.data ?? []);
  }, []);

  const loadOfficialAgents = useCallback(async () => {
    const res = await fetch('/api/agents');
    const result = await res.json();
    if (result.ok) setAgents(result.data ?? []);
  }, []);

  const loadPendingAgents = useCallback(async () => {
    const res = await fetch('/api/admin/agents/approvals?status=pending');
    const result = await res.json();
    if (result.ok) {
      setPendingAgents(result.data ?? []);
      setPendingCount(result.data?.length ?? 0);
    }
  }, []);

  const loadRejectedAgents = useCallback(async () => {
    const res = await fetch('/api/admin/agents/approvals?status=rejected');
    const result = await res.json();
    if (result.ok) setRejectedAgents(result.data ?? []);
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadOfficialAgents(), loadPendingAgents(), loadConnectors()])
      .catch(() => setError('데이터를 불러오지 못했습니다.'))
      .finally(() => setLoading(false));
  }, [loadOfficialAgents, loadPendingAgents, loadConnectors]);

  useEffect(() => {
    if (activeTab === 'rejected' && rejectedAgents.length === 0) {
      loadRejectedAgents();
    }
  }, [activeTab, rejectedAgents.length, loadRejectedAgents]);

  // ── 공식 비서 CRUD ──────────────────────────────────────────
  const handleCreateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      setAgents(prev => [result.data, ...prev]);
      setFormData({ name: '', description: '', system_prompt: '', enabled_connectors: [], visibility: 'organization' });
      setShowCreateForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '알 수 없는 오류');
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingAgent) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${editingAgent.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editFormData),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      setAgents(prev => prev.map(a => a.id === editingAgent.id ? result.data : a));
      setEditingAgent(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '알 수 없는 오류');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteAgent = async (agent: Agent) => {
    if (!confirm(`"${agent.name}" 을(를) 삭제하시겠습니까?`)) return;
    setDeletingId(agent.id);
    try {
      const res = await fetch(`/api/agents/${agent.id}`, { method: 'DELETE' });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      setAgents(prev => prev.filter(a => a.id !== agent.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : '삭제 실패');
    } finally {
      setDeletingId(null);
    }
  };

  const handleToggleActive = async (agent: Agent) => {
    const res = await fetch(`/api/agents/${agent.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !agent.is_active }),
    });
    const result = await res.json();
    if (result.ok) setAgents(prev => prev.map(a => a.id === agent.id ? result.data : a));
  };

  // ── 승인/반려 ────────────────────────────────────────────────
  const handleApprove = async () => {
    if (!approveModal) return;
    setActionSubmitting(true);
    try {
      const res = await fetch(`/api/admin/agents/${approveModal.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: approveScope }),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      setPendingAgents(prev => prev.filter(a => a.id !== approveModal.id));
      setPendingCount(n => Math.max(0, n - 1));
      setAgents(prev => [result.data, ...prev]);
      setApproveModal(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : '승인 처리 실패');
    } finally {
      setActionSubmitting(false);
    }
  };

  const handleReject = async () => {
    if (!rejectModal || !rejectNote.trim()) return;
    setActionSubmitting(true);
    try {
      const res = await fetch(`/api/admin/agents/${rejectModal.id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: rejectNote.trim() }),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      setPendingAgents(prev => prev.filter(a => a.id !== rejectModal.id));
      setPendingCount(n => Math.max(0, n - 1));
      setRejectModal(null);
      setRejectNote('');
    } catch (err) {
      alert(err instanceof Error ? err.message : '반려 처리 실패');
    } finally {
      setActionSubmitting(false);
    }
  };

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  if (loading) return <div className="text-center py-12 text-slate-400 text-sm">로딩 중...</div>;

  return (
    <div className="space-y-5">
      {/* 탭 바 */}
      <div className="flex items-center gap-1 border-b border-slate-200 pb-0">
        {(
          [
            { key: 'official', label: '공식 비서' },
            { key: 'pending', label: `승인 대기`, count: pendingCount },
            { key: 'rejected', label: '반려됨' },
          ] as const
        ).map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors -mb-px ${
              activeTab === tab.key
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {tab.label}
            {'count' in tab && tab.count > 0 && (
              <span className="bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center">
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">{error}</div>
      )}

      {/* ── 공식 비서 탭 ── */}
      {activeTab === 'official' && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <p className="text-sm text-slate-500">{agents.length}개의 공식 비서</p>
            <button
              onClick={() => { setShowCreateForm(true); setEditingAgent(null); }}
              className="flex items-center gap-1.5 px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold rounded-xl transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
              </svg>
              새 비서 생성
            </button>
          </div>

          {showCreateForm && (
            <div className="p-5 border border-slate-200 rounded-xl bg-white">
              <h3 className="text-sm font-bold text-slate-800 mb-4">새 공식 비서 생성</h3>
              <form onSubmit={handleCreateAgent} className="space-y-3">
                <input type="text" required placeholder="비서 이름" value={formData.name}
                  onChange={e => setFormData(p => ({ ...p, name: e.target.value }))}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-400" />
                <input type="text" placeholder="한 줄 설명" value={formData.description}
                  onChange={e => setFormData(p => ({ ...p, description: e.target.value }))}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-400" />
                <textarea placeholder="시스템 프롬프트" rows={4} value={formData.system_prompt}
                  onChange={e => setFormData(p => ({ ...p, system_prompt: e.target.value }))}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-400 resize-none" />
                <div className="flex gap-2">
                  <button type="submit" disabled={submitting}
                    className="px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-xl disabled:bg-slate-300">
                    {submitting ? '생성 중...' : '생성'}
                  </button>
                  <button type="button" onClick={() => setShowCreateForm(false)}
                    className="px-4 py-2 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50">
                    취소
                  </button>
                </div>
              </form>
            </div>
          )}

          <div className="space-y-2">
            {agents.map(agent => (
              <div key={agent.id} className="bg-white border border-slate-100 rounded-xl overflow-hidden">
                {editingAgent?.id === agent.id ? (
                  <div className="p-5">
                    <form onSubmit={handleUpdateAgent} className="space-y-3">
                      <input type="text" required value={editFormData.name}
                        onChange={e => setEditFormData(p => ({ ...p, name: e.target.value }))}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-400" />
                      <input type="text" value={editFormData.description}
                        onChange={e => setEditFormData(p => ({ ...p, description: e.target.value }))}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-400" />
                      <textarea rows={5} value={editFormData.system_prompt}
                        onChange={e => setEditFormData(p => ({ ...p, system_prompt: e.target.value }))}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-400 resize-none" />

                      <div className="border border-slate-200 rounded-xl p-3 space-y-2">
                        <div>
                          <p className="text-xs font-semibold text-slate-700">공개 범위</p>
                          <p className="text-[11px] text-slate-500 mt-0.5">
                            규정·매뉴얼처럼 전 직원이 보는 자료는 기관 전체로 두세요.
                          </p>
                        </div>
                        {([
                          ['organization', '기관 전체', '이 기관의 모든 직원이 사용합니다'],
                          ['department', '내 부서로 제한', '내 부서와 하위 부서만 사용합니다 (인사·감사 등)'],
                        ] as [Visibility, string, string][]).map(([value, label, hint]) => (
                          <label key={value} className="flex items-start gap-2.5 cursor-pointer">
                            <input
                              type="radio"
                              name={`visibility-${agent.id}`}
                              checked={editFormData.visibility === value}
                              onChange={() => setEditFormData(p => ({ ...p, visibility: value }))}
                              className="mt-0.5 w-4 h-4 border-slate-300 text-[#003087] focus:ring-[#003087]"
                            />
                            <span className="min-w-0">
                              <span className="block text-xs font-medium text-slate-800">{label}</span>
                              <span className="block text-[11px] text-slate-400">{hint}</span>
                            </span>
                          </label>
                        ))}
                      </div>

                      {connectors.length > 0 && (
                        <div className="border border-slate-200 rounded-xl p-3 space-y-2">
                          <div>
                            <p className="text-xs font-semibold text-slate-700">외부 도구</p>
                            <p className="text-[11px] text-slate-500 mt-0.5">
                              켜면 이 비서가 필요할 때 해당 데이터를 직접 조회해 출처와 함께 답합니다.
                            </p>
                          </div>
                          {connectors.map(connector => {
                            const checked = editFormData.enabled_connectors.includes(connector.id);
                            return (
                              <label key={connector.id} className="flex items-start gap-2.5 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={e =>
                                    setEditFormData(p => ({
                                      ...p,
                                      enabled_connectors: e.target.checked
                                        ? [...p.enabled_connectors, connector.id]
                                        : p.enabled_connectors.filter(id => id !== connector.id),
                                    }))
                                  }
                                  className="mt-0.5 w-4 h-4 rounded border-slate-300 text-[#003087] focus:ring-[#003087]"
                                />
                                <span className="min-w-0">
                                  <span className="block text-xs font-medium text-slate-800">{connector.label}</span>
                                  <span className="block text-[11px] text-slate-400 font-mono">
                                    {connector.toolNames.join(', ')}
                                  </span>
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      )}

                      <div className="flex gap-2">
                        <button type="submit" disabled={submitting}
                          className="px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-xl disabled:bg-slate-300">
                          {submitting ? '저장 중...' : '저장'}
                        </button>
                        <button type="button" onClick={() => setEditingAgent(null)}
                          className="px-4 py-2 border border-slate-200 rounded-xl text-sm text-slate-600">취소</button>
                      </div>
                    </form>
                  </div>
                ) : (
                  <div className="flex items-center gap-4 p-4">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-slate-900">{agent.name}</p>
                      {agent.description && <p className="text-xs text-slate-500 mt-0.5">{agent.description}</p>}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button onClick={() => handleToggleActive(agent)}
                        className={`px-2.5 py-1 text-xs rounded-full font-medium transition-colors ${
                          agent.is_active ? 'bg-green-100 text-green-700 hover:bg-green-200' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                        }`}>
                        {agent.is_active ? '활성' : '비활성'}
                      </button>
                      <button onClick={() => { setEditingAgent(agent); setEditFormData({ name: agent.name, description: agent.description ?? '', system_prompt: agent.system_prompt ?? '', enabled_connectors: agent.enabled_connectors ?? [], visibility: ((agent as any).visibility ?? 'organization') as Visibility }); }}
                        className="px-3 py-1 text-xs border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-600">수정</button>
                      <button onClick={() => handleDeleteAgent(agent)} disabled={deletingId === agent.id}
                        className="px-3 py-1 text-xs border border-red-200 text-red-500 rounded-lg hover:bg-red-50 disabled:opacity-50">
                        {deletingId === agent.id ? '삭제 중' : '삭제'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {agents.length === 0 && (
              <div className="text-center py-10 text-slate-400 text-sm">등록된 공식 비서가 없습니다.</div>
            )}
          </div>
        </div>
      )}

      {/* ── 승인 대기 탭 ── */}
      {activeTab === 'pending' && (
        <div className="space-y-3">
          {pendingAgents.length === 0 ? (
            <div className="text-center py-10 text-slate-400 text-sm">승인 대기 중인 비서가 없습니다.</div>
          ) : (
            pendingAgents.map(agent => (
              <ApprovalCard
                key={agent.id}
                agent={agent}
                expanded={expandedIds.has(agent.id)}
                onToggleExpand={() => toggleExpand(agent.id)}
                onApprove={() => { setApproveModal(agent); setApproveScope('department'); }}
                onReject={() => { setRejectModal(agent); setRejectNote(''); }}
              />
            ))
          )}
        </div>
      )}

      {/* ── 반려됨 탭 ── */}
      {activeTab === 'rejected' && (
        <div className="space-y-3">
          {rejectedAgents.length === 0 ? (
            <div className="text-center py-10 text-slate-400 text-sm">반려된 비서가 없습니다.</div>
          ) : (
            rejectedAgents.map(agent => (
              <ApprovalCard
                key={agent.id}
                agent={agent}
                expanded={expandedIds.has(agent.id)}
                onToggleExpand={() => toggleExpand(agent.id)}
                rejected
              />
            ))
          )}
        </div>
      )}

      {/* ── 승인 모달 ── */}
      {approveModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <h3 className="text-base font-bold text-slate-900 mb-2">공식 비서 승인</h3>
            <p className="text-sm text-slate-500 mb-4">
              <span className="font-semibold text-slate-800">{approveModal.name}</span>을(를)
              공식 비서로 승인합니다.
            </p>
            <div className="mb-4">
              <label className="block text-xs font-medium text-slate-600 mb-2">공개 범위</label>
              <div className="flex gap-2">
                {(['department', 'all'] as const).map(s => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setApproveScope(s)}
                    className={`flex-1 py-2 rounded-xl text-xs font-semibold border-2 transition-colors ${
                      approveScope === s
                        ? 'border-brand-600 bg-brand-50 text-brand-700'
                        : 'border-slate-200 text-slate-500 hover:border-slate-300'
                    }`}
                  >
                    {s === 'department' ? '🏢 신청자 부서' : '🌐 전체'}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setApproveModal(null)}
                className="flex-1 py-2.5 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50">취소</button>
              <button onClick={handleApprove} disabled={actionSubmitting}
                className="flex-1 py-2.5 bg-green-600 hover:bg-green-700 disabled:bg-slate-300 text-white font-semibold rounded-xl text-sm">
                {actionSubmitting ? '처리 중...' : '✅ 승인'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 반려 모달 ── */}
      {rejectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <h3 className="text-base font-bold text-slate-900 mb-2">비서 등록 반려</h3>
            <p className="text-sm text-slate-500 mb-4">
              <span className="font-semibold text-slate-800">{rejectModal.name}</span>의 공식 등록 신청을 반려합니다.
            </p>
            <div className="mb-4">
              <label className="block text-xs font-medium text-slate-600 mb-1">반려 사유 <span className="text-red-400">*</span></label>
              <textarea
                value={rejectNote}
                onChange={e => setRejectNote(e.target.value)}
                placeholder="반려 사유를 입력하세요. 신청자에게 표시됩니다."
                rows={3}
                className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-400 resize-none"
              />
            </div>
            <div className="flex gap-2">
              <button onClick={() => setRejectModal(null)}
                className="flex-1 py-2.5 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50">취소</button>
              <button onClick={handleReject} disabled={actionSubmitting || !rejectNote.trim()}
                className="flex-1 py-2.5 bg-red-500 hover:bg-red-600 disabled:bg-slate-300 text-white font-semibold rounded-xl text-sm">
                {actionSubmitting ? '처리 중...' : '❌ 반려'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ApprovalCard({
  agent,
  expanded,
  onToggleExpand,
  onApprove,
  onReject,
  rejected = false,
}: {
  agent: AgentWithOwner;
  expanded: boolean;
  onToggleExpand: () => void;
  onApprove?: () => void;
  onReject?: () => void;
  rejected?: boolean;
}) {
  return (
    <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
      <div className="p-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-100 flex items-center justify-center text-brand-700 font-bold text-sm flex-shrink-0">
            {agent.icon ?? agent.name.slice(0, 1)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-semibold text-slate-900">{agent.name}</p>
              {rejected && agent.approval_note && (
                <span className="text-xs text-red-500 bg-red-50 px-2 py-0.5 rounded-full">반려: {agent.approval_note}</span>
              )}
            </div>
            {agent.description && <p className="text-xs text-slate-500 mt-0.5">{agent.description}</p>}
            <div className="flex items-center gap-3 mt-2 text-xs text-slate-400">
              <span>신청자: <span className="text-slate-600 font-medium">{agent.owner?.full_name || agent.owner?.email || '알 수 없음'}</span></span>
              <span>신청일: {new Date(agent.created_at).toLocaleDateString('ko-KR')}</span>
            </div>
          </div>
          {!rejected && (
            <div className="flex gap-2 flex-shrink-0">
              <button onClick={onApprove}
                className="px-3 py-1.5 bg-green-50 hover:bg-green-100 text-green-700 text-xs font-semibold rounded-lg border border-green-200 transition-colors">
                ✅ 승인
              </button>
              <button onClick={onReject}
                className="px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-600 text-xs font-semibold rounded-lg border border-red-200 transition-colors">
                ❌ 반려
              </button>
            </div>
          )}
        </div>

        {/* 프롬프트 미리보기 */}
        {agent.system_prompt && (
          <div className="mt-3">
            <button
              onClick={onToggleExpand}
              className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 transition-colors"
            >
              <svg className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              시스템 프롬프트 {expanded ? '접기' : '보기'}
            </button>
            {expanded && (
              <pre className="mt-2 p-3 bg-slate-50 rounded-lg text-xs text-slate-600 whitespace-pre-wrap font-sans border border-slate-100 max-h-40 overflow-y-auto">
                {agent.system_prompt}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
