'use client';

import { useState, useEffect, useCallback } from 'react';
import type { Agent } from '@/lib/db';

type Tab = 'official' | 'pending' | 'rejected';

interface AgentWithOwner extends Agent {
  owner?: { id: string; email: string; full_name?: string | null } | null;
}

type Visibility = 'organization' | 'department';

type AgentType = 'chat' | 'link';

type AgentFormData = {
  name: string;
  description: string;
  system_prompt: string;
  enabled_connectors: string[];
  visibility: Visibility;
  icon: string;
  category: string;
  agent_type: AgentType;
  link_url: string;
  /** 직원에게 보여줄 사용 방법 (0025) */
  usage_guide: string;
  /** 예시 입력. 화면에서는 한 줄에 하나씩 적는다 (0025) */
  starter_prompts: string;
};

const EMPTY_FORM: AgentFormData = {
  name: '',
  description: '',
  system_prompt: '',
  enabled_connectors: [],
  visibility: 'organization',
  icon: '',
  category: '',
  usage_guide: '',
  starter_prompts: '',
  agent_type: 'chat',
  link_url: '',
};

type ConnectorInfo = { id: string; label: string; toolNames: string[] };
type CategoryInfo = { id: string; name: string; display_order: number; agent_count: number };

/** 비서 → 수정 폼 초기값 */
function toFormData(agent: Agent): AgentFormData {
  return {
    name: agent.name,
    description: agent.description ?? '',
    system_prompt: agent.system_prompt ?? '',
    usage_guide: agent.usage_guide ?? '',
    starter_prompts: (agent.starter_prompts ?? []).join('\n'),
    enabled_connectors: agent.enabled_connectors ?? [],
    visibility: (agent.visibility ?? 'organization') as Visibility,
    icon: agent.icon ?? '',
    category: agent.category ?? '',
    agent_type: (agent.agent_type ?? 'chat') as AgentType,
    link_url: agent.link_url ?? '',
  };
}

/** 서버로 보낼 형태로 정리. 링크형이 아니면 주소를 아예 빼서 제약과 어긋나지 않게 한다. */
function toRequestBody(form: AgentFormData) {
  const { link_url, category, icon, ...rest } = form;
  return {
    ...rest,
    icon: icon.trim() || null,
    category: category.trim() || null,
    link_url: form.agent_type === 'link' ? link_url.trim() : null,
  };
}

/**
 * 생성·수정 폼이 공유하는 입력 묶음.
 *
 * 두 폼에 같은 필드를 따로 쓰면 한쪽만 고치는 사고가 난다. 실제로 category와
 * icon은 직원용 폼에만 있고 관리자용에는 없어서, 관리자가 만든 비서만 아이콘
 * 없이 '전체' 카테고리로 쌓여 있었다. 공개 범위·커넥터도 수정 폼에만 있었다.
 *
 * `idPrefix`는 라디오 그룹 이름을 카드마다 분리하는 데 쓴다. 같은 name이
 * 여러 카드에 걸리면 한 카드를 고를 때 다른 카드 선택이 풀린다.
 */
