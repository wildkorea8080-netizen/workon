'use client';

import { useState, useEffect, useCallback, Fragment } from 'react';

interface Breakdown {
  key: string;
  label: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
  costKrw: number;
}

interface SummaryRow {
  key: string;
  name: string;
  sub: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
  costKrw: number;
  /** 어떤 모델을 얼마나 썼는지 */
  models: Breakdown[];
  /** 어떤 종류의 활동인지 */
  actions: Breakdown[];
}

type Axis = 'agent' | 'user' | 'department';

const AXIS_LABEL: Record<Axis, string> = {
  agent: '비서별',
  user: '직원별',
  department: '부서별',
};

function defaultRange() {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 86400000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { from: fmt(from), to: fmt(to) };
}

/**
 * 이용통계 — 비서별 / 직원별 / 부서별.
 *
 * 기존 대시보드는 부서 단위 개수만 보여줬다. 감사·정보공개 대응에서
 * "어느 비서를 얼마나 썼는지", "누가 얼마나 썼는지"를 묻는데 그 단면이 없었다.
 */
export default function UsageSummary() {
  const initial = defaultRange();
  const [axis, setAxis] = useState<Axis>('agent');
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [rows, setRows] = useState<SummaryRow[]>([]);
  const [meta, setMeta] = useState<{ totalCount: number; totalCostKrw: number } | null>(null);
  const [loading, setLoading] = useState(false);
  // 펼쳐 둔 행. 마우스 올림(툴팁) 대신 눌러서 펴는 방식을 쓴다 —
  // 태블릿에는 호버가 없고, 툴팁 안의 표는 읽기도 옮겨 적기도 어렵다.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ by: axis, from, to });
      const res = await fetch(`/api/admin/usage-summary?${params}`);
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
  }, [axis, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  const handleExport = () => {
    const params = new URLSearchParams({ by: axis, from, to, format: 'csv' });
    window.location.href = `/api/admin/usage-summary?${params}`;
  };

  // 막대 길이 기준. 1위가 0이면 나누기에서 NaN이 된다.
  const maxCost = Math.max(1, ...rows.map((r) => r.costKrw));

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 p-4 bg-white border border-slate-100 rounded-xl">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">집계 기준</label>
          <div className="flex gap-1">
            {(Object.keys(AXIS_LABEL) as Axis[]).map((key) => (
              <button
                key={key}
                onClick={() => setAxis(key)}
                className={`px-3 py-2 text-sm rounded-xl border transition-colors ${
                  axis === key
                    ? 'border-[#003087] bg-blue-50 text-[#003087] font-semibold'
                    : 'border-slate-200 text-slate-500 hover:bg-slate-50'
                }`}
              >
                {AXIS_LABEL[key]}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">시작일</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="px-3 py-2 border border-slate-200 rounded-xl text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">종료일</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="px-3 py-2 border border-slate-200 rounded-xl text-sm" />
        </div>
        <button
          onClick={handleExport}
          disabled={loading || rows.length === 0}
          className="ml-auto px-4 py-2 bg-[#003087] hover:bg-[#002070] text-white text-sm font-semibold rounded-xl disabled:bg-slate-300"
        >
          CSV 내려받기
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">{error}</div>
      )}

      {meta && (
        <div className="flex flex-wrap gap-6 px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl text-sm">
          <span className="text-slate-600">
            총 <strong className="text-slate-900">{meta.totalCount.toLocaleString()}</strong>회
          </span>
          <span className="text-slate-600">
            사용액 <strong className="text-slate-900">{Math.round(meta.totalCostKrw).toLocaleString()}원</strong>
          </span>
          <span className="text-slate-400 text-xs self-center">기간은 한국 시간(KST) 기준입니다</span>
        </div>
      )}

      <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                {['', AXIS_LABEL[axis].replace('별', ''), '사용', '입력', '출력', '비용'].map((h, i) => (
                  <th key={i} className={`px-4 py-2.5 text-xs font-semibold text-slate-500 whitespace-nowrap ${i >= 2 ? 'text-right' : 'text-left'}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">불러오는 중...</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">해당 기간에 사용 내역이 없습니다.</td></tr>
              ) : (
                rows.map((row, i) => (
                  <Fragment key={row.key}>
                  <tr
                    className="hover:bg-slate-50 cursor-pointer"
                    onClick={() => setOpenKey(openKey === row.key ? null : row.key)}
                    title="눌러서 모델·활동별 내역 보기"
                  >
                    <td className="px-4 py-2.5 text-xs text-slate-400 w-8">
                      <span className="inline-block w-3 text-slate-300">
                        {openKey === row.key ? '▾' : '▸'}
                      </span>
                      {i + 1}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        {axis === 'agent' && row.sub && <span>{row.sub}</span>}
                        <div className="min-w-0">
                          <p className="text-slate-900 truncate">{row.name}</p>
                          {axis === 'user' && row.sub && (
                            <p className="text-[11px] text-slate-400 truncate">{row.sub}</p>
                          )}
                        </div>
                      </div>
                      {/* 비중을 눈으로 보게 한다. 숫자만 보면 상위 몇 개가 대부분인지 안 보인다. */}
                      <div className="mt-1 h-1 bg-slate-100 rounded-full overflow-hidden max-w-[220px]">
                        <div className="h-full bg-[#003087]/60 rounded-full"
                          style={{ width: `${(row.costKrw / maxCost) * 100}%` }} />
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right text-slate-700 whitespace-nowrap">{row.count.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right text-xs text-slate-500 whitespace-nowrap">{row.inputTokens.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right text-xs text-slate-500 whitespace-nowrap">{row.outputTokens.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right text-slate-900 font-medium whitespace-nowrap">
                      {Math.round(row.costKrw).toLocaleString()}원
                    </td>
                  </tr>

                  {/* 모델·활동별 내역.
                      합계만 보면 "이 부서가 비싸다"까지는 알아도 왜 비싼지를
                      모른다. Opus를 쓰는 것과 Haiku를 많이 쓰는 것은 대응이
                      다르다. 기록은 이미 usage_logs.details에 있었고 화면에
                      내지 않았을 뿐이다. */}
                  {openKey === row.key && (
                    <tr className="bg-slate-50/60">
                      <td />
                      <td colSpan={5} className="px-4 pb-3 pt-1">
                        <div className="grid gap-4 sm:grid-cols-2">
                          <BreakdownList
                            title="모델별"
                            items={row.models}
                            empty="토큰을 쓰지 않은 활동입니다."
                            showCost
                          />
                          <BreakdownList
                            title="활동별"
                            items={row.actions}
                            empty="내역이 없습니다."
                          />
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-slate-400">
        행을 누르면 모델·활동별 내역이 펼쳐집니다.
        비서별 집계에는 비서와의 대화만 포함됩니다. 문서 업로드·스캔 판독처럼 비서를 거치지 않는 활동은
        직원별·부서별에서 확인하세요.
      </p>
    </section>
  );
}

/** 한 행 안의 모델별·활동별 내역 */
function BreakdownList({
  title,
  items,
  empty,
  showCost = false,
}: {
  title: string;
  items: Breakdown[];
  empty: string;
  showCost?: boolean;
}) {
  return (
    <div>
      <p className="text-[11px] font-semibold text-slate-400 mb-1.5">{title}</p>
      {items.length === 0 ? (
        <p className="text-xs text-slate-400">{empty}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((it) => (
            <li key={it.key} className="flex items-baseline gap-2 text-xs">
              <span className="text-slate-700 flex-1 truncate">{it.label}</span>
              <span className="text-slate-400 whitespace-nowrap">{it.count.toLocaleString()}회</span>
              {showCost && (
                <>
                  <span className="text-slate-400 whitespace-nowrap">
                    {it.inputTokens.toLocaleString()} / {it.outputTokens.toLocaleString()}
                  </span>
                  <span className="text-slate-700 font-medium whitespace-nowrap w-20 text-right">
                    {Math.round(it.costKrw).toLocaleString()}원
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
