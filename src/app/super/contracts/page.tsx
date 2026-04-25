'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { PLANS } from '@/lib/plans';

type Tab = 'list' | 'expiring' | 'revenue' | 'plans';

const fmtDate  = (s?: string | null) => s ? new Date(s).toLocaleDateString('ko-KR') : '무기한';
const fmtMoney = (n: number) => n.toLocaleString('ko-KR') + '원';
const MONTHS   = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];

const PLAN_BADGE: Record<string, string> = {
  trial:      'bg-slate-700 text-slate-300',
  basic:      'bg-blue-900/50 text-blue-300',
  pro:        'bg-violet-900/50 text-violet-300',
  enterprise: 'bg-yellow-900/50 text-yellow-300',
};

function daysColor(days: number | null) {
  if (days === null) return 'text-emerald-400';
  if (days <= 0)  return 'text-red-400';
  if (days <= 30) return 'text-amber-400';
  return 'text-emerald-400';
}

function statusBadge(status: string) {
  switch (status) {
    case 'active':    return 'bg-emerald-900/40 text-emerald-400';
    case 'expired':   return 'bg-red-900/40 text-red-400';
    case 'cancelled': return 'bg-slate-700 text-slate-400';
    default:          return 'bg-slate-700 text-slate-400';
  }
}

// ═══════════════════════════════════════════════════════════
export default function ContractsPage() {
  const [tab, setTab]   = useState<Tab>('list');
  const [toast, setToast] = useState<string | null>(null);
  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(null), 3000); };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">계약/과금 관리</h1>
        <p className="text-slate-400 text-sm mt-1">기관별 계약 및 매출 관리</p>
      </div>

      <div className="flex gap-1 border-b border-slate-700/50">
        {([['list','계약 현황'],['expiring','만료 예정'],['revenue','매출 현황'],['plans','요금제 설정']] as [Tab,string][]).map(([k,l]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2.5 text-sm font-semibold rounded-t-lg transition-colors border-b-2 ${
              tab === k ? 'border-[#7C3AED] text-[#A78BFA] bg-[#7C3AED]/10' : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}>
            {l}
          </button>
        ))}
      </div>

      {tab === 'list'     && <ContractListTab onToast={showToast} />}
      {tab === 'expiring' && <ExpiringTab onToast={showToast} />}
      {tab === 'revenue'  && <RevenueTab />}
      {tab === 'plans'    && <PlansTab onToast={showToast} />}

      {toast && (
        <div className="fixed bottom-6 right-6 px-5 py-3 bg-[#7C3AED] text-white text-sm font-semibold rounded-xl shadow-lg z-50">{toast}</div>
      )}
    </div>
  );
}

