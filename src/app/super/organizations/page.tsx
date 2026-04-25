'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

const ORG_TYPES = ['중앙행정기관', '지방자치단체', '공공기관', '교육기관', '협회단체', '일반기업'];

const PLAN_PRESETS: Record<string, { maxUsers: number; maxAgents: number; maxTokens: number; price: number }> = {
  trial:      { maxUsers: 5,   maxAgents: 3,   maxTokens: 500000,   price: 0       },
  basic:      { maxUsers: 20,  maxAgents: 10,  maxTokens: 2000000,  price: 99000   },
  pro:        { maxUsers: 50,  maxAgents: 30,  maxTokens: 10000000, price: 299000  },
  enterprise: { maxUsers: 200, maxAgents: 100, maxTokens: 50000000, price: 990000  },
};

const PLAN_BADGE: Record<string, string> = {
  trial:      'bg-slate-700 text-slate-300',
  basic:      'bg-blue-900/50 text-blue-300',
  pro:        'bg-violet-900/50 text-violet-300',
  enterprise: 'bg-yellow-900/50 text-yellow-300',
};

const STATUS_BADGE: Record<string, string> = {
  active:    'bg-emerald-900/40 text-emerald-400',
  suspended: 'bg-slate-700 text-slate-400',
  expired:   'bg-red-900/40 text-red-400',
  임박:      'bg-amber-900/40 text-amber-400',
};

interface Org {
  id: string; name: string; slug: string; type: string;
  status: string; plan: string; domain?: string;
  current_users?: number; tokens_this_month?: number;
  contract_expires_at?: string; days_until_expiry?: number | null;
}

function getDisplayStatus(org: Org): { label: string; key: string } {
  if (org.status === 'suspended') return { label: '정지', key: 'suspended' };
  if (org.days_until_expiry !== null && org.days_until_expiry !== undefined && org.days_until_expiry <= 0)
    return { label: '만료', key: 'expired' };
  if (org.days_until_expiry !== null && org.days_until_expiry !== undefined && org.days_until_expiry <= 30)
    return { label: `만료 D-${org.days_until_expiry}`, key: '임박' };
  return { label: '활성', key: 'active' };
}

