'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CandidateStatus, CitingDocument, ReferenceRow, ReferenceSummary } from '@/lib/document-references';

interface ReferencesData {
  document: { id: string; name: string };
  truncated: boolean;
  candidatesTruncated: boolean;
  rows: ReferenceRow[];
  summary: ReferenceSummary;
  outgoingError?: string;
  citedBy: CitingDocument[];
  coverage: { indexed: number; total: number } | null;
}

interface IndexData {
  indexed: number;
  skipped: number;
  deferred: number;
  coverage: { indexed: number; total: number } | null;
}

export const REFERENCE_STATUS_LABEL: Record<CandidateStatus, string> = {
  current: '지금 판',
  retired: '지난 판',
  reading: '읽는 중',
  failed: '읽기 실패',
  unreadable: '못 읽음',
  unknown: '상태 모름',
};

/** 색인 만들기 한 번 누름에 서버를 부르는 최대 횟수(한 번에 다섯 개씩) */
export const INDEX_MAX_ROUNDS = 40;

/** 인용 한 줄의 판정 글 — 화면과 시험이 같이 본다 */
export function referenceVerdict(row: ReferenceRow): { tone: 'ok' | 'warn' | 'info' | 'none'; text: string } {
  if (row.retiredOnly) return { tone: 'warn', text: '맞는 문서가 지난 판뿐입니다 — 인용을 새 판 이름으로 고쳐야 하는지, 새 판을 올려야 하는지 확인하세요.' };
  if (row.matches.length) return { tone: 'ok', text: row.matches.some((m) => m.exact) ? '문서함에 있습니다.' : '이름이 비슷한 문서가 있습니다 — 같은 문서인지 확인하세요.' };
  if (row.lawLike) return { tone: 'info', text: '법령·자치법규로 보입니다 — 문서함이 아니라 법제처에서 확인하세요.' };
  return { tone: 'none', text: '문서함에 없습니다.' };
}

/** 색인 범위 안내 — 덜 됐으면 거꾸로 목록이 빠질 수 있다고 알린다 */
export function coverageNote(coverage: { indexed: number; total: number } | null): string | null {
  if (!coverage) return null;
  if (coverage.indexed >= coverage.total) return `문서 ${coverage.total}개 모두 색인했습니다.`;
  return `문서 ${coverage.total}개 중 ${coverage.indexed}개만 색인했습니다 — 나머지 문서가 이 문서를 인용해도 아래 목록에 나오지 않습니다.`;
}

/** 색인 만들기를 멈출 때인가 — 남은 것이 없거나, 이번에 새로 된 것이 없을 때(저장소가 잠깐 안 될 때 같은 자리를 되풀이하지 않게) */
export function indexDone(result: IndexData): boolean {
  if (result.coverage && result.coverage.indexed >= result.coverage.total) return true;
  return result.indexed + result.skipped === 0;
}

const TONE: Record<'ok' | 'warn' | 'info' | 'none', string> = {
  ok: 'text-emerald-700',
  warn: 'text-amber-700',
  info: 'text-slate-600',
  none: 'text-red-700',
};

/**
 * 문서 참조 관계(2026-11-08) — 이 문서가 「…」·『…』로 인용한 규정·지침이 문서함(기관 문서·공통 자료실)에 있는지, 지금 판인지.
 * (2026-11-09) 거꾸로 '이 문서를 인용하는 문서'를 참조 색인으로 보이고, 색인이 덜 된 문서는 '색인 만들기'로 채운다. 모델 없이 원본 글로 찾는다
 */
export default function DocumentReferencesModal({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  const [data, setData] = useState<ReferencesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [indexing, setIndexing] = useState<string | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(documentId)}/references`);
      const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: ReferencesData; error?: { message?: string } } | null;
      if (!res.ok || !body?.ok || !body.data) setError(body?.error?.message ?? '참조 문서를 찾지 못했습니다.');
      else { setError(null); setData(body.data); }
    } catch {
      setError('참조 문서를 찾지 못했습니다.');
    }
  }, [documentId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function buildIndex() {
    setIndexError(null);
    try {
      for (let round = 0; round < INDEX_MAX_ROUNDS; round += 1) {
        const res = await fetch('/api/documents/references/build', { method: 'POST' });
        const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: IndexData; error?: { message?: string } } | null;
        if (!res.ok || !body?.ok || !body.data) throw new Error(body?.error?.message ?? '참조 색인을 만들지 못했습니다.');
        const cov = body.data.coverage;
        setIndexing(cov ? `색인하는 중… ${cov.indexed} / ${cov.total}` : '색인하는 중…');
        if (indexDone(body.data)) break;
      }
      await load();
    } catch (e) {
      setIndexError(e instanceof Error ? e.message : '참조 색인을 만들지 못했습니다.');
    } finally {
      setIndexing(null);
    }
  }

  const note = data ? coverageNote(data.coverage) : null;
  const partial = data?.coverage ? data.coverage.indexed < data.coverage.total : false;

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
        <div className="overflow-y-auto px-6 py-4 space-y-4">
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          {!error && !data && <p className="text-sm text-slate-500">원본을 읽고 있습니다…</p>}
          {data && (
            <>
              <section aria-label="이 문서가 인용하는 문서" className="space-y-2">
                <h4 className="text-sm font-semibold text-slate-800">이 문서가 인용하는 문서</h4>
                {data.outgoingError ? (
                  <p className="text-xs text-amber-700">{data.outgoingError} — 이 문서의 인용은 찾지 못했습니다.</p>
                ) : (
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
              </section>

              <section aria-label="이 문서를 인용하는 문서" className="space-y-2 border-t pt-4">
                <h4 className="text-sm font-semibold text-slate-800">이 문서를 인용하는 문서</h4>
                <p className="text-xs text-slate-500">이 문서 이름을 「」·『』로 인용한 기관 문서입니다(이름이 같은 것만). 이 문서를 고치거나 새 판을 올리면 함께 볼 문서입니다.</p>
                {note && <p className={`text-xs ${partial ? 'text-amber-700' : 'text-slate-500'}`}>{note}</p>}
                {partial && (
                  <button type="button" disabled={Boolean(indexing)} onClick={() => void buildIndex()}
                    className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-700 disabled:opacity-50"
                    title="색인이 없는 문서의 원본을 읽어 인용한 이름을 남깁니다(AI 없음). 문서가 많으면 시간이 걸립니다.">
                    {indexing ?? '색인 만들기'}
                  </button>
                )}
                {indexError && <p role="alert" className="text-xs text-red-600">{indexError}</p>}
                {data.citedBy.length === 0 ? (
                  <p className="text-sm text-slate-500">이 문서를 인용하는 문서가 없습니다{partial ? '(색인한 문서 안에서)' : ''}.</p>
                ) : (
                  <ul className="space-y-0.5">
                    {data.citedBy.map((d) => (
                      <li key={d.id} className="text-sm text-slate-700">
                        {d.name}
                        {d.agentName ? <span className="text-xs text-slate-500"> · {d.agentName}</span> : null}
                        <span className="text-xs text-slate-500"> · {REFERENCE_STATUS_LABEL[d.status]}{d.effectiveFrom ? ` · 시행 ${d.effectiveFrom}` : ''}</span>
                        {d.similar ? <span className="text-xs text-amber-700"> · 이름 비슷 — 같은 문서를 가리키는지 확인</span> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
