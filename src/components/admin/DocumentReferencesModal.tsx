'use client';

import { useEffect, useState } from 'react';
import type { CandidateStatus, ReferenceRow, ReferenceSummary } from '@/lib/document-references';

interface ReferencesData {
  document: { id: string; name: string };
  truncated: boolean;
  candidatesTruncated: boolean;
  rows: ReferenceRow[];
  summary: ReferenceSummary;
}

export const REFERENCE_STATUS_LABEL: Record<CandidateStatus, string> = {
  current: '지금 판',
  retired: '지난 판',
  reading: '읽는 중',
  failed: '읽기 실패',
  unreadable: '못 읽음',
  unknown: '상태 모름',
};

/** 인용 한 줄의 판정 글 — 화면과 시험이 같이 본다 */
export function referenceVerdict(row: ReferenceRow): { tone: 'ok' | 'warn' | 'info' | 'none'; text: string } {
  if (row.retiredOnly) return { tone: 'warn', text: '맞는 문서가 지난 판뿐입니다 — 인용을 새 판 이름으로 고쳐야 하는지, 새 판을 올려야 하는지 확인하세요.' };
  if (row.matches.length) return { tone: 'ok', text: row.matches.some((m) => m.exact) ? '문서함에 있습니다.' : '이름이 비슷한 문서가 있습니다 — 같은 문서인지 확인하세요.' };
  if (row.lawLike) return { tone: 'info', text: '법령·자치법규로 보입니다 — 문서함이 아니라 법제처에서 확인하세요.' };
  return { tone: 'none', text: '문서함에 없습니다.' };
}

const TONE: Record<'ok' | 'warn' | 'info' | 'none', string> = {
  ok: 'text-emerald-700',
  warn: 'text-amber-700',
  info: 'text-slate-600',
  none: 'text-red-700',
};

/**
 * 문서 참조 관계(2026-11-08) — 이 문서가 「…」·『…』로 인용한 규정·지침이 문서함(기관 문서·공통 자료실)에 있는지, 지금 판인지.
 * 모델 없이 원본 글로 찾는다
 */
export default function DocumentReferencesModal({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  const [data, setData] = useState<ReferencesData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/documents/${encodeURIComponent(documentId)}/references`)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: ReferencesData; error?: { message?: string } } | null;
        if (!alive) return;
        if (!res.ok || !body?.ok || !body.data) setError(body?.error?.message ?? '참조 문서를 찾지 못했습니다.');
        else setData(body.data);
      })
      .catch(() => { if (alive) setError('참조 문서를 찾지 못했습니다.'); });
    return () => { alive = false; };
  }, [documentId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="참조 문서" className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b px-6 py-4">
          <div>
            <h3 className="text-base font-bold text-slate-900">참조 문서</h3>
            <p className="mt-0.5 text-xs text-slate-500">{data ? data.document.name : '문서를 읽는 중…'} — 「」·『』로 인용한 이름을 문서함(기관 문서·공통 자료실)에서 찾습니다. AI는 쓰지 않습니다.</p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700" aria-label="닫기">✕</button>
        </div>
        <div className="overflow-y-auto px-6 py-4 space-y-3">
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          {!error && !data && <p className="text-sm text-slate-500">원본을 읽고 있습니다…</p>}
          {data && (
            <>
              <p className="text-sm text-slate-700">
                인용 {data.summary.cited}개 · 문서함에 있음 {data.summary.matched}개 · 지난 판뿐 {data.summary.retiredOnly}개 · 법령으로 보임 {data.summary.lawLike}개 · 없음 {data.summary.unmatched}개
              </p>
              {(data.truncated || data.candidatesTruncated) && (
                <p className="text-xs text-amber-700">
                  {data.truncated ? '원본이 길어 앞부분만 읽었습니다. ' : ''}{data.candidatesTruncated ? '기관 문서가 많아 일부만 맞춰 봤습니다.' : ''}
                </p>
              )}
              {data.rows.length === 0 && <p className="text-sm text-slate-500">「」·『』로 인용한 이름이 없습니다.</p>}
              <ul className="space-y-2">
                {data.rows.map((row) => {
                  const verdict = referenceVerdict(row);
                  return (
                    <li key={row.name} className="rounded-lg border border-slate-200 px-3 py-2">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="font-medium text-slate-900">「{row.name}」</span>
                        {row.count > 1 && <span className="text-xs text-slate-500">{row.count}번</span>}
                        <span className={`text-xs ${TONE[verdict.tone]}`}>{verdict.text}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-slate-500 break-words">{row.context}</p>
                      {row.matches.length > 0 && (
                        <ul className="mt-1.5 space-y-0.5">
                          {row.matches.map((m) => (
                            <li key={`${m.kind}-${m.id}`} className="text-xs text-slate-700">
                              {m.kind === 'common' ? `[공통] ${m.name}${m.editionYear ? `(${m.editionYear})` : ''}` : m.name}
                              {m.agentName ? ` · ${m.agentName}` : ''}
                              {` · ${REFERENCE_STATUS_LABEL[m.status]}`}
                              {m.effectiveFrom ? ` · 시행 ${m.effectiveFrom}` : ''}
                              {!m.exact ? ' · 이름 비슷' : ''}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
