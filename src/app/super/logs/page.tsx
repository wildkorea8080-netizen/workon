'use client';

import { useState, useEffect, useCallback } from 'react';
import { isImeComposing } from '@/lib/ime';
import { SYSTEM_LOG_CATEGORIES, SYSTEM_LOG_LEVELS, parseLogLink, type LogLinkState, type LogTab } from '@/lib/super-log-links';
import { ADMIN_LOG_ACTIONS, type AdminLogRow } from '@/lib/super-admin-log-spec';
import { csvLine, CSV_BOM } from '@/lib/csv-cell';

type Tab = LogTab;

/** 기록을 못 읽었을 때(503) — 빈 목록과 가른다 */
function LoadError({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="p-3 bg-red-950/30 border border-red-700/40 rounded-xl text-sm text-red-300">{message}</div>;
}

const fmtDt = (s: string) => new Date(s).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'medium' });

const ACTION_BADGE: Record<string, string> = {
  login:         'bg-emerald-900/40 text-emerald-400',
  login_failed:  'bg-red-900/40 text-red-400',
  logout:        'bg-slate-700 text-slate-400',
  chat:          'bg-blue-900/40 text-blue-300',
  upload:        'bg-violet-900/40 text-violet-400',
  admin_action:  'bg-amber-900/40 text-amber-400',
};

const LEVEL_BADGE: Record<string, string> = {
  info:     'bg-slate-700 text-slate-300',
  warning:  'bg-amber-900/40 text-amber-400',
  error:    'bg-red-900/40 text-red-400',
  critical: 'bg-red-700 text-white',
};

const PERIOD_OPTS = [
  { key: 'today', label: '오늘' },
  { key: 'week',  label: '이번 주' },
  { key: 'month', label: '이번달' },
];

