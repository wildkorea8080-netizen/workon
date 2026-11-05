'use client';

import { useState } from 'react';

/** 신청 메모 상한 — 관리자 승인 화면에 그대로 보인다 */
export const APPROVAL_NOTE_MAX = 500;

/** 신청 상태 → 보일 글(순수) — 화면 시험이 같은 함수를 본다 */
export function approvalState(agent: { tier: string; approval_status?: string | null; approval_version?: number | null; approval_note?: string | null }): { kind: 'official' | 'pending' | 'rejected' | 'none'; text: string } {
  if (agent.tier === 'official') return { kind: 'official', text: '공식 앱입니다.' };
  if (agent.approval_status === 'pending') return { kind: 'pending', text: `공식 앱 신청 중입니다${typeof agent.approval_version === 'number' ? ` — 판 ${agent.approval_version}으로 신청함` : ''}. 관리자가 검토합니다.` };
  if (agent.approval_status === 'rejected') return { kind: 'rejected', text: `지난 신청이 반려됐습니다${agent.approval_note ? ` — ${agent.approval_note}` : ''}. 고친 뒤 다시 신청할 수 있습니다.` };
  return { kind: 'none', text: '' };
}

/**
 * 공식 앱 신청(2026-11-06) — 나만의·부서 입력형 앱을 기관 관리자에게 공식 앱으로 신청한다(공식 비서 신청과 같은 길 `/api/agents/personal/[id]/request-approval`).
 * 신청은 **지금 판** 기준이다 — 시험 판(저장만 하고 배포하지 않은 판)은 배포한 뒤 신청해야 관리자가 그 내용을 검토한다.
 * 권한은 서버가 다시 본다(고칠 수 있는 사람만)
 */
export default function AppApprovalPanel({ agent, hasDraft, onRequested }: {
  agent: { id: string; tier: string; version: number; approval_status?: string | null; approval_version?: number | null; approval_note?: string | null };
  hasDraft: boolean;
  onRequested: (version: number) => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = approvalState(agent);
  if (state.kind === 'official') return null;

  async function request() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/personal/${encodeURIComponent(agent.id)}/request-approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: note.trim() || undefined }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: { message?: string } } | null;
      if (!res.ok || !body?.ok) throw new Error(body?.error?.message ?? '신청하지 못했습니다.');
      setNote('');
      onRequested(agent.version);
    } catch (e) {
      setError(e instanceof Error ? e.message : '신청하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="공식 앱 신청" className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm">
      <h3 className="font-semibold">공식 앱 신청</h3>
      {state.text && <p className={`text-xs leading-5 ${state.kind === 'rejected' ? 'text-red-700' : 'text-slate-600'}`}>{state.text}</p>}
      {state.kind !== 'pending' && (
        <>
          <p className="text-xs leading-5 text-slate-500">기관 관리자가 승인하면 공식 앱이 되어 정한 범위의 직원 모두가 씁니다. 신청은 지금 판(판 {agent.version}) 기준입니다.</p>
          {hasDraft && <p role="alert" className="text-xs leading-5 text-amber-800">배포하지 않은 시험 판이 있습니다 — 관리자는 지금 판을 검토합니다. 시험 판 내용으로 신청하려면 먼저 배포하세요.</p>}
          <textarea aria-label="신청 메모" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm" rows={2} maxLength={APPROVAL_NOTE_MAX} placeholder="관리자에게 남길 말(선택) — 어떤 업무에 쓰는지" value={note} onChange={(e) => setNote(e.target.value)} />
          <button type="button" disabled={busy} onClick={() => void request()} className="rounded-xl border border-[#087581] px-4 py-2 text-sm font-semibold text-[#087581] disabled:opacity-40">{busy ? '신청 중…' : '공식 앱으로 신청'}</button>
        </>
      )}
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
    </section>
  );
}
