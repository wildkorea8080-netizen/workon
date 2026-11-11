'use client';

import { useEffect, useState } from 'react';
import { kstDay } from '@/lib/kst-time';
import type { AdminCommonLibrary } from '@/lib/common-library-admin';
import EditionCompareModal, { compareEndpoint } from '@/components/admin/EditionCompareModal';
import type { CitingDocument } from '@/lib/document-references';

type CitedState = { loading: true } | { error: string } | { citedBy: CitingDocument[]; coverage: { indexed: number; total: number } | null };

/** 인용하는 문서 칸의 안내 — 색인이 덜 됐으면 빠질 수 있음을 함께 */
export function citedByNote(count: number, coverage: { indexed: number; total: number } | null): string {
  const head = count ? `이 기준을 「」로 인용한 기관 문서 ${count}개` : '이 기준을 「」로 인용한 기관 문서를 찾지 못했습니다';
  if (!coverage || coverage.total === 0) return head;
  return coverage.indexed < coverage.total ? `${head} — 아직 색인하지 않은 문서 ${coverage.total - coverage.indexed}개는 빠져 있을 수 있습니다(5분마다 채워집니다).` : head;
}

/**
 * 관리자 문서 화면의 '공통 기준 문서'(2026-11-06) — 이 기관 유형에서 문서 찾기 비서가 기관 문서와 함께 근거로 쓰는
 * 정부 기준 문서(공통 자료실). 운영자가 관리하므로 읽기만 하고, 원본은 대화 근거 창과 같은 주소로 연다.
 */
function sizeLabel(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export default function CommonLibraryPanel() {
  const [data, setData] = useState<AdminCommonLibrary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [cited, setCited] = useState<Record<string, CitedState>>({});

  function toggleCited(id: string) {
    if (cited[id]) { setCited((c) => { const next = { ...c }; delete next[id]; return next; }); return; }
    setCited((c) => ({ ...c, [id]: { loading: true } }));
    fetch(`/api/admin/common-documents/${encodeURIComponent(id)}/cited-by`)
      .then((r) => r.json())
      .then((body) => setCited((c) => (c[id] ? { ...c, [id]: body?.ok ? { citedBy: body.data.citedBy, coverage: body.data.coverage } : { error: body?.error?.message ?? '불러오지 못했습니다.' } } : c)))
      .catch(() => setCited((c) => (c[id] ? { ...c, [id]: { error: '불러오지 못했습니다.' } } : c)));
  }

  useEffect(() => {
    let alive = true;
    fetch('/api/admin/common-documents')
      .then((r) => r.json())
      .then((body) => {
        if (!alive) return;
        if (body?.ok) setData(body.data as AdminCommonLibrary);
        else setError(body?.error?.message ?? '공통 기준 문서를 불러오지 못했습니다.');
      })
      .catch(() => alive && setError('공통 기준 문서를 불러오지 못했습니다.'));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section aria-labelledby="common-library-heading" className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 id="common-library-heading" className="text-lg font-semibold text-slate-900">공통 기준 문서</h2>
      <p className="mt-1 text-sm text-slate-500">
        {data?.orgType
          ? `이 기관 유형(${data.orgType})의 문서 찾기 비서가 기관 문서와 함께 근거로 쓰는 정부 기준 문서입니다. 답변에는 [공통]으로 표시됩니다.`
          : '기관 유형마다 정부 기준 문서를 함께 근거로 씁니다. 답변에는 [공통]으로 표시됩니다.'}{' '}
        운영자가 관리하므로 기관에서 올리거나 지울 수 없습니다.
      </p>

      {error && <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!data && !error && <p role="status" className="mt-3 text-sm text-slate-400">불러오는 중…</p>}

      {data && !data.orgType && (
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
          기관 유형이 정해지지 않아 공통 기준 문서가 없습니다. 필요하면 운영자에게 기관 유형을 정해 달라고 요청하세요.
        </p>
      )}

      {data?.orgType && data.documents.length === 0 && (
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">지금 근거로 쓰는 공통 기준 문서가 없습니다.</p>
      )}

      {data && data.documents.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100">
          {data.documents.map((d) => (
            <li key={d.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900">
                  {d.title} <span className="font-normal text-slate-500">({d.editionYear}년 판)</span>
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {d.fileName}
                  {d.sizeBytes != null && ` · ${sizeLabel(d.sizeBytes)}`} · 올린 날 {kstDay(d.createdAt)}
                </p>
                <p className="mt-0.5 text-xs text-slate-400">이용 조건: {d.usageTerms}</p>
                {cited[d.id] && (
                  <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600" aria-label={`${d.title}을 인용하는 문서`}>
                    {'loading' in cited[d.id] && <p role="status">찾는 중…</p>}
                    {'error' in cited[d.id] && <p role="alert" className="text-red-700">{(cited[d.id] as { error: string }).error}</p>}
                    {'citedBy' in cited[d.id] && (() => {
                      const s = cited[d.id] as { citedBy: CitingDocument[]; coverage: { indexed: number; total: number } | null };
                      return (
                        <>
                          <p>{citedByNote(s.citedBy.length, s.coverage)}</p>
                          {s.citedBy.length > 0 && (
                            <ul className="mt-1 list-disc pl-4">
                              {s.citedBy.map((c) => (
                                <li key={c.id}>
                                  {c.name}
                                  {c.agentName ? <span className="text-slate-400"> · {c.agentName}</span> : null}
                                  {c.status === 'retired' ? <span className="text-slate-400"> · 지난 판</span> : null}
                                  {c.similar ? <span className="text-amber-700"> · 이름 비슷 — 같은 기준인지 확인</span> : null}
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
              <div className="flex flex-shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => toggleCited(d.id)}
                  aria-expanded={Boolean(cited[d.id])}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-[#003087] hover:bg-slate-50"
                >
                  인용하는 문서
                </button>
                {d.hasPreviousEdition && (
                  <button
                    type="button"
                    onClick={() => setCompareId(d.id)}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-[#003087] hover:bg-slate-50"
                  >
                    옛 판과 비교
                  </button>
                )}
                <a
                  href={`/api/common-documents/${encodeURIComponent(d.id)}/original`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-[#003087] hover:bg-slate-50"
                >
                  원본 열기
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}

      {data && data.pendingCount > 0 && (
        <p className="mt-2 text-xs text-slate-400">그 밖에 운영자가 준비 중인 문서 {data.pendingCount}개는 아직 근거로 쓰지 않습니다.</p>
      )}
      {compareId && <EditionCompareModal endpoint={compareEndpoint('admin-common', compareId)} onClose={() => setCompareId(null)} />}
    </section>
  );
}
