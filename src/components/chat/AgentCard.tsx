'use client';

import { useState } from 'react';
import type { Agent } from '@/lib/db';

const AVATAR_COLORS = [
  { bg: 'bg-indigo-500', light: 'bg-indigo-50', border: 'border-indigo-300', text: 'text-indigo-700' },
  { bg: 'bg-violet-500', light: 'bg-violet-50', border: 'border-violet-300', text: 'text-violet-700' },
  { bg: 'bg-blue-500',   light: 'bg-blue-50',   border: 'border-blue-300',   text: 'text-blue-700'   },
  { bg: 'bg-teal-500',   light: 'bg-teal-50',   border: 'border-teal-300',   text: 'text-teal-700'   },
  { bg: 'bg-emerald-500',light: 'bg-emerald-50', border: 'border-emerald-300',text: 'text-emerald-700'},
  { bg: 'bg-pink-500',   light: 'bg-pink-50',   border: 'border-pink-300',   text: 'text-pink-700'   },
];

export function pickColor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffff;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

interface AgentCardProps {
  agent: Agent;
  isFavorite: boolean;
  onFavoriteToggle: (agentId: string) => void;
  onSelect: (agent: Agent) => void;
  onApprovalRequested?: (agentId: string) => void;
}

export default function AgentCard({
  agent,
  isFavorite,
  onFavoriteToggle,
  onSelect,
  onApprovalRequested,
}: AgentCardProps) {
  const c = pickColor(agent.name);
  const [showApprovalModal, setShowApprovalModal] = useState(false);

  return (
    <>
      <div
        className={`group relative flex flex-col gap-3 p-4 bg-white border rounded-xl cursor-pointer transition-all duration-150 hover:shadow-md hover:border-brand-300 ${c.border}`}
        onClick={() => onSelect(agent)}
      >
        {/* 즐겨찾기 버튼 */}
        <button
          onClick={e => { e.stopPropagation(); onFavoriteToggle(agent.id); }}
          className="absolute top-3 right-3 p-1 rounded-lg hover:bg-slate-100 transition-colors"
          aria-label={isFavorite ? '즐겨찾기 해제' : '즐겨찾기 추가'}
        >
          {isFavorite ? (
            <svg className="w-4 h-4 text-amber-400" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
            </svg>
          ) : (
            <svg className="w-4 h-4 text-slate-300 group-hover:text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
            </svg>
          )}
        </button>

        {/* 아바타 */}
        <div className={`w-10 h-10 rounded-xl ${c.bg} flex items-center justify-center text-white text-base font-bold flex-shrink-0`}>
          {agent.icon ?? agent.name.slice(0, 1)}
        </div>

        {/* 이름 */}
        <div>
          <p className="text-sm font-semibold text-slate-900 leading-tight pr-6">{agent.name}</p>
          {agent.description && (
            <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">{agent.description}</p>
          )}
        </div>

        {/* 카테고리 뱃지 */}
        {agent.category && agent.category !== '전체' && (
          <span className={`self-start px-2 py-0.5 rounded-full text-xs font-medium ${c.light} ${c.text}`}>
            {agent.category}
          </span>
        )}

        {/* 내 비서 승인 상태 영역 */}
        {agent.is_personal && (
          <div onClick={e => e.stopPropagation()}>
            {!agent.approval_status && (
              <button
                onClick={() => setShowApprovalModal(true)}
                className="w-full mt-1 py-1.5 text-xs font-semibold text-brand-600 border border-brand-200 rounded-lg hover:bg-brand-50 transition-colors"
              >
                공식 등록 신청
              </button>
            )}
            {agent.approval_status === 'pending' && (
              <span className="flex items-center gap-1 text-xs text-amber-600 font-medium mt-1">
                ⏳ 승인 대기 중
              </span>
            )}
            {agent.approval_status === 'rejected' && (
              <div className="mt-1 group/reject relative">
                <span className="flex items-center gap-1 text-xs text-red-500 font-medium cursor-help">
                  ❌ 반려됨
                  {agent.approval_note && (
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  )}
                </span>
                {agent.approval_note && (
                  <div className="absolute left-0 bottom-full mb-1 w-48 bg-slate-800 text-white text-xs rounded-lg px-2.5 py-2 z-20 hidden group-hover/reject:block shadow-lg">
                    반려 사유: {agent.approval_note}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* 호버 CTA (승인 버튼 없을 때만) */}
        {!agent.is_personal && (
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-center py-2 opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-t from-white/90 to-transparent rounded-b-xl pointer-events-none">
            <span className="text-xs font-semibold text-brand-600">대화 시작 →</span>
          </div>
        )}
      </div>

      {/* 공식 등록 신청 모달 */}
      {showApprovalModal && (
        <RequestApprovalModal
          agent={agent}
          onClose={() => setShowApprovalModal(false)}
          onRequested={() => {
            setShowApprovalModal(false);
            onApprovalRequested?.(agent.id);
          }}
        />
      )}
    </>
  );
}

function RequestApprovalModal({
  agent,
  onClose,
  onRequested,
}: {
  agent: Agent;
  onClose: () => void;
  onRequested: () => void;
}) {
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/personal/${agent.id}/request-approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note }),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      onRequested();
    } catch (err) {
      setError(err instanceof Error ? err.message : '신청에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
        <h3 className="text-base font-bold text-slate-900 mb-2">공식 비서 등록 신청</h3>
        <p className="text-sm text-slate-500 mb-4">
          <span className="font-semibold text-slate-700">{agent.name}</span>을(를) 관리자에게 공식 등록 신청하시겠습니까?
          승인 시 부서 전체가 사용할 수 있는 공식 비서로 전환됩니다.
        </p>

        <div className="mb-4">
          <label className="block text-xs font-medium text-slate-600 mb-1">신청 사유 (선택)</label>
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="관리자에게 전달할 신청 사유를 입력하세요."
            rows={3}
            className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-400 resize-none"
          />
        </div>

        {error && (
          <p className="text-xs text-red-500 mb-3">{error}</p>
        )}

        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50"
          >
            취소
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="flex-1 py-2.5 bg-brand-600 hover:bg-brand-700 disabled:bg-slate-300 text-white font-semibold rounded-xl text-sm transition-colors"
          >
            {submitting ? '신청 중...' : '신청하기'}
          </button>
        </div>
      </div>
    </div>
  );
}
