'use client';

import { useState, useEffect, useCallback } from 'react';

interface AuditRow {
  일시: string;
  구분: string;
  직원: string;
  이메일: string;
  부서: string;
  활동: string;
  상세: string;
  모델: string;
  입력토큰: number | '';
  출력토큰: number | '';
  '비용(원)': number | '';
}

interface Member {
  id: string;
  full_name?: string | null;
  email: string;
  department_name?: string | null;
}

type Kind = 'usage' | 'security';

/** 기본 조회 기간: 최근 30일 */
function defaultRange() {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 86400000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { from: fmt(from), to: fmt(to) };
}

export default function AuditLogsManager() {
  const initial = defaultRange();

  const [kind, setKind] = useState<Kind>('usage');
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [userId, setUserId] = useState('');
  const [page, setPage] = useState(1);
  // 질문 원문 열람(D1). 기본은 가려져 있고, 사유를 남겨야 열린다.
  const [reveal, setReveal] = useState(false);
  const [revealReason, setRevealReason] = useState('');

  const [rows, setRows] = useState<AuditRow[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [meta, setMeta] = useState<{ total: number; pageSize: number; totalCostKrw: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ kind, from, to, page: String(page) });
      if (userId) params.set('userId', userId);
      if (reveal) {
        params.set('reveal', 'true');
        params.set('reason', revealReason);
      }

      const res = await fetch(`/api/admin/audit-logs?${params}`);
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      setRows(result.data ?? []);
      setMeta(result.meta ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '조회에 실패했습니다.');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [kind, from, to, userId, page, reveal, revealReason]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    fetch('/api/users')
      .then((r) => r.json())
      .then((r) => {
        if (r.ok) setMembers(r.data ?? []);
      })
      .catch(() => {});
  }, []);

  const handleExport = () => {
    const params = new URLSearchParams({ kind, from, to, format: 'csv' });
    if (userId) params.set('userId', userId);
    if (reveal) {
      params.set('reveal', 'true');
      params.set('reason', revealReason);
    }
    // 브라우저가 Content-Disposition을 처리하도록 그대로 이동시킨다
    window.location.href = `/api/admin/audit-logs?${params}`;
  };

  const totalPages = meta ? Math.max(1, Math.ceil(meta.total / meta.pageSize)) : 1;

  return (
    <section className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">사용 내역 조회</h1>
        <p className="text-sm text-slate-500 mt-1">
          감사·정보공개 대응을 위한 기간별 사용 내역입니다. 조회 범위는 내 부서와 하위 부서입니다.
        </p>
      </div>

      {/* 조회 조건 */}
      <div className="flex flex-wrap items-end gap-3 p-4 bg-white border border-slate-100 rounded-xl">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">구분</label>
          <select
            value={kind}
            onChange={(e) => { setKind(e.target.value as Kind); setPage(1); }}
            className="px-3 py-2 border border-slate-200 rounded-xl text-sm bg-white"
          >
            <option value="usage">AI 사용 내역</option>
            <option value="security">보안 이벤트</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">시작일</label>
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }}
            className="px-3 py-2 border border-slate-200 rounded-xl text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">종료일</label>
          <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }}
            className="px-3 py-2 border border-slate-200 rounded-xl text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">직원</label>
          <select
            value={userId}
            onChange={(e) => { setUserId(e.target.value); setPage(1); }}
            className="px-3 py-2 border border-slate-200 rounded-xl text-sm bg-white max-w-[200px]"
          >
            <option value="">전체</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.full_name || m.email}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={handleExport}
          disabled={loading}
          className="ml-auto px-4 py-2 bg-[#003087] hover:bg-[#002070] text-white text-sm font-semibold rounded-xl disabled:bg-slate-300"
        >
          CSV 내려받기
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">{error}</div>
      )}

      {/* ── 질문 원문 열람 (D1) ──
          직원이 무엇을 물었는지는 감사에 필요할 수 있지만 상시로 열려 있으면
          근로자 감시가 된다. CSV는 정보공개 청구로 기관 밖에 나갈 수도 있다.
          기본은 가리고, 사유를 남기고 명시적으로 요청할 때만 연다. */}
      {kind === 'usage' && (
        <div className={`p-4 rounded-xl border ${reveal ? 'bg-amber-50 border-amber-200' : 'bg-slate-50 border-slate-200'}`}>
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={reveal}
              onChange={(e) => {
                setReveal(e.target.checked);
                if (!e.target.checked) setRevealReason('');
                setPage(1);
              }}
              className="mt-0.5 w-4 h-4 rounded border-slate-300 text-[#003087] focus:ring-[#003087]"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-slate-800">질문 원문 열람</span>
              <span className="block text-[11px] text-slate-500 mt-0.5">
                기본적으로 질문 내용은 앞부분만 표시됩니다. 감사·수사 협조 등으로 전문이 필요할 때만 사용하세요.
                <strong className="text-amber-700"> 열람 사실은 사유와 함께 보안 로그에 기록됩니다.</strong>
              </span>
            </span>
          </label>

          {reveal && (
            <input
              type="text"
              value={revealReason}
              onChange={(e) => setRevealReason(e.target.value)}
              placeholder="열람 사유 (예: 2026년 정기감사 자료 제출 요구)"
              className="mt-3 w-full px-3 py-2 border border-amber-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-400"
            />
          )}
        </div>
      )}

      {/* 요약 */}
      {meta && (
        <div className="flex flex-wrap gap-6 px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl text-sm">
          <span className="text-slate-600">
            총 <strong className="text-slate-900">{meta.total.toLocaleString()}</strong>건
          </span>
          {kind === 'usage' && (
            <span className="text-slate-600">
              이 페이지 사용액{' '}
              <strong className="text-slate-900">{Math.round(meta.totalCostKrw).toLocaleString()}원</strong>
            </span>
          )}
          <span className="text-slate-400 text-xs self-center">
            시간은 한국 시간(KST) 기준입니다
          </span>
          <span className="text-slate-400 text-xs self-center">
            {reveal ? '질문 원문 표시 중' : '질문 원문 비공개'}
          </span>
        </div>
      )}

      {/* 표 */}
      <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                {['일시', '직원', '부서', '활동', '상세', ...(kind === 'usage' ? ['모델', '비용'] : [])].map((h) => (
                  <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">불러오는 중...</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">해당 기간에 내역이 없습니다.</td></tr>
              ) : (
                rows.map((row, i) => (
                  <tr key={i} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 text-xs text-slate-500 whitespace-nowrap">{row.일시}</td>
                    <td className="px-4 py-2.5 text-slate-900 whitespace-nowrap">{row.직원}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-500 whitespace-nowrap">{row.부서}</td>
                    <td className="px-4 py-2.5 text-slate-700 whitespace-nowrap">{row.활동}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-500 max-w-[280px] truncate" title={row.상세}>
                      {row.상세}
                    </td>
                    {kind === 'usage' && (
                      <>
                        <td className="px-4 py-2.5 text-xs text-slate-400 whitespace-nowrap">{row.모델}</td>
                        <td className="px-4 py-2.5 text-xs text-slate-600 whitespace-nowrap">
                          {row['비용(원)'] !== '' ? `${Number(row['비용(원)']).toLocaleString()}원` : '-'}
                        </td>
                      </>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 페이지 이동 */}
      {meta && totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm text-slate-600 disabled:opacity-40"
          >
            이전
          </button>
          <span className="text-sm text-slate-500">{page} / {totalPages}</span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm text-slate-600 disabled:opacity-40"
          >
            다음
          </button>
        </div>
      )}

      <p className="text-xs text-slate-400">
        CSV는 Excel에서 바로 열립니다(UTF-8 BOM). 한 번에 최대 5만 건까지 내려받을 수 있으며,
        그보다 많으면 기간을 나눠 받으세요.
      </p>
    </section>
  );
}