function exportCsv(rows: any[], filename: string) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  // 칸은 csvLine(2026-11-18) — 예전 JSON.stringify는 CSV 감싸기가 아니라(따옴표를 \" 로, 줄바꿈을 \n 글자로) 엑셀에서 칸이 깨졌고,
  // '='로 시작하는 브라우저 정보·IP 칸 등을 엑셀이 수식으로 실행했다
  const csv  = [csvLine(keys), ...rows.map(r => csvLine(keys.map(k => r[k] ?? '')))].join('\n');
  const blob = new Blob([CSV_BOM + csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════════════════════════
export default function LogsPage() {
  const [tab, setTab] = useState<Tab>('access');
  // 주소의 tab·level·category·period로 연다(2026-11-17 — 대시보드 '전체 보기'·알림 띠 링크). useSearchParams는 Suspense가 필요해 주소에서 직접 읽는다
  const [link, setLink] = useState<LogLinkState | null>(null);
  useEffect(() => {
    const parsed = parseLogLink(window.location.search);
    setLink(parsed);
    setTab(parsed.tab);
  }, []);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">로그 관리</h1>
        <p className="text-slate-400 text-sm mt-1">접속·시스템·대리접근·관리자 조작 이력</p>
      </div>
      <div className="flex gap-1 border-b border-slate-700/50">
        {([['access','접속 로그'],['system','시스템 로그'],['impersonation','대리 접근 로그'],['admin','관리자 조작']] as [Tab,string][]).map(([k,l]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2.5 text-sm font-semibold rounded-t-lg transition-colors border-b-2 ${
              tab === k ? 'border-[#7C3AED] text-[#A78BFA] bg-[#7C3AED]/10' : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}>{l}</button>
        ))}
      </div>
      {tab === 'access'        && <AccessLogsTab />}
      {tab === 'system'        && <SystemLogsTab key={link ? 'linked' : 'plain'} initial={link} />}
      {tab === 'impersonation' && <ImpersonationLogsTab />}
      {tab === 'admin'         && <AdminLogsTab />}
    </div>
  );
}

// ─── 접속 로그 ────────────────────────────────────────────
function AccessLogsTab() {
  const [rows, setRows]         = useState<any[]>([]);
  const [suspicious, setSuspicious] = useState<any[]>([]);
  const [orgs, setOrgs]         = useState<any[]>([]);
  const [loading, setLoading]   = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [meta, setMeta]         = useState({ total: 0 });
  const [period, setPeriod]     = useState('today');
  const [filterOrg, setFilterOrg]     = useState('');
  const [filterAction, setFilterAction] = useState('all');
  const [search, setSearch]     = useState('');
  const [page, setPage]         = useState(1);
  const LIMIT = 50;

  useEffect(() => { fetch('/api/super/organizations?limit=100').then(r => r.json()).then(d => { if (d.ok) setOrgs(d.data); }); }, []);

  const load = useCallback(async (p = 1) => {
    setLoading(true);
    const params = new URLSearchParams({ period, page: String(p), limit: String(LIMIT) });
    if (filterOrg)            params.set('orgId', filterOrg);
    if (filterAction !== 'all') params.set('action', filterAction);
    if (search)               params.set('search', search);
    const res  = await fetch(`/api/super/logs/access?${params}`);
    const data = await res.json();
    if (data.ok) { setRows(data.data); setMeta(data.meta); setSuspicious(data.suspiciousIps ?? []); setLoadError(null); }
    else { setRows([]); setLoadError(data.error?.message ?? '접속 기록을 불러오지 못했습니다.'); }
    setLoading(false);
  }, [period, filterOrg, filterAction, search]);

  useEffect(() => { load(1); setPage(1); }, [load]);

  const totalPages = Math.ceil(meta.total / LIMIT);

  return (
    <div className="space-y-4">
      {/* 의심 IP 경고 */}
      {suspicious.map((s: any) => (
        <div key={s.ip} className="flex items-center gap-3 p-4 bg-amber-950/30 border border-amber-700/40 rounded-xl">
          <span className="text-lg">⚠️</span>
          <p className="text-sm text-amber-300">
            <span className="font-mono font-bold">{s.ip}</span>에서 로그인 시도 실패 <span className="font-bold">{s.count}회</span> 감지됐습니다.
          </p>
        </div>
      ))}

      {/* 필터 */}
      <div className="flex flex-wrap gap-3">
        <div className="flex gap-1">
          {PERIOD_OPTS.map(p => (
            <button key={p.key} onClick={() => setPeriod(p.key)}
              className={`px-3 py-2 text-xs font-semibold rounded-lg transition-colors ${period === p.key ? 'bg-[#7C3AED] text-white' : 'bg-[#1E293B] text-slate-400 border border-slate-700'}`}>
              {p.label}
            </button>
          ))}
        </div>
        <select value={filterOrg} onChange={e => setFilterOrg(e.target.value)}
          className="px-3 py-2 bg-[#1E293B] border border-slate-700 rounded-xl text-xs text-white focus:outline-none focus:border-[#7C3AED]">
          <option value="">기관 전체</option>
          {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <select value={filterAction} onChange={e => setFilterAction(e.target.value)}
          className="px-3 py-2 bg-[#1E293B] border border-slate-700 rounded-xl text-xs text-white focus:outline-none focus:border-[#7C3AED]">
          <option value="all">전체</option>
          {['login','login_failed','logout','chat','upload','admin_action'].map(a => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="이름/이메일/IP"
          className="px-3 py-2 bg-[#1E293B] border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-[#7C3AED]"
          onKeyDown={e => e.key === 'Enter' && !isImeComposing(e) && load(1)} />
        <button onClick={() => load(1)}
          className="px-4 py-2 bg-[#7C3AED] hover:bg-[#6D28D9] text-white text-xs font-semibold rounded-xl">조회</button>
        <button onClick={() => exportCsv(rows.map(r => ({
          시각: r.created_at, 사용자: r.users?.email, 기관: r.organizations?.name, 액션: r.action, IP: r.ip_address, 경로: r.path, 상태: r.status_code
        })), '접속로그.csv')}
          className="ml-auto px-4 py-2 bg-[#1E293B] border border-slate-700 hover:border-[#7C3AED] text-slate-300 text-xs font-semibold rounded-xl transition-colors">
          CSV
        </button>
      </div>

      <LoadError message={loadError} />

      {/* 테이블 */}
      <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-700/50">
            <tr>{['시각','사용자','기관','액션','IP','경로','상태'].map(h => (
              <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500">{h}</th>
            ))}</tr>
          </thead>
          <tbody className="divide-y divide-slate-700/30">
            {loading ? (
              Array.from({length:5}).map((_,i) => <tr key={i}>{Array.from({length:7}).map((_,j) => (
                <td key={j} className="px-4 py-3"><div className="h-3 bg-slate-700/50 rounded animate-pulse"/></td>
              ))}</tr>)
            ) : rows.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-500">로그가 없습니다.</td></tr>
            ) : rows.map(r => (
              <tr key={r.id} className="hover:bg-slate-700/20 transition-colors">
                <td className="px-4 py-3 text-slate-500 text-xs whitespace-nowrap">{fmtDt(r.created_at)}</td>
                <td className="px-4 py-3">
                  <p className="text-white text-xs">{r.users?.full_name || r.users?.email || '—'}</p>
                  {r.users?.email && r.users?.full_name && <p className="text-slate-500 text-[10px]">{r.users.email}</p>}
                </td>
                <td className="px-4 py-3 text-slate-400 text-xs">{r.organizations?.name ?? '—'}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${ACTION_BADGE[r.action] ?? 'bg-slate-700 text-slate-300'}`}>{r.action}</span>
                </td>
                <td className="px-4 py-3 text-slate-400 text-xs font-mono">{r.ip_address ?? '—'}</td>
                <td className="px-4 py-3 text-slate-500 text-xs truncate max-w-[120px]">{r.path ?? '—'}</td>
                <td className="px-4 py-3 text-xs">
                  <span className={r.status_code && r.status_code < 400 ? 'text-emerald-400' : 'text-red-400'}>
                    {r.status_code ?? '—'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-slate-500">총 {meta.total}건</p>
          <div className="flex items-center gap-2">
            <button onClick={() => { const p = page-1; setPage(p); load(p); }} disabled={page===1}
              className="px-4 py-2 bg-[#1E293B] border border-slate-700 rounded-xl text-sm text-slate-400 disabled:opacity-40">이전</button>
            <span className="text-sm text-slate-400">{page} / {totalPages}</span>
            <button onClick={() => { const p = page+1; setPage(p); load(p); }} disabled={page>=totalPages}
              className="px-4 py-2 bg-[#1E293B] border border-slate-700 rounded-xl text-sm text-slate-400 disabled:opacity-40">다음</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 시스템 로그 ──────────────────────────────────────────
function SystemLogsTab({ initial }: { initial?: LogLinkState | null }) {
  const [rows, setRows]       = useState<any[]>([]);
  const [summary, setSummary] = useState<any>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filterLevel, setFilterLevel]       = useState(initial?.level ?? 'all');
  const [filterCategory, setFilterCategory] = useState(initial?.category ?? 'all');
  const [period, setPeriod]   = useState(initial?.period ?? 'month');
  const [page, setPage]       = useState(1);
  const [detail, setDetail]   = useState<any>(null);
  const LIMIT = 50;

  const load = useCallback(async (p = 1) => {
    setLoading(true);
    const params = new URLSearchParams({ period, level: filterLevel, category: filterCategory, page: String(p), limit: String(LIMIT) });
    const res  = await fetch(`/api/super/logs/system?${params}`);
    const data = await res.json();
    if (data.ok) { setRows(data.data); setSummary(data.summary ?? {}); setLoadError(null); }
    else { setRows([]); setLoadError(data.error?.message ?? '시스템 기록을 불러오지 못했습니다.'); }
    setLoading(false);
  }, [period, filterLevel, filterCategory]);

  useEffect(() => { load(1); setPage(1); }, [load]);

  return (
    <div className="space-y-4">
      {/* 에러 요약 카드 */}
      <div className="grid grid-cols-3 gap-4">
        {[
          // 서버가 못 읽은 수(null)는 0으로 보이지 않게(2026-11-20)
          { label: '오늘 ERROR/CRITICAL', value: summary.todayErrors === null ? '읽지 못함' : summary.todayErrors ?? '—', icon: '🔴' },
          { label: '이번주 ERROR/CRITICAL', value: summary.weekErrors === null ? '읽지 못함' : summary.weekErrors ?? '—', icon: '⚠️' },
          { label: '전주 대비', value: summary.weekTrend !== null && summary.weekTrend !== undefined ? `${summary.weekTrend > 0 ? '▲' : '▼'}${Math.abs(summary.weekTrend)}%` : '—', icon: '📊' },
        ].map(c => (
          <div key={c.label} className="bg-[#1E293B] border border-slate-700/50 rounded-2xl p-4">
            <span className="text-xl">{c.icon}</span>
            <p className="text-xl font-bold text-white mt-2">{String(c.value)}</p>
            <p className="text-xs text-slate-500 mt-0.5">{c.label}</p>
          </div>
        ))}
      </div>

      {/* 필터 */}
      <div className="flex flex-wrap gap-3">
        <div className="flex gap-1">
          {PERIOD_OPTS.map(p => (
            <button key={p.key} onClick={() => setPeriod(p.key)}
              className={`px-3 py-2 text-xs font-semibold rounded-lg transition-colors ${period === p.key ? 'bg-[#7C3AED] text-white' : 'bg-[#1E293B] text-slate-400 border border-slate-700'}`}>
              {p.label}
            </button>
          ))}
        </div>
        <select value={filterLevel} onChange={e => setFilterLevel(e.target.value)}
          className="px-3 py-2 bg-[#1E293B] border border-slate-700 rounded-xl text-xs text-white focus:outline-none focus:border-[#7C3AED]">
          <option value="all">레벨 전체</option>
          {SYSTEM_LOG_LEVELS.map(l => <option key={l} value={l}>{l.toUpperCase()}</option>)}
        </select>
        <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)}
          className="px-3 py-2 bg-[#1E293B] border border-slate-700 rounded-xl text-xs text-white focus:outline-none focus:border-[#7C3AED]">
          <option value="all">카테고리 전체</option>
          {SYSTEM_LOG_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <button onClick={() => load(1)} className="px-4 py-2 bg-[#7C3AED] hover:bg-[#6D28D9] text-white text-xs font-semibold rounded-xl">조회</button>
      </div>

      <LoadError message={loadError} />

      {/* 테이블 */}
      <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-700/50">
            <tr>{['시각','레벨','카테고리','메시지','기관','상세'].map(h => (
              <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500">{h}</th>
            ))}</tr>
          </thead>
          <tbody className="divide-y divide-slate-700/30">
            {loading ? (
              Array.from({length:4}).map((_,i) => <tr key={i}>{Array.from({length:6}).map((_,j) => (
                <td key={j} className="px-4 py-3"><div className="h-3 bg-slate-700/50 rounded animate-pulse"/></td>
              ))}</tr>)
            ) : rows.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-500">로그가 없습니다.</td></tr>
            ) : rows.map(r => (
              <tr key={r.id} className="hover:bg-slate-700/20 transition-colors">
                <td className="px-4 py-3 text-slate-500 text-xs whitespace-nowrap">{fmtDt(r.created_at)}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${LEVEL_BADGE[r.level] ?? 'bg-slate-700 text-slate-300'} ${r.level === 'critical' ? 'animate-pulse' : ''}`}>
                    {r.level?.toUpperCase()}
                  </span>
                </td>
                <td className="px-4 py-3 text-slate-400 text-xs">{r.category}</td>
                <td className="px-4 py-3 text-slate-200 text-sm max-w-xs truncate">{r.message}</td>
                <td className="px-4 py-3 text-slate-500 text-xs">{r.organizations?.name ?? '—'}</td>
                <td className="px-4 py-3">
                  {Object.keys(r.details ?? {}).length > 0 && (
                    <button onClick={() => setDetail(r)}
                      className="px-2.5 py-1 bg-slate-700 hover:bg-slate-600 text-white text-xs rounded-lg transition-colors">보기</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 상세 패널 */}
      {detail && (
        <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50 px-4"
          onClick={() => setDetail(null)}>
          <div className="bg-[#1E293B] border border-slate-700 rounded-2xl p-6 w-full max-w-lg max-h-[80vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold text-white">로그 상세</h3>
              <button onClick={() => setDetail(null)} className="text-slate-400 hover:text-white">✕</button>
            </div>
            <p className="text-xs text-slate-400 mb-3">{fmtDt(detail.created_at)} · {detail.level?.toUpperCase()} · {detail.category}</p>
            <p className="text-sm text-white mb-4">{detail.message}</p>
            <pre className="bg-[#0F172A] rounded-xl p-4 text-xs text-slate-300 overflow-auto">
              {JSON.stringify(detail.details, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 대리 접근 로그 ───────────────────────────────────────
function ImpersonationLogsTab() {
  const [rows, setRows]       = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [meta, setMeta]       = useState({ total: 0 });
  const [page, setPage]       = useState(1);
  const LIMIT = 50;

  const load = useCallback(async (p = 1) => {
    setLoading(true);
    const res  = await fetch(`/api/super/logs/impersonation?page=${p}&limit=${LIMIT}`);
    const data = await res.json();
    if (data.ok) { setRows(data.data); setMeta(data.meta); setLoadError(null); }
    else { setRows([]); setLoadError(data.error?.message ?? '대리 접근 기록을 불러오지 못했습니다.'); }
    setLoading(false);
  }, []);

  useEffect(() => { load(1); }, [load]);

  function fmtDuration(sec: number | null) {
    if (sec === null) return null;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}분 ${s}초` : `${s}초`;
  }

  const totalPages = Math.ceil(meta.total / LIMIT);

  return (
    <div className="space-y-4">
      <div className="p-4 bg-blue-950/20 border border-blue-700/30 rounded-xl">
        <p className="text-sm text-slate-300">슈퍼관리자가 기관 관리자 화면에 대리 접근한 이력입니다.</p>
      </div>
      <LoadError message={loadError} />

      <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-700/50">
            <tr>{['접근 시각','슈퍼관리자','기관명','종료 시각','접근 시간','IP','상태'].map(h => (
              <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500">{h}</th>
            ))}</tr>
          </thead>
          <tbody className="divide-y divide-slate-700/30">
            {loading ? (
              Array.from({length:3}).map((_,i) => <tr key={i}>{Array.from({length:7}).map((_,j) => (
                <td key={j} className="px-4 py-3"><div className="h-3 bg-slate-700/50 rounded animate-pulse"/></td>
              ))}</tr>)
            ) : rows.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-500">대리 접근 이력이 없습니다.</td></tr>
            ) : rows.map(r => (
              <tr key={r.id} className="hover:bg-slate-700/20 transition-colors">
                <td className="px-4 py-3 text-slate-500 text-xs whitespace-nowrap">{fmtDt(r.accessedAt)}</td>
                <td className="px-4 py-3">
                  <p className="text-white text-xs">{r.superAdminName}</p>
                  <p className="text-slate-500 text-[10px]">{r.superAdminEmail}</p>
                </td>
                <td className="px-4 py-3 font-semibold text-white">{r.orgName}</td>
                <td className="px-4 py-3 text-slate-500 text-xs">{r.endedAt ? fmtDt(r.endedAt) : '—'}</td>
                <td className="px-4 py-3 text-slate-400 text-xs">{fmtDuration(r.durationSec) ?? '—'}</td>
                <td className="px-4 py-3 text-slate-500 text-xs font-mono">{r.ipAddress ?? '—'}</td>
                <td className="px-4 py-3">
                  {r.isActive ? (
                    <span className="px-2 py-0.5 bg-emerald-900/40 text-emerald-400 text-xs rounded-full font-semibold">진행 중</span>
                  ) : (
                    <span className="px-2 py-0.5 bg-slate-700 text-slate-400 text-xs rounded-full">종료</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-slate-500">총 {meta.total}건</p>
          <div className="flex items-center gap-2">
            <button onClick={() => { const p = page-1; setPage(p); load(p); }} disabled={page===1}
              className="px-4 py-2 bg-[#1E293B] border border-slate-700 rounded-xl text-sm text-slate-400 disabled:opacity-40">이전</button>
            <span className="text-sm text-slate-400">{page} / {totalPages}</span>
            <button onClick={() => { const p = page+1; setPage(p); load(p); }} disabled={page>=totalPages}
              className="px-4 py-2 bg-[#1E293B] border border-slate-700 rounded-xl text-sm text-slate-400 disabled:opacity-40">다음</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 관리자 조작 기록(2026-11-17) ─────────────────────────
// super_admin_logs — 기관 등록·정지·계정 사용 중지·권한·삭제·비밀번호 재발급·잠금 풀기·설정 변경 등. 예전엔 쓰기만 하고 읽는 곳이 없었다
function AdminLogsTab() {
  const [rows, setRows]       = useState<AdminLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [meta, setMeta]       = useState({ total: 0 });
  const [page, setPage]       = useState(1);
  const [action, setAction]   = useState('all');
  const LIMIT = 50;

  const load = useCallback(async (p = 1, a = 'all') => {
    setLoading(true);
    const qs = new URLSearchParams({ page: String(p), limit: String(LIMIT) });
    if (a !== 'all') qs.set('action', a);
    try {
      const res  = await fetch(`/api/super/logs/admin?${qs}`);
      const data = await res.json();
      if (data.ok) { setRows(data.data); setMeta(data.meta); setLoadError(null); }
      else { setRows([]); setLoadError(data.error?.message ?? '조작 기록을 불러오지 못했습니다.'); }
    } catch {
      setRows([]); setLoadError('조작 기록을 불러오지 못했습니다.');
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(1, 'all'); }, [load]);

  const totalPages = Math.ceil(meta.total / LIMIT);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select value={action} onChange={e => { setAction(e.target.value); setPage(1); load(1, e.target.value); }}
          className="px-3 py-2 bg-[#1E293B] border border-slate-700 rounded-xl text-sm text-slate-300">
          <option value="all">작업 전체</option>
          {Object.entries(ADMIN_LOG_ACTIONS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <button onClick={() => exportCsv(rows.map(r => ({ 일시: fmtDt(r.createdAt), 작업: r.actionLabel, 대상: `${r.targetLabel}${r.targetName ? ` ${r.targetName}` : ''}`, 내용: r.summary, 슈퍼관리자: r.adminEmail })), 'super_admin_logs.csv')}
          disabled={rows.length === 0}
          className="px-4 py-2 bg-[#1E293B] border border-slate-700 rounded-xl text-sm text-slate-400 disabled:opacity-40">이 쪽 CSV</button>
      </div>

      <LoadError message={loadError} />

      <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-700/50">
            <tr>{['일시','작업','대상','내용','슈퍼관리자'].map(h => (
              <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500">{h}</th>
            ))}</tr>
          </thead>
          <tbody className="divide-y divide-slate-700/30">
            {loading ? (
              Array.from({length:3}).map((_,i) => <tr key={i}>{Array.from({length:5}).map((_,j) => (
                <td key={j} className="px-4 py-3"><div className="h-3 bg-slate-700/50 rounded animate-pulse"/></td>
              ))}</tr>)
            ) : rows.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-500">{loadError ? '—' : '조작 기록이 없습니다.'}</td></tr>
            ) : rows.map(r => (
              <tr key={r.id} className="hover:bg-slate-700/20 transition-colors">
                <td className="px-4 py-3 text-slate-500 text-xs whitespace-nowrap">{fmtDt(r.createdAt)}</td>
                <td className="px-4 py-3 text-white text-xs font-semibold whitespace-nowrap">{r.actionLabel}</td>
                <td className="px-4 py-3 text-slate-300 text-xs">{r.targetLabel}{r.targetName ? <span className="text-slate-500"> · {r.targetName}</span> : null}</td>
                <td className="px-4 py-3 text-slate-400 text-xs">{r.summary || '—'}</td>
                <td className="px-4 py-3">
                  <p className="text-white text-xs">{r.adminName}</p>
                  <p className="text-slate-500 text-[10px]">{r.adminEmail}</p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-slate-500">총 {meta.total}건</p>
          <div className="flex items-center gap-2">
            <button onClick={() => { const p = page-1; setPage(p); load(p, action); }} disabled={page===1}
              className="px-4 py-2 bg-[#1E293B] border border-slate-700 rounded-xl text-sm text-slate-400 disabled:opacity-40">이전</button>
            <span className="text-sm text-slate-400">{page} / {totalPages}</span>
            <button onClick={() => { const p = page+1; setPage(p); load(p, action); }} disabled={page>=totalPages}
              className="px-4 py-2 bg-[#1E293B] border border-slate-700 rounded-xl text-sm text-slate-400 disabled:opacity-40">다음</button>
          </div>
        </div>
      )}
    </div>
  );
}