function CatalogFields({
  form,
  categories,
  connectors,
  idPrefix,
  onChange,
}: {
  form: AgentFormData;
  categories: CategoryInfo[];
  connectors: ConnectorInfo[];
  idPrefix: string;
  onChange: (patch: Partial<AgentFormData>) => void;
}) {
  const input =
    'w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-400';
  const label = 'block text-xs font-medium text-slate-500 mb-1';

  return (
    <>
      <div className="grid grid-cols-[84px_1fr] gap-3">
        <div>
          <label className={label}>아이콘</label>
          <input
            type="text"
            placeholder="📄"
            maxLength={8}
            value={form.icon}
            onChange={e => onChange({ icon: e.target.value })}
            className={`${input} text-center text-lg`}
          />
        </div>
        <div>
          <label className={label}>카테고리</label>
          <select
            value={form.category}
            onChange={e => onChange({ category: e.target.value })}
            className={`${input} bg-white`}
          >
            <option value="">(미분류)</option>
            {categories.map(c => (
              <option key={c.id} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className={label}>비서 유형</label>
        <div className="flex gap-2">
          {(
            [
              { key: 'chat', text: '대화형', hint: 'AI가 답변합니다' },
              { key: 'link', text: '링크형', hint: '외부 시스템으로 연결합니다' },
            ] as const
          ).map(({ key, text, hint }) => (
            <button
              key={key}
              type="button"
              onClick={() => onChange({ agent_type: key })}
              className={`flex-1 px-3 py-2 rounded-xl border text-left transition-colors ${
                form.agent_type === key
                  ? 'border-[#003087] bg-blue-50 text-[#003087]'
                  : 'border-slate-200 text-slate-500 hover:bg-slate-50'
              }`}
            >
              <span className="block text-xs font-semibold">{text}</span>
              <span className="block text-[11px] opacity-70">{hint}</span>
            </button>
          ))}
        </div>
      </div>

      {form.agent_type === 'link' ? (
        <div>
          <label className={label}>연결할 주소</label>
          <input
            type="url"
            placeholder="https://gw.example.go.kr"
            value={form.link_url}
            onChange={e => onChange({ link_url: e.target.value })}
            className={input}
          />
          <p className="mt-1 text-[11px] text-slate-400">
            클릭하면 새 탭으로 열립니다. 그룹웨어·업무포털 등 기관이 이미 쓰는 시스템을 비서 목록에 함께 둘 수 있습니다.
          </p>
        </div>
      ) : (
        <>
          {/* 사용 방법 · 대화 시작 가이드 (0025)
              직원이 비서를 열었을 때 무엇을 넣어야 하는지 모르는 것이 도입
              단계에서 가장 자주 막히는 지점이다. 비서마다 필요한 입력이
              다르고(공문은 주요 내용, 회의록은 녹취 전문) 기관마다 표현이
              달라, 코드가 대신 지어내지 않고 관리자가 적게 한다. */}
          <div>
            <label className={label}>사용 방법 (선택)</label>
            <textarea
              rows={2}
              value={form.usage_guide}
              onChange={e => onChange({ usage_guide: e.target.value })}
              placeholder="예) 공문으로 만들 주요 내용을 알려주세요. 수신처와 시행일이 있으면 함께 적어주세요."
              className={`${input} resize-none`}
              maxLength={500}
            />
            <p className="mt-1 text-[11px] text-slate-400">
              직원이 이 비서를 열었을 때 대화 시작 화면에 표시됩니다.
            </p>
          </div>

          <div>
            <label className={label}>대화 시작 예시 (선택)</label>
            <textarea
              rows={3}
              value={form.starter_prompts}
              onChange={e => onChange({ starter_prompts: e.target.value })}
              placeholder={'한 줄에 하나씩, 최대 6개\n예) 교육 참가 안내 공문\n예) 자료 제출 요청 공문'}
              className={`${input} resize-none`}
            />
            <p className="mt-1 text-[11px] text-slate-400">
              직원이 눌러서 바로 시작할 수 있습니다. 빈 화면 앞에서 첫 문장을 못 쓰는 경우가 많습니다.
            </p>
          </div>

          <div className="border border-slate-200 rounded-xl p-3 space-y-2">
            <div>
              <p className="text-xs font-semibold text-slate-700">공개 범위</p>
              <p className="text-[11px] text-slate-500 mt-0.5">
                규정·매뉴얼처럼 전 직원이 보는 자료는 기관 전체로 두세요.
              </p>
            </div>
            {(
              [
                ['organization', '기관 전체', '이 기관의 모든 직원이 사용합니다'],
                ['department', '내 부서로 제한', '내 부서와 하위 부서만 사용합니다 (인사·감사 등)'],
              ] as [Visibility, string, string][]
            ).map(([value, text, hint]) => (
              <label key={value} className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="radio"
                  name={`visibility-${idPrefix}`}
                  checked={form.visibility === value}
                  onChange={() => onChange({ visibility: value })}
                  className="mt-0.5 w-4 h-4 border-slate-300 text-[#003087] focus:ring-[#003087]"
                />
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-slate-800">{text}</span>
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
              {connectors.map(connector => (
                <label key={connector.id} className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.enabled_connectors.includes(connector.id)}
                    onChange={e =>
                      onChange({
                        enabled_connectors: e.target.checked
                          ? [...form.enabled_connectors, connector.id]
                          : form.enabled_connectors.filter(id => id !== connector.id),
                      })
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
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

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
  const [formData, setFormData] = useState<AgentFormData>(EMPTY_FORM);
  const [editFormData, setEditFormData] = useState<AgentFormData>(EMPTY_FORM);
  const [categories, setCategories] = useState<CategoryInfo[]>([]);
  const [showCategoryPanel, setShowCategoryPanel] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [publishingId, setPublishingId] = useState<string | null>(null);
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
    // manage=true라야 '노출 대기중'까지 내려온다. 직원 화면은 이걸 안 붙인다.
    const res = await fetch('/api/agents?manage=true');
    const result = await res.json();
    if (result.ok) setAgents(result.data ?? []);
  }, []);

  const loadCategories = useCallback(async () => {
    const res = await fetch('/api/admin/agent-categories');
    const result = await res.json();
    if (result.ok) setCategories(result.data ?? []);
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
    Promise.all([loadOfficialAgents(), loadPendingAgents(), loadConnectors(), loadCategories()])
      .catch(() => setError('데이터를 불러오지 못했습니다.'))
      .finally(() => setLoading(false));
  }, [loadOfficialAgents, loadPendingAgents, loadConnectors, loadCategories]);

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
        body: JSON.stringify(toRequestBody(formData)),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      setAgents(prev => [result.data, ...prev]);
      setFormData(EMPTY_FORM);
      loadCategories();
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
        body: JSON.stringify(toRequestBody(editFormData)),
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

  /**
   * 노출 스위치.
   * 활성/비활성(is_active)과는 다른 축이다.
   *   is_active    : 비서를 쓸 수 있는가 (꺼지면 기존 대화도 못 씀)
   *   is_published : 직원 목록에 내보내는가 (꺼도 관리자는 테스트 가능)
   */
  const handleTogglePublish = async (agent: Agent) => {
    setPublishingId(agent.id);
    try {
      const res = await fetch(`/api/agents/${agent.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_published: !agent.is_published }),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      setAgents(prev => prev.map(a => a.id === agent.id ? result.data : a));
    } catch (err) {
      setError(err instanceof Error ? err.message : '노출 상태 변경 실패');
    } finally {
      setPublishingId(null);
    }
  };

  // ── 카테고리 ────────────────────────────────────────────────
  const handleAddCategory = async () => {
    const name = newCategoryName.trim();
    if (!name) return;
    try {
      const res = await fetch('/api/admin/agent-categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      setCategories(prev => [...prev, result.data]);
      setNewCategoryName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '카테고리 추가 실패');
    }
  };

  const handleRenameCategory = async (category: CategoryInfo) => {
    const name = prompt('새 카테고리 이름', category.name)?.trim();
    if (!name || name === category.name) return;
    try {
      const res = await fetch(`/api/admin/agent-categories/${category.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      await Promise.all([loadCategories(), loadOfficialAgents()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '이름 변경 실패');
    }
  };

  const handleDeleteCategory = async (category: CategoryInfo) => {
    const warning = category.agent_count > 0
      ? `"${category.name}" 카테고리를 삭제하면 소속 비서 ${category.agent_count}개가 미분류로 이동합니다. 비서 자체는 삭제되지 않습니다. 계속할까요?`
      : `"${category.name}" 카테고리를 삭제할까요?`;
    if (!confirm(warning)) return;
    try {
      const res = await fetch(`/api/admin/agent-categories/${category.id}`, { method: 'DELETE' });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      await Promise.all([loadCategories(), loadOfficialAgents()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '카테고리 삭제 실패');
    }
  };

  /** 순서 이동 — 드래그 없이 위/아래 버튼으로 처리한다(터치·키보드 모두 됨) */
  const handleMoveCategory = async (index: number, direction: -1 | 1) => {
    const next = index + direction;
    if (next < 0 || next >= categories.length) return;
    const reordered = [...categories];
    [reordered[index], reordered[next]] = [reordered[next], reordered[index]];
    setCategories(reordered);
    try {
      const res = await fetch('/api/admin/agent-categories', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: reordered.map(c => c.id) }),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : '순서 저장 실패');
      loadCategories();
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
          <div className="flex justify-between items-center gap-2 flex-wrap">
            <p className="text-sm text-slate-500">
              {agents.length}개의 공식 비서
              {agents.some(a => !a.is_published) && (
                <span className="ml-2 text-amber-600">
                  · 노출 대기중 {agents.filter(a => !a.is_published).length}개
                </span>
              )}
            </p>
            <div className="flex items-center gap-2">
            <button
              onClick={() => setShowCategoryPanel(v => !v)}
              className="px-3 py-2 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50"
            >
              카테고리 관리
            </button>
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
          </div>

          {/* ── 카테고리 관리 ──
              카테고리는 표시 분류일 뿐 권한이 아니다. 누가 볼 수 있는지는
              각 비서의 '공개 범위'가 정한다. 둘을 섞으면 "카테고리는 공개인데
              비서는 비공개" 같은 모순 상태를 매번 판단해야 한다. */}
          {showCategoryPanel && (
            <div className="p-5 border border-slate-200 rounded-xl bg-white space-y-3">
              <div>
                <h3 className="text-sm font-bold text-slate-800">카테고리 관리</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  직원 화면에서 비서가 묶여 보이는 순서입니다. 공개 범위(권한)와는 별개입니다.
                </p>
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  value={newCategoryName}
                  onChange={e => setNewCategoryName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddCategory(); } }}
                  placeholder="새 카테고리 (예: 인사·복무)"
                  maxLength={30}
                  className="flex-1 px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                />
                <button onClick={handleAddCategory} disabled={!newCategoryName.trim()}
                  className="px-4 py-2 bg-[#003087] hover:bg-[#002070] text-white text-sm font-semibold rounded-xl disabled:bg-slate-300">
                  추가
                </button>
              </div>

              {categories.length === 0 ? (
                <p className="text-xs text-slate-400 py-2">카테고리가 없습니다. 모든 비서가 한 목록에 나옵니다.</p>
              ) : (
                <ul className="divide-y divide-slate-100 border border-slate-100 rounded-xl overflow-hidden">
                  {categories.map((category, index) => (
                    <li key={category.id} className="flex items-center gap-2 px-3 py-2 bg-white">
                      <div className="flex flex-col">
                        <button onClick={() => handleMoveCategory(index, -1)} disabled={index === 0}
                          title="위로" className="px-1 text-slate-400 hover:text-slate-700 disabled:opacity-25 leading-none">▲</button>
                        <button onClick={() => handleMoveCategory(index, 1)} disabled={index === categories.length - 1}
                          title="아래로" className="px-1 text-slate-400 hover:text-slate-700 disabled:opacity-25 leading-none">▼</button>
                      </div>
                      <span className="flex-1 text-sm text-slate-800">{category.name}</span>
                      <span className="text-xs text-slate-400">비서 {category.agent_count}개</span>
                      <button onClick={() => handleRenameCategory(category)}
                        className="px-2.5 py-1 text-xs border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50">
                        이름 변경
                      </button>
                      <button onClick={() => handleDeleteCategory(category)}
                        className="px-2.5 py-1 text-xs border border-red-200 text-red-500 rounded-lg hover:bg-red-50">
                        삭제
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[11px] text-slate-400">
                카테고리를 삭제해도 비서는 지워지지 않고 미분류로 이동합니다.
              </p>
            </div>
          )}

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
                {formData.agent_type === 'chat' && (
                  <textarea placeholder="시스템 프롬프트" rows={4} value={formData.system_prompt}
                    onChange={e => setFormData(p => ({ ...p, system_prompt: e.target.value }))}
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-400 resize-none" />
                )}

                <CatalogFields form={formData} categories={categories} connectors={connectors}
                  idPrefix="new"
                  onChange={patch => setFormData(p => ({ ...p, ...patch }))} />

                <p className="text-[11px] text-slate-400">
                  새 비서는 <strong className="text-slate-500">노출 대기중</strong>으로 만들어집니다.
                  직접 확인한 뒤 [메인 노출]을 눌러야 직원에게 보입니다.
                </p>

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
                      {editFormData.agent_type === 'chat' && (
                        <textarea rows={5} value={editFormData.system_prompt}
                          onChange={e => setEditFormData(p => ({ ...p, system_prompt: e.target.value }))}
                          className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-400 resize-none" />
                      )}

                      <CatalogFields form={editFormData} categories={categories} connectors={connectors}
                        idPrefix={agent.id}
                        onChange={patch => setEditFormData(p => ({ ...p, ...patch }))} />

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
                    <span className="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-xl bg-slate-50 border border-slate-100 text-lg">
                      {agent.icon || (agent.agent_type === 'link' ? '🔗' : '🤖')}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-slate-900 flex items-center gap-1.5 flex-wrap">
                        {agent.name}
                        {agent.category && (
                          <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-slate-100 text-slate-500">
                            {agent.category}
                          </span>
                        )}
                        {agent.agent_type === 'link' && (
                          <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-violet-50 text-violet-600">
                            링크형
                          </span>
                        )}
                      </p>
                      {agent.description && <p className="text-xs text-slate-500 mt-0.5">{agent.description}</p>}
                      {agent.agent_type === 'link' && agent.link_url && (
                        <p className="text-[11px] text-slate-400 mt-0.5 truncate font-mono">{agent.link_url}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {/* 노출 스위치 — 활성/비활성과는 다른 축이다.
                          is_active는 '쓸 수 있는가', is_published는 '목록에 내보내는가' */}
                      <button onClick={() => handleTogglePublish(agent)} disabled={publishingId === agent.id}
                        title={agent.is_published ? '누르면 숨겨집니다' : '누르면 직원에게 보입니다'}
                        className={`px-2.5 py-1 text-xs rounded-full font-medium transition-colors disabled:opacity-50 ${
                          agent.is_published
                            ? 'bg-[#003087] text-white hover:bg-[#002070]'
                            : 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                        }`}>
                        {publishingId === agent.id ? '...' : agent.is_published ? '노출 중' : '노출 대기중'}
                      </button>
                      <button onClick={() => handleToggleActive(agent)}
                        className={`px-2.5 py-1 text-xs rounded-full font-medium transition-colors ${
                          agent.is_active ? 'bg-green-100 text-green-700 hover:bg-green-200' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                        }`}>
                        {agent.is_active ? '활성' : '비활성'}
                      </button>
                      <button onClick={() => { setEditingAgent(agent); setEditFormData(toFormData(agent)); }}
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