// ─── 1. 계약 현황 ─────────────────────────────────────────
function ContractListTab({ onToast }: { onToast: (m: string) => void }) {
  const [contracts, setContracts] = useState<any[]>([]);
  const [summary, setSummary]     = useState({ totalActive: 0, expiringIn30Days: 0, totalMonthlyRevenue: 0 });
  const [orgs, setOrgs]           = useState<any[]>([]);
  const [loading, setLoading]     = useState(true);
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterPlan, setFilterPlan]     = useState('all');
  const [panelOpen, setPanelOpen]       = useState(false);
  const [renewModal, setRenewModal]     = useState<any>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const p = new URLSearchParams({ status: filterStatus, limit: '50' });
    const [cr, or] = await Promise.all([
      fetch(`/api/super/contracts?${p}`).then(r => r.json()),
      fetch('/api/super/organizations?limit=100').then(r => r.json()),
    ]);
    if (cr.ok) { setContracts(cr.data); setSummary(cr.summary); }
    if (or.ok) setOrgs(or.data);
    setLoading(false);
  }, [filterStatus]);

  useEffect(() => { load(); }, [load]);

  const filtered = filterPlan === 'all'
    ? contracts
    : contracts.filter(c => c.planType === filterPlan);

  const handleCancel = async (id: string) => {
    if (!confirm('계약을 해지하시겠습니까? 기관 서비스가 정지됩니다.')) return;
    const res = await fetch(`/api/super/contracts/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'cancelled' }),
    });
    const d = await res.json();
    if (d.ok) { load(); onToast('계약이 해지됐습니다.'); }
    else onToast(d.error);
  };

  return (
    <div className="space-y-5">
      {/* 요약 카드 */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { icon: '📋', label: '활성 계약',          value: `${summary.totalActive}건` },
          { icon: '⚠️', label: '만료 임박 (30일)',   value: `${summary.expiringIn30Days}건`, warn: summary.expiringIn30Days > 0 },
          { icon: '💰', label: '월 매출',             value: fmtMoney(summary.totalMonthlyRevenue) },
        ].map(c => (
          <div key={c.label} className={`bg-[#1E293B] border rounded-2xl p-5 ${c.warn ? 'border-amber-700/40' : 'border-slate-700/50'}`}>
            <span className="text-2xl">{c.icon}</span>
            <p className={`text-2xl font-bold mt-2 ${c.warn ? 'text-amber-400' : 'text-white'}`}>{c.value}</p>
            <p className="text-xs text-slate-500 mt-0.5">{c.label}</p>
          </div>
        ))}
      </div>

      {/* 필터 + 버튼 */}
      <div className="flex flex-wrap gap-3 items-center">
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
          className="px-3 py-2 bg-[#1E293B] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]">
          <option value="all">상태 전체</option>
          <option value="active">활성</option>
          <option value="expired">만료</option>
          <option value="cancelled">해지</option>
        </select>
        <select value={filterPlan} onChange={e => setFilterPlan(e.target.value)}
          className="px-3 py-2 bg-[#1E293B] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]">
          <option value="all">플랜 전체</option>
          {Object.keys(PLANS).map(k => <option key={k} value={k}>{k.charAt(0).toUpperCase()+k.slice(1)}</option>)}
        </select>
        <div className="ml-auto">
          <button onClick={() => setPanelOpen(true)}
            className="flex items-center gap-2 px-5 py-2 bg-[#7C3AED] hover:bg-[#6D28D9] text-white text-sm font-semibold rounded-xl transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4"/></svg>
            새 계약 추가
          </button>
        </div>
      </div>

      {/* 테이블 */}
      <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-700/50">
            <tr>
              {['기관명','플랜','월이용료','시작일','종료일','남은일수','상태','관리'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/30">
            {loading ? (
              Array.from({length:3}).map((_,i) => (
                <tr key={i}>{Array.from({length:8}).map((_,j) => (
                  <td key={j} className="px-4 py-4"><div className="h-3 bg-slate-700/50 rounded animate-pulse"/></td>
                ))}</tr>
              ))
            ) : filtered.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-10 text-center text-slate-500">계약이 없습니다.</td></tr>
            ) : (
              filtered.map(c => (
                <tr key={c.id} className="hover:bg-slate-700/20 transition-colors">
                  <td className="px-4 py-3 font-semibold text-white">{c.orgName}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${PLAN_BADGE[c.planType] ?? 'bg-slate-700 text-slate-300'}`}>
                      {(c.planType ?? 'trial').toUpperCase()}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-300">{c.monthlyFee.toLocaleString()}원</td>
                  <td className="px-4 py-3 text-slate-500 text-xs">{fmtDate(c.startDate)}</td>
                  <td className="px-4 py-3 text-slate-500 text-xs">{fmtDate(c.endDate)}</td>
                  <td className={`px-4 py-3 text-sm font-semibold ${daysColor(c.daysLeft)}`}>
                    {c.daysLeft === null ? '무기한' : c.daysLeft <= 0 ? '만료됨' : `D-${c.daysLeft}`}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusBadge(c.status)}`}>
                      {c.status === 'active' ? '활성' : c.status === 'expired' ? '만료' : '해지'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1.5">
                      <button onClick={() => setRenewModal(c)}
                        className="px-2.5 py-1 bg-[#7C3AED]/20 hover:bg-[#7C3AED]/40 text-violet-300 text-xs rounded-lg transition-colors">갱신</button>
                      {c.status === 'active' && (
                        <button onClick={() => handleCancel(c.id)}
                          className="px-2.5 py-1 bg-red-900/20 hover:bg-red-900/40 text-red-400 text-xs rounded-lg transition-colors">해지</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* 새 계약 패널 */}
      {panelOpen && (
        <NewContractPanel orgs={orgs} onClose={() => setPanelOpen(false)}
          onCreated={() => { setPanelOpen(false); load(); onToast('계약이 등록됐습니다.'); }} />
      )}

      {/* 갱신 모달 */}
      {renewModal && (
        <RenewModal contract={renewModal} onClose={() => setRenewModal(null)}
          onSaved={() => { setRenewModal(null); load(); onToast('계약이 갱신됐습니다.'); }} />
      )}
    </div>
  );
}

// ─── 새 계약 패널 ─────────────────────────────────────────
function NewContractPanel({ orgs, onClose, onCreated }: { orgs: any[]; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    orgId: '', plan: 'basic',
    startDate: new Date().toISOString().slice(0, 10), endDate: '', notes: '',
    monthlyFee: PLANS.basic.monthlyFee,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const set = (k: string, v: unknown) => setForm(f => ({ ...f, [k]: v }));

  const handlePlanChange = (plan: string) => {
    const p = PLANS[plan as keyof typeof PLANS];
    if (p) setForm(f => ({ ...f, plan, monthlyFee: p.monthlyFee }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.orgId) { setError('기관을 선택하세요.'); return; }
    setSaving(true); setError(null);
    const res = await fetch('/api/super/contracts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: form.orgId, planType: form.plan, monthlyFee: form.monthlyFee, startDate: form.startDate, endDate: form.endDate || null, notes: form.notes }),
    });
    const d = await res.json();
    if (d.ok) onCreated(); else setError(d.error);
    setSaving(false);
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-[#1E293B] border-l border-slate-700 z-50 flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-700 flex-shrink-0">
          <h2 className="text-lg font-bold text-white">새 계약 추가</h2>
          <button onClick={onClose} className="p-2 hover:bg-slate-700 rounded-xl text-slate-400">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
        <form onSubmit={handleSubmit} className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto px-6 py-6 space-y-5">
            {error && <div className="px-4 py-3 bg-red-900/30 border border-red-700/50 rounded-xl text-sm text-red-400">{error}</div>}
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1.5">기관 <span className="text-red-400">*</span></label>
              <select value={form.orgId} onChange={e => set('orgId', e.target.value)} required
                className="w-full px-4 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]">
                <option value="">기관 선택...</option>
                {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-2">요금제</label>
              <div className="grid grid-cols-4 gap-2">
                {Object.entries(PLANS).map(([k, p]) => (
                  <button key={k} type="button" onClick={() => handlePlanChange(k)}
                    className={`py-2.5 rounded-xl text-xs font-bold transition-colors text-center ${form.plan === k ? 'bg-[#7C3AED] text-white' : 'bg-[#0F172A] text-slate-400 border border-slate-700'}`}>
                    {p.name}<br/><span className="font-normal text-[10px] opacity-70">{p.monthlyFee === 0 ? '무료' : `${(p.monthlyFee/10000).toFixed(0)}만`}</span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1.5">월 이용료 (원)</label>
              <input type="number" value={form.monthlyFee} onChange={e => set('monthlyFee', Number(e.target.value))} min={0}
                className="w-full px-4 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]"/>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">계약 시작일</label>
                <input type="date" value={form.startDate} onChange={e => set('startDate', e.target.value)}
                  className="w-full px-3 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]"/>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">계약 종료일</label>
                <input type="date" value={form.endDate} onChange={e => set('endDate', e.target.value)}
                  className="w-full px-3 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]"/>
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1.5">메모</label>
              <textarea value={form.notes} onChange={e => set('notes', e.target.value)} rows={2}
                className="w-full px-4 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white resize-none focus:outline-none focus:border-[#7C3AED]"/>
            </div>
          </div>
          <div className="px-6 py-5 border-t border-slate-700 flex gap-3 flex-shrink-0">
            <button type="button" onClick={onClose} className="flex-1 py-3 border border-slate-700 rounded-xl text-sm text-slate-400 hover:text-white">취소</button>
            <button type="submit" disabled={saving}
              className="flex-1 py-3 bg-[#7C3AED] hover:bg-[#6D28D9] disabled:bg-slate-700 text-white font-semibold rounded-xl text-sm">
              {saving ? '저장 중...' : '저장'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

// ─── 갱신 모달 ───────────────────────────────────────────
function RenewModal({ contract: c, onClose, onSaved }: { contract: any; onClose: () => void; onSaved: () => void }) {
  const [endDate, setEndDate] = useState('');
  const [plan, setPlan]       = useState(c.planType ?? 'basic');
  const [fee, setFee]         = useState(c.monthlyFee ?? 0);
  const [notes, setNotes]     = useState('');
  const [saving, setSaving]   = useState(false);

  const handleSave = async () => {
    setSaving(true);
    const res = await fetch(`/api/super/contracts/${c.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endDate: endDate || undefined, planType: plan, monthlyFee: fee, notes }),
    });
    const d = await res.json();
    if (d.ok) onSaved(); setSaving(false);
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
      <div className="bg-[#1E293B] border border-slate-700 rounded-2xl p-6 w-full max-w-sm space-y-4">
        <h3 className="text-base font-bold text-white">계약 갱신 — {c.orgName}</h3>
        <div className="p-3 bg-[#0F172A] rounded-xl text-xs text-slate-400 space-y-1">
          <p>현재 플랜: {c.planType?.toUpperCase()}</p>
          <p>현재 종료일: {fmtDate(c.endDate)}</p>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-400 mb-1.5">새 종료일</label>
          <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
            className="w-full px-3 py-2.5 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]"/>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-400 mb-1.5">플랜 변경 (선택)</label>
          <div className="grid grid-cols-4 gap-1.5">
            {Object.keys(PLANS).map(k => (
              <button key={k} type="button" onClick={() => { setPlan(k); setFee(PLANS[k as keyof typeof PLANS].monthlyFee); }}
                className={`py-2 rounded-lg text-xs font-semibold transition-colors ${plan === k ? 'bg-[#7C3AED] text-white' : 'bg-[#0F172A] border border-slate-700 text-slate-400'}`}>
                {k.charAt(0).toUpperCase()+k.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-400 mb-1.5">월 이용료</label>
          <input type="number" value={fee} onChange={e => setFee(Number(e.target.value))} min={0}
            className="w-full px-3 py-2.5 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]"/>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-400 mb-1.5">메모</label>
          <input value={notes} onChange={e => setNotes(e.target.value)}
            className="w-full px-3 py-2.5 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]"/>
        </div>
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-2.5 border border-slate-700 rounded-xl text-sm text-slate-400 hover:text-white">취소</button>
          <button onClick={handleSave} disabled={saving}
            className="flex-1 py-2.5 bg-[#7C3AED] hover:bg-[#6D28D9] disabled:bg-slate-700 text-white font-semibold rounded-xl text-sm">
            {saving ? '저장 중...' : '갱신'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 2. 만료 예정 탭 ────────────────────────────────────
function ExpiringTab({ onToast }: { onToast: (m: string) => void }) {
  const [list, setList]       = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [renewModal, setRenewModal] = useState<any>(null);

  useEffect(() => {
    setLoading(true);
    fetch('/api/super/contracts/expiring').then(r => r.json())
      .then(d => { if (d.ok) setList(d.data); }).finally(() => setLoading(false));
  }, []);

  const copyRenewalText = (item: any) => {
    const text = `안녕하세요, ${item.orgName} 담당자님.\n\nWORKON AI 서비스 계약이 ${fmtDate(item.endDate)}에 만료됩니다 (D-${item.daysLeft}).\n갱신을 원하시면 아래로 연락 주세요.\n이메일: contact@workon.ai\n\n감사합니다.`;
    navigator.clipboard.writeText(text);
    onToast('갱신 안내 문구가 복사됐습니다.');
  };

  return (
    <div className="space-y-4">
      {list.length > 0 && (
        <div className="p-4 bg-amber-950/20 border border-amber-700/30 rounded-xl">
          <p className="text-sm text-amber-400">
            ⚠️ 아래 기관의 계약이 30일 이내에 만료됩니다. 갱신 안내를 진행해 주세요.
          </p>
        </div>
      )}
      {loading ? (
        <div className="flex justify-center py-12"><div className="w-6 h-6 border-2 border-[#7C3AED]/30 border-t-[#7C3AED] rounded-full animate-spin"/></div>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span className="text-4xl mb-3">✅</span>
          <p className="text-white font-semibold">만료 예정 계약이 없습니다.</p>
          <p className="text-slate-500 text-sm mt-1">30일 이내에 만료되는 계약이 없습니다.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {list.map(item => (
            <div key={item.id} className="bg-[#1E293B] border border-amber-700/30 rounded-2xl p-5">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-lg">🏢</span>
                    <p className="font-bold text-white">{item.orgName}</p>
                    <span className={`text-sm font-bold ${daysColor(item.daysLeft)}`}>D-{item.daysLeft}일 남음</span>
                  </div>
                  <p className="text-xs text-slate-400">
                    플랜: {item.plan?.toUpperCase()} | 월이용료: {item.monthlyFee.toLocaleString()}원
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">만료일: {fmtDate(item.endDate)}</p>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <button onClick={() => copyRenewalText(item)}
                    className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-xs font-medium rounded-lg transition-colors">
                    안내 문구 복사
                  </button>
                  <button onClick={() => setRenewModal(item)}
                    className="px-3 py-1.5 bg-[#7C3AED] hover:bg-[#6D28D9] text-white text-xs font-semibold rounded-lg transition-colors">
                    갱신하기
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {renewModal && (
        <RenewModal contract={renewModal} onClose={() => setRenewModal(null)}
          onSaved={() => { setRenewModal(null); onToast('계약이 갱신됐습니다.'); window.location.reload(); }} />
      )}
    </div>
  );
}

// ─── 3. 매출 현황 탭 ────────────────────────────────────
function RevenueTab() {
  const [year, setYear]   = useState(new Date().getFullYear());
  const [data, setData]   = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/super/contracts/revenue?year=${year}`).then(r => r.json())
      .then(d => { if (d.ok) setData(d.data); }).finally(() => setLoading(false));
  }, [year]);

  const annual = data?.annual ?? {};
  const chartData = (data?.monthly ?? []).map((m: any) => ({
    name: MONTHS[m.month - 1],
    매출: m.revenue,
    'API비용(원)': m.apiCostKrw,
    순이익: m.netProfit,
  }));

  return (
    <div className="space-y-6">
      {/* 연도 선택 */}
      <div className="flex items-center gap-3">
        <select value={year} onChange={e => setYear(Number(e.target.value))}
          className="px-4 py-2.5 bg-[#1E293B] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]">
          {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}년</option>)}
        </select>
      </div>

      {/* 연간 요약 */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: '연간 총 매출',   value: fmtMoney(annual.totalRevenue ?? 0), icon: '💰' },
          { label: '연간 API 비용',  value: `$${(annual.totalCostUsd ?? 0).toFixed(2)} (${fmtMoney(annual.totalCostKrw ?? 0)})`, icon: '💸' },
          { label: '연간 순이익',    value: fmtMoney(annual.totalProfit ?? 0), icon: '📈', pos: (annual.totalProfit ?? 0) >= 0 },
        ].map(c => (
          <div key={c.label} className="bg-[#1E293B] border border-slate-700/50 rounded-2xl p-5">
            <span className="text-2xl">{c.icon}</span>
            <p className={`text-xl font-bold mt-2 ${c.pos === false ? 'text-red-400' : 'text-white'}`}>{c.value}</p>
            <p className="text-xs text-slate-500 mt-0.5">{c.label}</p>
          </div>
        ))}
      </div>

      {/* 월별 차트 */}
      <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl p-6">
        <h3 className="text-sm font-bold text-white mb-4">월별 매출 / API 비용</h3>
        {loading ? (
          <div className="h-56 flex items-center justify-center"><div className="w-6 h-6 border-2 border-[#7C3AED]/30 border-t-[#7C3AED] rounded-full animate-spin"/></div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} />
              <YAxis yAxisId="left" tickFormatter={v => `${(v/10000).toFixed(0)}만`} tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{ background: '#1E293B', border: '1px solid #334155', borderRadius: 8, fontSize: 11 }}
                formatter={(v: any) => [Number(v).toLocaleString() + '원', '']}
              />
              <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />
              <Bar yAxisId="left" dataKey="매출" fill="#7C3AED" radius={[3,3,0,0]} maxBarSize={24} />
              <Bar yAxisId="left" dataKey="API비용(원)" fill="#334155" radius={[3,3,0,0]} maxBarSize={24} />
              <Line yAxisId="left" type="monotone" dataKey="순이익" stroke="#34D399" strokeWidth={2} dot={{ r: 3 }} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* 월별 상세 테이블 */}
      <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-700/50">
            <tr>
              {['월','활성기관','매출(원)','API비용($)','순이익(원)'].map(h => (
                <th key={h} className="px-5 py-3 text-left text-xs font-semibold text-slate-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/30">
            {(data?.monthly ?? []).map((m: any) => (
              <tr key={m.month} className="hover:bg-slate-700/20 transition-colors">
                <td className="px-5 py-3 font-medium text-white">{MONTHS[m.month-1]}</td>
                <td className="px-5 py-3 text-slate-400">{m.orgCount}개</td>
                <td className="px-5 py-3 text-slate-300">{m.revenue.toLocaleString()}</td>
                <td className="px-5 py-3 text-slate-400">${m.apiCostUsd}</td>
                <td className={`px-5 py-3 font-semibold ${m.netProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {m.netProfit.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── 4. 요금제 설정 탭 ──────────────────────────────────
function PlansTab({ onToast }: { onToast: (m: string) => void }) {
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editData, setEditData] = useState<any>(null);

  const startEdit = (key: string) => {
    setEditKey(key);
    setEditData({ ...PLANS[key as keyof typeof PLANS] });
  };

  const handleSave = () => {
    // plans.ts는 코드 파일이므로 런타임 변경 불가 — UI에서만 반영하고 안내
    onToast('요금제 변경 사항은 코드(src/lib/plans.ts) 수정 후 재배포가 필요합니다.');
    setEditKey(null);
  };

  const fmt = (n: number) => n >= 1_000_000 ? `${(n/1_000_000).toFixed(0)}M` : n >= 1_000 ? `${(n/1_000).toFixed(0)}K` : String(n);

  return (
    <div className="space-y-4">
      <div className="p-4 bg-blue-950/30 border border-blue-700/30 rounded-xl text-sm text-slate-300">
        <span className="font-semibold text-white">ℹ️ 안내</span> 요금제 변경 내용은 새 계약 시 자동 적용됩니다.<br/>
        기존 계약은 갱신 시 새 요금제 기준으로 업데이트됩니다.
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Object.entries(PLANS).map(([key, plan]) => {
          const isEditing = editKey === key;
          const d = isEditing ? editData : plan;
          return (
            <div key={key} className="bg-[#1E293B] border border-slate-700/50 rounded-2xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-base font-bold text-white">{plan.name}</span>
                <span className="w-3 h-3 rounded-full" style={{ backgroundColor: plan.color }} />
              </div>
              <div className="text-xl font-bold text-white">
                {plan.monthlyFee === 0 ? '무료' : fmtMoney(plan.monthlyFee)}
              </div>
              <div className="space-y-2 text-xs">
                {isEditing ? (
                  <>
                    {[
                      ['최대 사용자', 'maxUsers'],
                      ['최대 비서', 'maxAgents'],
                      ['월 토큰', 'maxTokensPerMonth'],
                      ['월 이용료 (원)', 'monthlyFee'],
                    ].map(([label, field]) => (
                      <div key={field}>
                        <label className="block text-slate-500 mb-0.5">{label}</label>
                        <input type="number" value={d[field]}
                          onChange={e => setEditData((p: any) => ({ ...p, [field]: Number(e.target.value) }))}
                          className="w-full px-3 py-2 bg-[#0F172A] border border-slate-700 rounded-lg text-white focus:outline-none focus:border-[#7C3AED]"/>
                      </div>
                    ))}
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-1.5 text-slate-400"><span>👥</span> 최대 사용자 {d.maxUsers >= 999999 ? '무제한' : `${d.maxUsers}명`}</div>
                    <div className="flex items-center gap-1.5 text-slate-400"><span>🤖</span> 최대 비서 {d.maxAgents >= 999999 ? '무제한' : `${d.maxAgents}개`}</div>
                    <div className="flex items-center gap-1.5 text-slate-400"><span>🔤</span> 월 토큰 {d.maxTokensPerMonth >= 999999999 ? '무제한' : fmt(d.maxTokensPerMonth)}</div>
                  </>
                )}
              </div>
              <div className="flex gap-2">
                {isEditing ? (
                  <>
                    <button onClick={handleSave} className="flex-1 py-2 bg-[#7C3AED] hover:bg-[#6D28D9] text-white text-xs font-semibold rounded-lg">저장</button>
                    <button onClick={() => setEditKey(null)} className="flex-1 py-2 border border-slate-700 text-slate-400 text-xs rounded-lg hover:text-white">취소</button>
                  </>
                ) : (
                  <button onClick={() => startEdit(key)} className="w-full py-2 bg-slate-700 hover:bg-slate-600 text-white text-xs font-medium rounded-lg">수정</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
