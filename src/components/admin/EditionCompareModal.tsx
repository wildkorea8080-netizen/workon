'use client';

import { useEffect, useState } from 'react';
import { compareSummary, type CompareRow, type EditionComparison, type InlinePart } from '@/lib/edition-compare';

interface EditionSide {
  id: string;
  name: string;
  effective_from: string | null;
  status: string | null;
  created_at: string | null;
}

interface CompareData {
  old: EditionSide;
  new: EditionSide;
  warnings: string[];
  comparison: EditionComparison;
}

function sideLabel(s: EditionSide): string {
  const bits = [s.name];
  if (s.effective_from) bits.push(`시행 ${s.effective_from}`);
  if (s.status === 'retired') bits.push('지난 판');
  return bits.join(' · ');
}

function Parts({ parts, tone }: { parts: InlinePart[]; tone: 'old' | 'new' }) {
  return (
    <>
      {parts.map((p, i) =>
        p.changed ? (
          tone === 'old' ? (
            <del key={i} className="bg-red-100 text-red-900 decoration-red-500">{p.text}</del>
          ) : (
            <ins key={i} className="bg-green-100 text-green-900 no-underline font-medium">{p.text}</ins>
          )
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </>
  );
}

function Row({ row }: { row: CompareRow }) {
  if (row.kind === 'skip') {
    return (
      <tr>
        <td colSpan={3} className="px-3 py-1.5 text-center text-xs text-slate-400 bg-slate-50">
          ⋯ 같은 문단 {row.count.toLocaleString('ko-KR')}개 ⋯
        </td>
      </tr>
    );
  }
  const loc = <td className="px-3 py-2 align-top text-xs text-slate-500 whitespace-nowrap">{row.location ?? ''}</td>;
  const cell = 'px-3 py-2 align-top text-sm text-slate-800 whitespace-pre-wrap break-words w-1/2';
  switch (row.kind) {
    case 'same':
      return (
        <tr className="text-slate-500">
          {loc}
          <td className={`${cell} text-slate-500`}>{row.text}</td>
          <td className={`${cell} text-slate-500`}>{row.text}</td>
        </tr>
      );
    case 'changed':
      return (
        <tr>
          {loc}
          <td className={cell}><Parts parts={row.old} tone="old" /></td>
          <td className={cell}><Parts parts={row.new} tone="new" /></td>
        </tr>
      );
    case 'removed':
      return (
        <tr>
          {loc}
          <td className={`${cell} bg-red-50`}><del className="text-red-900 decoration-red-500">{row.old}</del></td>
          <td className={`${cell} text-xs text-slate-400`}>(삭제)</td>
        </tr>
      );
    case 'added':
      return (
        <tr>
          {loc}
          <td className={`${cell} text-xs text-slate-400`}>(신설)</td>
          <td className={`${cell} bg-green-50`}><ins className="text-green-900 no-underline font-medium">{row.new}</ins></td>
        </tr>
      );
  }
}

/**
 * 새 판과 그 판이 바꾼 옛 판의 신구 대비(문단 단위). 모델을 쓰지 않고 글자를 맞댄 결과라,
 * 표·그림 배치나 서식 차이는 보이지 않는다 — 머리에 그렇게 적는다.
 */
export default function EditionCompareModal({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  const [data, setData] = useState<CompareData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setData(null);
    setError('');
    (async () => {
      try {
        const res = await fetch(`/api/documents/${documentId}/compare`);
        const json = await res.json();
        if (!alive) return;
        if (json.ok) setData(json.data);
        else setError(json.error?.message ?? '두 판을 비교하지 못했습니다.');
      } catch {
        if (alive) setError('두 판을 비교하지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
      }
    })();
    return () => {
      alive = false;
    };
  }, [documentId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="두 판 비교"
        className="bg-white rounded-2xl shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-3 border-b border-slate-100">
          <div className="min-w-0">
            <h3 className="text-base font-bold text-slate-900">두 판 비교 (신구 대비)</h3>
            {data && (
              <p className="mt-1 text-sm text-slate-700">
                {data.comparison.identical ? '두 판의 글이 같습니다(띄어쓰기 차이는 보지 않습니다).' : compareSummary(data.comparison.stats)}
              </p>
            )}
            <p className="mt-1 text-xs text-slate-500">
              문서의 글을 문단 단위로 맞댄 결과입니다. 표 배치·서식·그림의 차이는 보이지 않으니 원본으로 확인하세요.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {data && !data.comparison.identical && (
              <a
                href={`/api/documents/${documentId}/compare?format=xlsx`}
                download
                className="px-3 py-1.5 text-xs font-medium bg-slate-900 text-white hover:bg-slate-800 rounded-md"
                title="바뀐 문단만 담은 신구대비표(엑셀)를 내려받습니다"
              >
                신구대비표 엑셀
              </a>
            )}
            <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700" aria-label="닫기">
              ✕
            </button>
          </div>
        </div>

        <div className="overflow-y-auto px-6 py-4 space-y-3">
          {!data && !error && <p className="text-sm text-slate-500">두 판을 읽어 맞대는 중입니다… 큰 문서는 1분쯤 걸릴 수 있습니다.</p>}
          {error && <p className="text-sm text-red-600">{error}</p>}
          {data && (
            <>
              {data.warnings.length > 0 && (
                <ul className="text-xs text-amber-800 bg-amber-50 rounded-lg px-3 py-2 space-y-0.5">
                  {data.warnings.map((w, i) => (
                    <li key={i}>⚠ {w}</li>
                  ))}
                </ul>
              )}
              {!data.comparison.identical && (
                <table className="w-full table-fixed border border-slate-200 rounded-lg overflow-hidden">
                  <colgroup>
                    <col className="w-28" />
                    <col />
                    <col />
                  </colgroup>
                  <thead className="bg-slate-50 text-left">
                    <tr>
                      <th className="px-3 py-2 text-xs font-semibold text-slate-600">위치</th>
                      <th className="px-3 py-2 text-xs font-semibold text-slate-600">옛 판 — {sideLabel(data.old)}</th>
                      <th className="px-3 py-2 text-xs font-semibold text-slate-600">새 판 — {sideLabel(data.new)}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.comparison.rows.map((row, i) => (
                      <Row key={i} row={row} />
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