function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export default function OrganizationsPage() {
  const [orgs, setOrgs]       = useState<Org[]>([]);
  const [total, setTotal]     = useState(0);
  const [page, setPage]       = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterPlan, setFilterPlan]     = useState('all');
  const [panelOpen, setPanelOpen]       = useState(false);
  const [activeMenu, setActiveMenu]     = useState<string | null>(null);
  const [toast, setToast]     = useState<string | null>(null);
  const LIMIT = 20;

  const fetchOrgs = useCallback(async (p = 1) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(p), limit: String(LIMIT) });
      if (search)                  params.set('search', search);
      if (filterStatus !== 'all') params.set('status', filterStatus);
      if (filterPlan   !== 'all') params.set('plan', filterPlan);
      const res = await fetch(`/api/super/organizations?${params}`);
      const result = await res.json();
      if (result.ok) { setOrgs(result.data); setTotal(result.meta.total); }
    } finally {
      setLoading(false);
    }
  }, [search, filterStatus, filterPlan]);

  useEffect(() => { fetchOrgs(1); setPage(1); }, [fetchOrgs]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const handleStatusChange = async (id: string, status: string) => {
    setActiveMenu(null);
    const res = await fetch(`/api/super/organizations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    const result = await res.json();
    if (result.ok) {
      fetchOrgs(page);
      showToast(status === 'suspended' ? '기관이 정지됐습니다.' : '기관이 활성화됐습니다.');
    }
  };

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">기관 관리</h1>
          <p className="text-slate-400 text-sm mt-1">계약된 공공기관 전체 현황</p>
        </div>
        <button
          onClick={() => setPanelOpen(true)}
          className="flex items-center gap-2 px-5 py-2.5 bg-[#7C3AED] hover:bg-[#6D28D9] text-white text-sm font-semibold rounded-xl transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
          </svg>
          새 기관 등록
        </button>
      </div>

      {/* 검색/필터 */}
      <div className="flex flex-wrap gap-3">
        <div className="flex-1 min-w-[200px] relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="기관명 검색..."
            className="w-full pl-10 pr-4 py-2.5 bg-[#1E293B] border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-[#7C3AED]"
            onKeyDown={e => e.key === 'Enter' && fetchOrgs(1)}
          />
        </div>
        <select value={filterPlan} onChange={e => setFilterPlan(e.target.value)}
          className="px-4 py-2.5 bg-[#1E293B] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]">
          {['all','trial','basic','pro','enterprise'].map(p => (
            <option key={p} value={p}>{p === 'all' ? '플랜 전체' : p.charAt(0).toUpperCase() + p.slice(1)}</option>
          ))}
        </select>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
          className="px-4 py-2.5 bg-[#1E293B] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]">
          <option value="all">상태 전체</option>
          <option value="active">활성</option>
          <option value="suspended">정지</option>
        </select>
        <button onClick={() => fetchOrgs(1)}
          className="px-5 py-2.5 bg-[#7C3AED] hover:bg-[#6D28D9] text-white text-sm font-semibold rounded-xl transition-colors">
          검색
        </button>
      </div>

      {/* 테이블 */}
      <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-700/50">
            <tr>
              {['기관명', '플랜', '사용자', '이달 토큰', '계약 만료', '상태', '관리'].map(h => (
                <th key={h} className="px-5 py-3.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/30">
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <tr key={i}>{Array.from({ length: 7 }).map((_, j) => (
                  <td key={j} className="px-5 py-4"><div className="h-4 bg-slate-700/50 rounded animate-pulse" /></td>
                ))}</tr>
              ))
            ) : orgs.length === 0 ? (
              <tr><td colSpan={7} className="px-5 py-12 text-center text-slate-500">등록된 기관이 없습니다.</td></tr>
            ) : (
              orgs.map(org => {
                const ds = getDisplayStatus(org);
                return (
                  <tr key={org.id} className="hover:bg-slate-700/20 transition-colors">
                    <td className="px-5 py-4">
                      <p className="font-semibold text-white">{org.name}</p>
                      <p className="text-xs text-slate-500">{org.slug}</p>
                    </td>
                    <td className="px-5 py-4">
                      <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${PLAN_BADGE[org.plan] ?? 'bg-slate-700 text-slate-300'}`}>
                        {(org.plan ?? 'trial').toUpperCase()}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-slate-300">{org.current_users ?? 0}명</td>
                    <td className="px-5 py-4 text-slate-300">{formatTokens(org.tokens_this_month ?? 0)}</td>
                    <td className="px-5 py-4 text-slate-400 text-xs">
                      {org.contract_expires_at
                        ? new Date(org.contract_expires_at).toLocaleDateString('ko-KR')
                        : '무기한'}
                    </td>
                    <td className="px-5 py-4">
                      <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${STATUS_BADGE[ds.key] ?? STATUS_BADGE['active']}`}>
                        {ds.label}
                      </span>
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-2">
                        <a href={`/super/organizations/${org.id}`}
                          className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-xs font-medium rounded-lg transition-colors">
                          상세
                        </a>
                        <a href="/admin" target="_blank"
                          className="px-3 py-1.5 bg-[#7C3AED]/20 hover:bg-[#7C3AED]/40 text-violet-300 text-xs font-medium rounded-lg transition-colors">
                          접속
                        </a>
                        <div className="relative">
                          <button
                            onClick={() => setActiveMenu(activeMenu === org.id ? null : org.id)}
                            className="p-1.5 hover:bg-slate-600 rounded-lg text-slate-400 transition-colors">
                            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M12 5a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm0 7a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm0 7a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" />
                            </svg>
                          </button>
                          {activeMenu === org.id && (
                            <div className="absolute right-0 top-full mt-1 w-36 bg-[#0F172A] border border-slate-700 rounded-xl shadow-xl z-20 py-1">
                              {org.status === 'active' ? (
                                <button onClick={() => handleStatusChange(org.id, 'suspended')}
                                  className="w-full text-left px-4 py-2 text-sm text-amber-400 hover:bg-slate-800 transition-colors">
                                  기관 정지
                                </button>
                              ) : (
                                <button onClick={() => handleStatusChange(org.id, 'active')}
                                  className="w-full text-left px-4 py-2 text-sm text-emerald-400 hover:bg-slate-800 transition-colors">
                                  기관 활성화
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* 페이지네이션 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-slate-500">총 {total}개 기관</p>
          <div className="flex items-center gap-2">
            <button onClick={() => { const p = page - 1; setPage(p); fetchOrgs(p); }} disabled={page === 1}
              className="px-4 py-2 bg-[#1E293B] border border-slate-700 rounded-xl text-sm text-slate-400 disabled:opacity-40 hover:border-[#7C3AED] transition-colors">
              이전
            </button>
            <span className="text-sm text-slate-400">{page} / {totalPages}</span>
            <button onClick={() => { const p = page + 1; setPage(p); fetchOrgs(p); }} disabled={page >= totalPages}
              className="px-4 py-2 bg-[#1E293B] border border-slate-700 rounded-xl text-sm text-slate-400 disabled:opacity-40 hover:border-[#7C3AED] transition-colors">
              다음
            </button>
          </div>
        </div>
      )}

      {panelOpen && (
        <NewOrgPanel onClose={() => setPanelOpen(false)}
          onCreated={() => { setPanelOpen(false); fetchOrgs(1); showToast('기관이 등록됐습니다.'); }} />
      )}

      {activeMenu && <div className="fixed inset-0 z-10" onClick={() => setActiveMenu(null)} />}

      {toast && (
        <div className="fixed bottom-6 right-6 px-5 py-3 bg-[#7C3AED] text-white text-sm font-semibold rounded-xl shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  );
}

// ── 슬라이드 패널 ──────────────────────────────────────────────
function NewOrgPanel({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    name: '', slug: '', type: '공공기관', plan: 'basic',
    contractStart: new Date().toISOString().slice(0, 10),
    contractEnd: '', maxUsers: 20, maxAgents: 10, maxTokens: 2000000,
    adminEmail: '', adminName: '', monthlyFee: 99000, notes: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [result, setResult]         = useState<{ inviteUrl: string } | null>(null);
  const [copied, setCopied]         = useState(false);

  const set = (k: string, v: unknown) => setForm(f => ({ ...f, [k]: v }));

  const handlePlanChange = (plan: string) => {
    const p = PLAN_PRESETS[plan];
    if (p) setForm(f => ({ ...f, plan, maxUsers: p.maxUsers, maxAgents: p.maxAgents, maxTokens: p.maxTokens, monthlyFee: p.price }));
    else set('plan', plan);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.slug || !form.adminEmail) { setError('기관명, Slug, 관리자 이메일은 필수입니다.'); return; }
    setSubmitting(true); setError(null);
    try {
      const res = await fetch('/api/super/organizations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name, slug: form.slug, type: form.type, plan: form.plan,
          contractStart: form.contractStart || null, contractEnd: form.contractEnd || null,
          maxUsers: form.maxUsers, maxAgents: form.maxAgents, maxTokensPerMonth: form.maxTokens,
          adminEmail: form.adminEmail, adminName: form.adminName,
          monthlyFee: form.monthlyFee, notes: form.notes,
        }),
      });
      const data = await res.json();
      if (!data.ok) { setError(data.error); return; }
      setResult({ inviteUrl: data.data.inviteUrl });
    } catch (err: any) { setError(err.message); }
    finally { setSubmitting(false); }
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 bottom-0 w-full max-w-xl bg-[#1E293B] border-l border-slate-700 z-50 flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-700 flex-shrink-0">
          <h2 className="text-lg font-bold text-white">새 기관 등록</h2>
          <button onClick={onClose} className="p-2 hover:bg-slate-700 rounded-xl text-slate-400">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {result ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 space-y-6 text-center">
            <div className="text-5xl">✅</div>
            <div>
              <p className="text-xl font-bold text-white mb-2">기관이 등록됐습니다!</p>
              <p className="text-slate-400 text-sm">관리자 초대 링크를 전달하세요.</p>
            </div>
            <div className="w-full p-4 bg-[#0F172A] rounded-xl border border-slate-700">
              <p className="text-xs text-slate-500 mb-2">관리자 초대 링크 (7일 유효)</p>
              <p className="text-xs text-slate-300 font-mono break-all mb-3">{result.inviteUrl}</p>
              <button
                onClick={async () => { await navigator.clipboard.writeText(result.inviteUrl); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-colors ${copied ? 'bg-emerald-700 text-white' : 'bg-[#7C3AED] hover:bg-[#6D28D9] text-white'}`}>
                {copied ? '✓ 복사됨' : '링크 복사'}
              </button>
            </div>
            <button onClick={onCreated} className="w-full py-3 bg-slate-700 hover:bg-slate-600 text-white text-sm font-semibold rounded-xl">
              목록으로 돌아가기
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto px-6 py-6 space-y-8">
              {error && <div className="px-4 py-3 bg-red-900/30 border border-red-700/50 rounded-xl text-sm text-red-400">{error}</div>}

              {/* 섹션 1 */}
              <section className="space-y-4">
                <h3 className="text-xs font-bold text-[#A78BFA] uppercase tracking-wider">1. 기관 기본정보</h3>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">기관명 <span className="text-red-400">*</span></label>
                  <input value={form.name} onChange={e => set('name', e.target.value)} required placeholder="예: 오산시 디지털행정과"
                    className="w-full px-4 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:border-[#7C3AED]" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">Slug <span className="text-red-400">*</span></label>
                  <input value={form.slug}
                    onChange={e => set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                    required placeholder="oasan-digital"
                    className="w-full px-4 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:border-[#7C3AED] font-mono" />
                  {form.slug && <p className="text-xs text-slate-500 mt-1">접속 URL: /org/{form.slug}</p>}
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-2">기관 유형</label>
                  <div className="grid grid-cols-3 gap-2">
                    {ORG_TYPES.map(t => (
                      <button key={t} type="button" onClick={() => set('type', t)}
                        className={`py-2 px-3 rounded-lg text-xs font-medium transition-colors ${form.type === t ? 'bg-[#7C3AED] text-white' : 'bg-[#0F172A] text-slate-400 hover:text-white border border-slate-700'}`}>
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
              </section>

              {/* 섹션 2 */}
              <section className="space-y-4">
                <h3 className="text-xs font-bold text-[#A78BFA] uppercase tracking-wider">2. 계약 정보</h3>
                <div className="grid grid-cols-4 gap-2">
                  {Object.entries(PLAN_PRESETS).map(([key, preset]) => (
                    <button key={key} type="button" onClick={() => handlePlanChange(key)}
                      className={`py-2.5 rounded-xl text-xs font-bold transition-colors text-center ${form.plan === key ? 'bg-[#7C3AED] text-white' : 'bg-[#0F172A] text-slate-400 border border-slate-700 hover:border-[#7C3AED]'}`}>
                      {key.charAt(0).toUpperCase() + key.slice(1)}<br/>
                      <span className="font-normal text-[10px] opacity-70">{preset.price === 0 ? '무료' : `${(preset.price/10000).toFixed(0)}만원`}</span>
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1.5">계약 시작일</label>
                    <input type="date" value={form.contractStart} onChange={e => set('contractStart', e.target.value)}
                      className="w-full px-3 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1.5">계약 종료일</label>
                    <input type="date" value={form.contractEnd} onChange={e => set('contractEnd', e.target.value)}
                      className="w-full px-3 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]" />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">월 이용료 (원)</label>
                  <input type="number" value={form.monthlyFee} onChange={e => set('monthlyFee', Number(e.target.value))} min={0}
                    className="w-full px-4 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]" />
                </div>
              </section>

              {/* 섹션 3 */}
              <section className="space-y-4">
                <h3 className="text-xs font-bold text-[#A78BFA] uppercase tracking-wider">3. 사용 한도</h3>
                <div className="grid grid-cols-3 gap-3">
                  {[['maxUsers','최대 사용자'],['maxAgents','최대 비서'],['maxTokens','월 토큰 한도']].map(([k, label]) => (
                    <div key={k}>
                      <label className="block text-xs font-semibold text-slate-400 mb-1.5">{label}</label>
                      <input type="number" value={(form as any)[k]} onChange={e => set(k, Number(e.target.value))} min={1}
                        className="w-full px-3 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]" />
                    </div>
                  ))}
                </div>
              </section>

              {/* 섹션 4 */}
              <section className="space-y-4">
                <h3 className="text-xs font-bold text-[#A78BFA] uppercase tracking-wider">4. 관리자 계정</h3>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">관리자 이메일 <span className="text-red-400">*</span></label>
                  <input type="email" value={form.adminEmail} onChange={e => set('adminEmail', e.target.value)} required placeholder="admin@org.go.kr"
                    className="w-full px-4 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:border-[#7C3AED]" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">관리자 이름</label>
                  <input value={form.adminName} onChange={e => set('adminName', e.target.value)} placeholder="홍길동"
                    className="w-full px-4 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:border-[#7C3AED]" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">메모</label>
                  <textarea value={form.notes} onChange={e => set('notes', e.target.value)} rows={2} placeholder="특이사항, 할인 조건 등"
                    className="w-full px-4 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:border-[#7C3AED] resize-none" />
                </div>
              </section>
            </div>

            <div className="px-6 py-5 border-t border-slate-700 flex gap-3 flex-shrink-0">
              <button type="button" onClick={onClose}
                className="flex-1 py-3 border border-slate-700 rounded-xl text-sm text-slate-400 hover:text-white hover:border-slate-500 transition-colors">
                취소
              </button>
              <button type="submit" disabled={submitting}
                className="flex-1 py-3 bg-[#7C3AED] hover:bg-[#6D28D9] disabled:bg-slate-700 disabled:cursor-not-allowed text-white font-semibold rounded-xl text-sm transition-colors">
                {submitting ? '등록 중...' : '등록하기'}
              </button>
            </div>
          </form>
        )}
      </div>
    </>
  );
}
