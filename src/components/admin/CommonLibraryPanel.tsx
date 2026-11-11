'use client';

import { useEffect, useState } from 'react';
import { kstDay } from '@/lib/kst-time';
import type { AdminCommonLibrary } from '@/lib/common-library-admin';
import EditionCompareModal, { compareEndpoint } from '@/components/admin/EditionCompareModal';

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
              </div>
              <div className="flex flex-shrink-0 gap-2">
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
