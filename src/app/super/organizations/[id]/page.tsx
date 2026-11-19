'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { kstDay } from '@/lib/kst-time';
import { isImeComposing } from '@/lib/ime';
import { STORED_KEYS_NOT_USED_NOTICE } from '@/lib/api-key-providers';
import { orgSignInPath } from '@/lib/org-slug';
import { PLANS } from '@/lib/plans';
import { orgStatusLabel, orgSuspendConfirmText, requestOrgStatusChange } from '@/lib/org-status';

type Tab = 'overview' | 'users' | 'usage' | 'apikeys' | 'contracts';

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview',  label: '기본정보' },
  { key: 'users',     label: '사용자' },
  { key: 'usage',     label: '사용량' },
  { key: 'apikeys',   label: 'API 키' },
  { key: 'contracts', label: '계약' },
];

const PLAN_BADGE: Record<string, string> = {
  trial:      'bg-slate-700 text-slate-300',
  basic:      'bg-blue-900/50 text-blue-300',
  pro:        'bg-violet-900/50 text-violet-300',
  enterprise: 'bg-yellow-900/50 text-yellow-300',
};

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}
function fmtDate(s?: string) {
  if (!s) return '—';
  return new Date(s).toLocaleDateString('ko-KR');
}

// ═════════════════════════════════════════════════════════════
export default function OrgDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router  = useRouter();
  const [tab, setTab]   = useState<Tab>('overview');
  const [org, setOrg]   = useState<any>(null);
  const [loading, setLoading]       = useState(true);
  const [toast, setToast]           = useState<string | null>(null);
  const [impersonating, setImpersonating] = useState(false);

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000); };

  const handleImpersonate = async () => {
    setImpersonating(true);
    try {
      const res  = await fetch(`/api/super/organizations/${id}/impersonate`, { method: 'POST' });
      const data = await res.json();
      if (!data.ok) { showToast(data.error ?? '접속 실패'); return; }
      window.open('/admin', '_blank');
    } catch {
      showToast('접속 중 오류가 발생했습니다.');
    } finally {
      setImpersonating(false);
    }
  };

  const fetchOrg = useCallback(async () => {
    setLoading(true);
    const res  = await fetch(`/api/super/organizations/${id}`);
    const data = await res.json();
    if (data.ok) setOrg(data.data);
    setLoading(false);
  }, [id]);

  useEffect(() => { fetchOrg(); }, [fetchOrg]);

  const handleStatusChange = async (status: string) => {
    if (status === 'suspended' && !window.confirm(orgSuspendConfirmText(org?.name ?? '이'))) return;
    // 실패도 알린다 — 계약을 맞추지 못했으면 그 경고를(2026-11-17, 2026-11-19)
    const notice = await requestOrgStatusChange(id, status);
    fetchOrg();
    showToast(notice.message);
  };

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-2 border-[#7C3AED]/30 border-t-[#7C3AED] rounded-full animate-spin" />
    </div>
  );
  if (!org) return <div className="text-slate-400">기관을 찾을 수 없습니다.</div>;

  return (
    <div className="space-y-6">
      {/* 헤더 */}
      <div className="flex items-start justify-between">
        <div>
          <button onClick={() => router.back()} className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 mb-2 transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            기관 목록
          </button>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-white">{org.name}</h1>
            <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${org.status === 'active' ? 'bg-emerald-900/40 text-emerald-400' : 'bg-slate-700 text-slate-400'}`}>
              {orgStatusLabel(org.status)}
            </span>
            <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${PLAN_BADGE[org.plan] ?? 'bg-slate-700 text-slate-300'}`}>
              {(org.plan ?? 'trial').toUpperCase()}
            </span>
          </div>
          <p className="text-slate-500 text-sm mt-1">{org.slug} · {org.type}</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleImpersonate}
            disabled={impersonating}
            className="px-4 py-2 bg-[#7C3AED]/20 hover:bg-[#7C3AED]/40 disabled:opacity-50 text-violet-300 text-sm font-medium rounded-xl transition-colors"
          >
            {impersonating ? '접속 중...' : '기관 접속'}
          </button>
          {org.status === 'active' ? (
            <button onClick={() => handleStatusChange('suspended')}
              className="px-4 py-2 bg-amber-900/30 hover:bg-amber-900/50 text-amber-400 text-sm font-medium rounded-xl transition-colors">
              기관 정지
            </button>
          ) : (
            <button onClick={() => handleStatusChange('active')}
              className="px-4 py-2 bg-emerald-900/30 hover:bg-emerald-900/50 text-emerald-400 text-sm font-medium rounded-xl transition-colors">
              기관 활성화
            </button>
          )}
        </div>
      </div>

      {/* 탭 */}
      <div className="flex gap-1 border-b border-slate-700/50">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm font-semibold rounded-t-lg transition-colors border-b-2 ${
              tab === t.key ? 'border-[#7C3AED] text-[#A78BFA] bg-[#7C3AED]/10' : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* 탭 콘텐츠 */}
      {tab === 'overview'  && <OverviewTab  org={org} onRefresh={fetchOrg} onToast={showToast} onSuspend={() => handleStatusChange('suspended')} />}
      {tab === 'users'     && <UsersTab     orgId={id} />}
      {tab === 'usage'     && <UsageTab     orgId={id} />}
      {tab === 'apikeys'   && <ApiKeysTab   orgId={id} onToast={showToast} />}
      {tab === 'contracts' && <ContractsTab orgId={id} onToast={showToast} />}

      {toast && (
        <div className="fixed bottom-6 right-6 px-5 py-3 bg-[#7C3AED] text-white text-sm font-semibold rounded-xl shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  );
}

// ─── 1. 기본정보 탭 ──────────────────────────────────────────
function OverviewTab({ org, onRefresh, onToast, onSuspend }: { org: any; onRefresh: () => void; onToast: (m: string) => void; onSuspend: () => void }) {
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteInput, setDeleteInput]         = useState('');
  const [invitations, setInvitations]         = useState<any[]>([]);
  const [showNewInvite, setShowNewInvite]     = useState(false);
  const [inviteEmail, setInviteEmail]         = useState('');
  const [inviting, setInviting]               = useState(false);

  useEffect(() => {
    fetch(`/api/super/organizations/${org.id}/invitations`)
      .then(r => r.json()).then(d => { if (d?.ok) setInvitations(d.data); else onToast('초대 링크 목록을 불러오지 못했습니다.'); })
      .catch(() => onToast('초대 링크 목록을 불러오지 못했습니다.'));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org.id]);

  const handleNewInvite = async () => {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    const res  = await fetch(`/api/super/organizations/${org.id}/invitations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: inviteEmail, role: 'ADMIN' }),
    });
    const data = await res.json();
    if (data.ok) {
      setInvitations(prev => [data.data, ...prev]);
      setInviteEmail(''); setShowNewInvite(false);
      onToast('초대 링크가 생성됐습니다.');
    } else {
      onToast(data.error ?? '오류가 발생했습니다.');
    }
    setInviting(false);
  };

  const progressColor = (pct: number) =>
    pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-[#7C3AED]';

  // 2026-11-17 — 비서 막대는 예전에 부서 수로 그렸다(비서 수 칸이 없어 늘 0으로 보임). 못 읽은 값(null)은 '—'
  const pctOf = (current: number | null | undefined, max: number | null | undefined) =>
    max && typeof current === 'number' ? Math.min(100, Math.round(current / max * 100)) : 0;
  const userPct   = pctOf(org.user_count, org.max_users);
  const agentPct  = pctOf(org.agent_count, org.max_agents);
  const tokenPct  = pctOf(org.tokens_this_month, org.monthly_token_limit);

  const handleDelete = async () => {
    if (deleteInput !== org.name) { onToast('기관명이 일치하지 않습니다.'); return; }
    // 2026-11-17 — 예전엔 응답을 보지 않고 늘 '삭제됐습니다'라고 알렸다
    const res = await fetch(`/api/super/organizations/${org.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'terminated' }),
    }).catch(() => null);
    const data = res ? await res.json().catch(() => null) : null;
    if (!data?.ok) { onToast((typeof data?.error === 'string' ? data.error : data?.error?.message) ?? '기관을 종료하지 못했습니다. 잠시 뒤 다시 시도해 주세요.'); return; }
    onToast('기관이 종료됐습니다(행은 남김).');
    setShowDeleteModal(false);
  };

  // 기관 전용 로그인 화면(2026-11-17 — 예전엔 없는 주소 /org/{slug}를 복사했다)
  const signInPath = orgSignInPath(org.slug);
  const copyUrl = async () => {
    if (!signInPath) return;
    await navigator.clipboard.writeText(`${window.location.origin}${signInPath}`);
    onToast('링크가 복사됐습니다.');
  };

  return (
    <div className="space-y-6">
      {/* 기본 정보 그리드 */}
      <div className="grid grid-cols-2 gap-4">
        <InfoCard title="기관 정보">
          <InfoRow label="기관명"   value={org.name} />
          <InfoRow label="Slug"    value={org.slug} mono />
          <InfoRow label="유형"    value={org.type} />
          <InfoRow label="등록일"  value={fmtDate(org.created_at)} />
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-slate-500 w-20 flex-shrink-0">로그인 주소</span>
            <span className="text-xs text-slate-300 font-mono truncate flex-1">{signInPath ?? '없음 — 기관 관리자 \'기관 정보\'에서 정함'}</span>
            {signInPath && <button onClick={copyUrl} className="text-xs text-[#A78BFA] hover:text-violet-300 flex-shrink-0">복사</button>}
          </div>
        </InfoCard>

        <InfoCard title="계약 정보">
          <InfoRow label="플랜"     value={(org.plan ?? 'trial').toUpperCase()} />
          <InfoRow label="월이용료" value={org.contracts?.[0]?.price_per_month ? `${Number(org.contracts[0].price_per_month).toLocaleString()}원` : '—'} />
          <InfoRow label="계약시작" value={fmtDate(org.contracts?.[0]?.started_at)} />
          <InfoRow label="계약종료" value={org.contracts?.[0]?.expires_at ? fmtDate(org.contracts[0].expires_at) : '무기한'} />
          <InfoRow label="담당자"   value={org.contact_name ?? '—'} />
        </InfoCard>
      </div>

      {/* 한도 현황 */}
      <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl p-6 space-y-5">
        <h3 className="text-sm font-bold text-white">한도 현황</h3>
        <LimitBar label="사용자(활성 — 상한을 넘으면 새 계정을 만들지 못함)" current={org.user_count ?? null} max={org.max_users ?? 0} unit="명" pct={userPct}  color={progressColor(userPct)} />
        <LimitBar label="비서(표시만 — 상한을 아직 막지 않음)" current={org.agent_count ?? null} max={org.max_agents ?? 0} unit="개" pct={agentPct} color={progressColor(agentPct)} />
        <LimitBar label="이번달 토큰"  current={org.tokens_this_month ?? null}     max={org.monthly_token_limit ?? 0}  unit=""   pct={tokenPct} color={progressColor(tokenPct)} fmtFn={fmt} />
      </div>

      {/* 관리자 초대 링크 */}
      <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-white">관리자 초대 링크</h3>
          <button onClick={() => setShowNewInvite(v => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-[#7C3AED]/20 hover:bg-[#7C3AED]/40 text-violet-300 text-xs font-semibold rounded-lg transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4"/></svg>
            새 초대 링크 생성
          </button>
        </div>

        {/* 새 초대 생성 폼 */}
        {showNewInvite && (
          <div className="flex gap-2 p-3 bg-[#0F172A] rounded-xl border border-slate-700">
            <input value={inviteEmail} onChange={e => setInviteEmail(e.target.value)}
              type="email" placeholder="admin@org.go.kr"
              className="flex-1 px-3 py-2 bg-transparent text-sm text-white placeholder-slate-500 focus:outline-none" />
            <button onClick={handleNewInvite} disabled={inviting || !inviteEmail.trim()}
              className="px-4 py-2 bg-[#7C3AED] hover:bg-[#6D28D9] disabled:bg-slate-700 text-white text-xs font-semibold rounded-lg transition-colors">
              {inviting ? '생성 중...' : '생성'}
            </button>
            <button onClick={() => setShowNewInvite(false)}
              className="px-3 py-2 border border-slate-700 text-slate-400 text-xs rounded-lg hover:text-white">
              취소
            </button>
          </div>
        )}

        {/* 초대 링크 목록 */}
        {invitations.length === 0 ? (
          <p className="text-xs text-slate-500">아직 초대 링크가 없습니다. [새 초대 링크 생성]을 눌러 관리자를 초대하세요.</p>
        ) : (
          <div className="space-y-2">
            {invitations.map(inv => (
              <InviteRow key={inv.id} inv={inv} onCopy={() => onToast('링크가 복사됐습니다.')} />
            ))}
          </div>
        )}
      </div>

      {/* 위험 구역 */}
      <div className="bg-red-950/20 border border-red-900/30 rounded-2xl p-6 space-y-3">
        <h3 className="text-sm font-bold text-red-400">⚠️ 위험 구역</h3>
        <div className="flex gap-3">
          {org.status === 'active' ? (
            <button
              onClick={onSuspend}
              className="px-4 py-2 bg-amber-900/40 hover:bg-amber-900/60 border border-amber-700/50 text-amber-400 text-sm font-medium rounded-xl transition-colors">
              기관 정지
            </button>
          ) : null}
          <button onClick={() => setShowDeleteModal(true)}
            className="px-4 py-2 bg-red-900/40 hover:bg-red-900/60 border border-red-700/50 text-red-400 text-sm font-medium rounded-xl transition-colors">
            기관 삭제
          </button>
        </div>
      </div>

      {/* 삭제 확인 모달 */}
      {showDeleteModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
          <div className="bg-[#1E293B] border border-slate-700 rounded-2xl p-6 w-full max-w-sm">
            <h3 className="text-base font-bold text-white mb-2">기관 삭제 확인</h3>
            <p className="text-sm text-slate-400 mb-4">
              삭제를 확인하려면 기관명 <span className="text-white font-semibold">{org.name}</span>을 입력하세요.
            </p>
            <input value={deleteInput} onChange={e => setDeleteInput(e.target.value)}
              placeholder={org.name}
              className="w-full px-4 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white mb-4 focus:outline-none focus:border-red-500" />
            <div className="flex gap-3">
              <button onClick={() => setShowDeleteModal(false)}
                className="flex-1 py-2.5 border border-slate-700 rounded-xl text-sm text-slate-400 hover:text-white transition-colors">취소</button>
              <button onClick={handleDelete} disabled={deleteInput !== org.name}
                className="flex-1 py-2.5 bg-red-600 hover:bg-red-700 disabled:bg-slate-700 disabled:cursor-not-allowed text-white font-semibold rounded-xl text-sm transition-colors">삭제</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InfoCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl p-5 space-y-3">
      <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider">{title}</h3>
      {children}
    </div>
  );
}
function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-slate-500 w-20 flex-shrink-0">{label}</span>
      <span className={`text-sm text-slate-200 ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}
function LimitBar({ label, current, max, unit, pct, color, fmtFn }: {
  label: string; current: number | null; max: number; unit: string;
  pct: number; color: string; fmtFn?: (n: number) => string;
}) {
  const fmtN = fmtFn ?? ((n: number) => String(n));
  const f = (n: number | null) => (n === null ? '—' : fmtN(n));
  return (
    <div>
      <div className="flex justify-between text-xs mb-1.5">
        <span className="text-slate-400">{label}</span>
        <span className={pct >= 90 ? 'text-red-400 font-semibold' : 'text-slate-400'}>
          {f(current)} / {f(max)}{unit}
        </span>
      </div>
      <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ─── 2. 사용자 탭 ────────────────────────────────────────────
function UsersTab({ orgId }: { orgId: string }) {
  const [users, setUsers]   = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const fetch_ = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ search });
    try {
      const res  = await fetch(`/api/super/organizations/${orgId}/users?${params}`);
      const data = await res.json().catch(() => null);
      // 못 읽으면 '사용자가 없습니다'가 아니라 실패로 보인다(2026-11-19)
      if (res.ok && data?.ok) { setUsers(data.data); setLoadError(false); }
      else { setUsers([]); setLoadError(true); }
    } catch { setUsers([]); setLoadError(true); }
    finally { setLoading(false); }
  }, [orgId, search]);

  useEffect(() => { fetch_(); }, [fetch_]);

  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="이름 또는 이메일 검색..."
          className="flex-1 px-4 py-2.5 bg-[#1E293B] border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-[#7C3AED]"
          onKeyDown={e => e.key === 'Enter' && !isImeComposing(e) && fetch_()} />
        <button onClick={fetch_} className="px-5 py-2.5 bg-[#7C3AED] text-white text-sm font-semibold rounded-xl hover:bg-[#6D28D9] transition-colors">검색</button>
      </div>
      <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-700/50">
            <tr>
              {['이름', '이메일', '부서', '권한', '직책', '가입일'].map(h => (
                <th key={h} className="px-5 py-3 text-left text-xs font-semibold text-slate-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/30">
            {loading ? (
              Array.from({length:3}).map((_,i) => (
                <tr key={i}>{Array.from({length:6}).map((_,j) => <td key={j} className="px-5 py-4"><div className="h-3 bg-slate-700/50 rounded animate-pulse" /></td>)}</tr>
              ))
            ) : loadError ? (
              <tr><td colSpan={6} className="px-5 py-10 text-center text-red-400">사용자 목록을 불러오지 못했습니다. 잠시 뒤 다시 검색해 주세요.</td></tr>
            ) : users.length === 0 ? (
              <tr><td colSpan={6} className="px-5 py-10 text-center text-slate-500">사용자가 없습니다.</td></tr>
            ) : (
              users.map(u => (
                <tr key={u.id} className="hover:bg-slate-700/20 transition-colors">
                  <td className="px-5 py-3.5 font-medium text-white">{u.full_name || '(이름 없음)'}</td>
                  <td className="px-5 py-3.5 text-slate-400">{u.email}</td>
                  <td className="px-5 py-3.5 text-slate-400">{u.department_name}</td>
                  <td className="px-5 py-3.5">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${u.role === 'ADMIN' ? 'bg-purple-900/40 text-purple-400' : 'bg-slate-700 text-slate-400'}`}>
                      {u.role === 'ADMIN' ? '관리자' : '직원'}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-slate-500 text-xs">{u.position ?? '—'}</td>
                  <td className="px-5 py-3.5 text-slate-500 text-xs">{fmtDate(u.created_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-600">총 {users.length}명</p>
    </div>
  );
}

// ─── 3. 사용량 탭 ────────────────────────────────────────────
const PERIODS = [
  { key: 'month', label: '이번달' }, { key: 'last_month', label: '지난달' },
  { key: '3months', label: '3개월' }, { key: '6months', label: '6개월' },
];

function UsageTab({ orgId }: { orgId: string }) {
  const [period, setPeriod] = useState('month');
  const [data, setData]     = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/super/organizations/${orgId}/usage?period=${period}`)
      .then(r => r.json()).then(d => { if (d.ok) setData(d.data); }).finally(() => setLoading(false));
  }, [orgId, period]);

  const s = data?.summary ?? {};

  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        {PERIODS.map(p => (
          <button key={p.key} onClick={() => setPeriod(p.key)}
            className={`px-4 py-2 text-xs font-semibold rounded-lg transition-colors ${period === p.key ? 'bg-[#7C3AED] text-white' : 'bg-[#1E293B] text-slate-400 border border-slate-700 hover:border-[#7C3AED]'}`}>
            {p.label}
          </button>
        ))}
      </div>

      {/* 요약 카드 */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: '총 대화', value: loading ? '—' : s.conversations?.toLocaleString() ?? '0', icon: '💬' },
          { label: '총 토큰', value: loading ? '—' : fmt(s.totalTokens ?? 0), icon: '🔤' },
          { label: '활성 사용자', value: loading ? '—' : `${s.activeUsers ?? 0}명`, icon: '👤' },
          { label: '예상 비용', value: loading ? '—' : `$${s.costUsd ?? 0}`, icon: '💰' },
        ].map(c => (
          <div key={c.label} className="bg-[#1E293B] border border-slate-700/50 rounded-2xl p-5">
            <div className="text-2xl mb-3">{c.icon}</div>
            <p className="text-xl font-bold text-white">{c.value}</p>
            <p className="text-xs text-slate-500 mt-0.5">{c.label}</p>
          </div>
        ))}
      </div>

      {/* 일별 대화 차트 */}
      <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl p-6">
        <h3 className="text-sm font-bold text-white mb-4">일별 대화 수</h3>
        {loading ? (
          <div className="h-48 flex items-center justify-center"><div className="w-6 h-6 border-2 border-[#7C3AED]/30 border-t-[#7C3AED] rounded-full animate-spin" /></div>
        ) : (
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={data?.dailyChart ?? []} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="date" tickFormatter={d => d.slice(5)} tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} />
              <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} />
              <Tooltip
                formatter={(v) => [`${v ?? 0}건`, '대화']}
                contentStyle={{ background: '#1E293B', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: '#94a3b8' }}
              />
              <Line type="monotone" dataKey="conversations" stroke="#7C3AED" strokeWidth={2} dot={{ r: 2, fill: '#7C3AED' }} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Top 5 사용자 */}
      {(data?.topUsers?.length ?? 0) > 0 && (
        <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl p-6">
          <h3 className="text-sm font-bold text-white mb-4">사용자별 토큰 Top 5</h3>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={data.topUsers} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} />
              <YAxis tickFormatter={fmt} tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} />
              <Tooltip
                formatter={(v) => [fmt(Number(v ?? 0)), '토큰']}
                contentStyle={{ background: '#1E293B', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }}
              />
              <Bar dataKey="tokens" fill="#7C3AED" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// ─── 4. API 키 탭 ────────────────────────────────────────────
function ApiKeysTab({ orgId, onToast }: { orgId: string; onToast: (m: string) => void }) {
  const [keyData, setKeyData]     = useState<any>(null);
  const [loading, setLoading]     = useState(true);
  const [editing, setEditing]     = useState<string | null>(null);
  const [inputVal, setInputVal]   = useState('');
  const [saving, setSaving]       = useState(false);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<Record<string, boolean | null>>({});
  const [useSystem, setUseSystem] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/super/organizations/${orgId}/api-keys`);
      const d   = await res.json().catch(() => null);
      if (res.ok && d?.ok) { setKeyData(d.data); setUseSystem(d.data.useSystemDefault); }
      else onToast(typeof d?.error === 'string' ? d.error : 'API 키 상태를 불러오지 못했습니다.');
    } catch { onToast('API 키 상태를 불러오지 못했습니다.'); }
    finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  const handleToggleSystem = async (val: boolean) => {
    setUseSystem(val);
    if (val) {
      const res = await fetch(`/api/super/organizations/${orgId}/api-keys`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useSystemDefault: true }),
      }).catch(() => null);
      const d = res ? await res.json().catch(() => null) : null;
      if (res?.ok && d?.ok) onToast('이 기관의 키를 더 보관하지 않습니다.');
      else { onToast(typeof d?.error === 'string' ? d.error : '바꾸지 못했습니다.'); load(); }
    }
  };

  const handleSave = async (provider: string) => {
    if (!inputVal.trim()) return;
    setSaving(true);
    const res = await fetch(`/api/super/organizations/${orgId}/api-keys`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, keyValue: inputVal }),
    });
    const d = await res.json().catch(() => null);
    if (res.ok && d?.ok) { onToast('API 키가 저장됐습니다.'); setEditing(null); setInputVal(''); load(); }
    else onToast(typeof d?.error === 'string' ? d.error : '저장에 실패했습니다.');
    setSaving(false);
  };

  const handleVerify = async (provider: string, key?: string) => {
    setVerifying(provider);
    const res = await fetch(`/api/super/organizations/${orgId}/verify-key`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyType: provider, key: key ?? inputVal }),
    });
    const d = await res.json();
    setVerifyResult(r => ({ ...r, [provider]: d.valid }));
    setVerifying(null);
  };

  if (loading) return <div className="flex justify-center py-12"><div className="w-6 h-6 border-2 border-[#7C3AED]/30 border-t-[#7C3AED] rounded-full animate-spin" /></div>;

  return (
    <div className="space-y-6">
      {/* 시스템 키 토글 */}
      <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-white">기관 키 보관 안 함</p>
            <p className="text-xs text-slate-500 mt-0.5">ON: 이 기관의 키를 보관하지 않음 · OFF: 이 기관의 키를 보관함</p>
            <p className="text-xs text-amber-400/80 mt-1">{STORED_KEYS_NOT_USED_NOTICE}</p>
          </div>
          <button onClick={() => handleToggleSystem(!useSystem)}
            className={`w-12 h-6 rounded-full transition-colors relative ${useSystem ? 'bg-[#7C3AED]' : 'bg-slate-700'}`}>
            <div className={`w-5 h-5 bg-white rounded-full absolute top-0.5 transition-transform ${useSystem ? 'translate-x-6' : 'translate-x-0.5'}`} />
          </button>
        </div>
      </div>

      {/* 키 입력 섹션 */}
      {!useSystem && (
        <div className="space-y-4">
          {[
            // 옛 Voyage 키 칸은 지웠다(쓰지 않는 업체 — api-key-providers.ts)
            { provider: 'anthropic', label: 'Anthropic API Key', placeholder: 'sk-ant-...' },
          ].map(({ provider, label, placeholder }) => {
            const existing = keyData?.[provider];
            const isEditing = editing === provider;
            const vr = verifyResult[provider];
            return (
              <div key={provider} className="bg-[#1E293B] border border-slate-700/50 rounded-2xl p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-white">{label}</p>
                  {existing?.hasKey && (
                    <span className="text-xs text-emerald-400">✓ 키 등록됨</span>
                  )}
                </div>
                {isEditing ? (
                  <div className="space-y-2">
                    <input value={inputVal} onChange={e => setInputVal(e.target.value)}
                      placeholder={placeholder}
                      className="w-full px-4 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white font-mono placeholder-slate-600 focus:outline-none focus:border-[#7C3AED]" />
                    <div className="flex gap-2">
                      <button onClick={() => handleVerify(provider)} disabled={!inputVal || verifying === provider}
                        className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50">
                        {verifying === provider ? '검증 중...' : '키 검증'}
                      </button>
                      {vr !== undefined && (
                        <span className={`text-xs flex items-center gap-1 ${vr ? 'text-emerald-400' : 'text-red-400'}`}>
                          {vr ? '✅ 유효한 키' : '❌ 유효하지 않은 키'}
                        </span>
                      )}
                      <button onClick={() => handleSave(provider)} disabled={saving || !inputVal}
                        className="px-4 py-2 bg-[#7C3AED] hover:bg-[#6D28D9] text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-50 ml-auto">
                        {saving ? '저장 중...' : '저장'}
                      </button>
                      <button onClick={() => { setEditing(null); setInputVal(''); setVerifyResult(r => ({ ...r, [provider]: undefined as any })); }}
                        className="px-4 py-2 border border-slate-700 text-slate-400 text-xs rounded-lg hover:text-white transition-colors">
                        취소
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <code className="flex-1 text-xs text-slate-400 font-mono">
                      {existing?.masked || '(미설정)'}
                    </code>
                    <button onClick={() => { setEditing(provider); setInputVal(''); }}
                      className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-xs rounded-lg transition-colors">
                      수정
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── 5. 계약 탭 ──────────────────────────────────────────────
function ContractsTab({ orgId, onToast }: { orgId: string; onToast: (m: string) => void }) {
  const [contracts, setContracts] = useState<any[]>([]);
  const [loading, setLoading]     = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm]           = useState({ plan: 'basic', startDate: kstDay(), endDate: '', fee: PLANS.basic.monthlyFee as number, notes: '' });
  const [saving, setSaving]       = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/super/organizations/${orgId}`);
    const d   = await res.json();
    if (d.ok) setContracts(d.data.contracts ?? []);
    setLoading(false);
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  const active = contracts.find(c => c.status === 'active');
  const daysLeft = active?.expires_at
    ? Math.ceil((new Date(active.expires_at).getTime() - Date.now()) / 86400000) : null;

  // 계약 화면과 같은 계약 만들기(`POST /api/super/contracts`)로 — 예전엔 기관의 요금제 이름만 바꾸고
  // 시작일·종료일·이용료는 버린 채 '계약이 업데이트됐습니다'라고 알렸다(계약도·한도도 그대로, 2026-11-19)
  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch('/api/super/contracts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgId, planType: form.plan, monthlyFee: form.fee,
          startDate: form.startDate || null, endDate: form.endDate || null, notes: form.notes || null,
        }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.ok) { onToast(typeof d?.error === 'string' ? d.error : '계약을 저장하지 못했습니다.'); return; }
      if (d.warning) alert(d.warning);
      onToast('새 계약을 저장했습니다. 앞 계약은 끝났습니다.');
      setShowModal(false); load();
    } catch {
      onToast('계약을 저장하지 못했습니다.');
    } finally {
      setSaving(false);
    }
  };

  const PLAN_PRESETS_FEE: Record<string, number> = Object.fromEntries(Object.entries(PLANS).map(([k, p]) => [k, p.monthlyFee]));

  return (
    <div className="space-y-6">
      {/* 현재 계약 */}
      {active && (
        <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-bold text-white">현재 계약</h3>
            <button onClick={() => setShowModal(true)}
              className="px-4 py-2 bg-[#7C3AED] hover:bg-[#6D28D9] text-white text-xs font-semibold rounded-xl transition-colors">
              새 계약으로 바꾸기
            </button>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <InfoRow label="플랜"    value={(active.plan ?? '').toUpperCase()} />
            <InfoRow label="월이용료" value={`${Number(active.price_per_month ?? 0).toLocaleString()}원`} />
            <InfoRow label="시작일"  value={fmtDate(active.started_at)} />
            <InfoRow label="종료일"  value={active.expires_at ? fmtDate(active.expires_at) : '무기한'} />
          </div>
          {daysLeft !== null && (
            <div className={`mt-4 text-center py-2 rounded-xl text-sm font-bold ${daysLeft <= 30 ? 'bg-amber-900/30 text-amber-400' : 'bg-emerald-900/20 text-emerald-400'}`}>
              {daysLeft > 0 ? `D-${daysLeft} 남음` : '계약 만료'}
            </div>
          )}
        </div>
      )}

      {/* 계약 이력 */}
      <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700/50">
          <h3 className="text-sm font-bold text-white">계약 이력</h3>
          <button onClick={() => setShowModal(true)}
            className="text-xs text-[#A78BFA] hover:text-violet-300">+ 새 계약 추가</button>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-700/50">
              {['플랜', '금액', '시작일', '종료일', '상태'].map(h => (
                <th key={h} className="px-5 py-3 text-left text-xs font-semibold text-slate-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/30">
            {loading ? (
              <tr><td colSpan={5} className="px-5 py-8 text-center"><div className="w-5 h-5 border-2 border-[#7C3AED]/30 border-t-[#7C3AED] rounded-full animate-spin mx-auto" /></td></tr>
            ) : contracts.length === 0 ? (
              <tr><td colSpan={5} className="px-5 py-8 text-center text-slate-500">계약 이력이 없습니다.</td></tr>
            ) : (
              contracts.map((c, i) => (
                <tr key={i} className="hover:bg-slate-700/20 transition-colors">
                  <td className="px-5 py-3.5 text-white font-medium">{(c.plan ?? '').toUpperCase()}</td>
                  <td className="px-5 py-3.5 text-slate-400">{Number(c.price_per_month ?? 0).toLocaleString()}원</td>
                  <td className="px-5 py-3.5 text-slate-400 text-xs">{fmtDate(c.started_at)}</td>
                  <td className="px-5 py-3.5 text-slate-400 text-xs">{c.expires_at ? fmtDate(c.expires_at) : '무기한'}</td>
                  <td className="px-5 py-3.5">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${c.status === 'active' ? 'bg-emerald-900/40 text-emerald-400' : 'bg-slate-700 text-slate-400'}`}>
                      {c.status === 'active' ? '활성' : c.status}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* 계약 추가 모달 */}
      {showModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
          <div className="bg-[#1E293B] border border-slate-700 rounded-2xl p-6 w-full max-w-md">
            <h3 className="text-base font-bold text-white mb-2">새 계약</h3>
            <p className="text-xs text-slate-400 mb-5">저장하면 지금 계약은 끝나고 이 계약이 시작됩니다. 기관 한도는 요금제에 맞춰집니다.</p>
            <form onSubmit={handleAdd} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">요금제</label>
                <div className="grid grid-cols-4 gap-2">
                  {Object.keys(PLAN_PRESETS_FEE).map(p => (
                    <button key={p} type="button" onClick={() => setForm(f => ({ ...f, plan: p, fee: PLAN_PRESETS_FEE[p] }))}
                      className={`py-2 rounded-lg text-xs font-semibold transition-colors ${form.plan === p ? 'bg-[#7C3AED] text-white' : 'bg-[#0F172A] text-slate-400 border border-slate-700'}`}>
                      {p.charAt(0).toUpperCase() + p.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">시작일</label>
                  <input type="date" value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))}
                    className="w-full px-3 py-2.5 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">종료일</label>
                  <input type="date" value={form.endDate} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))}
                    className="w-full px-3 py-2.5 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">월 이용료 (원)</label>
                <input type="number" value={form.fee} onChange={e => setForm(f => ({ ...f, fee: Number(e.target.value) }))} min={0}
                  className="w-full px-3 py-2.5 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]" />
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowModal(false)}
                  className="flex-1 py-2.5 border border-slate-700 rounded-xl text-sm text-slate-400 hover:text-white transition-colors">취소</button>
                <button type="submit" disabled={saving}
                  className="flex-1 py-2.5 bg-[#7C3AED] hover:bg-[#6D28D9] disabled:bg-slate-700 text-white font-semibold rounded-xl text-sm transition-colors">
                  {saving ? '저장 중...' : '저장'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 초대 링크 행 컴포넌트 ───────────────────────────────────
function InviteRow({ inv, onCopy }: { inv: any; onCopy: () => void }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(inv.inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    onCopy();
  };

  const statusBadge = inv.isAccepted
    ? <span className="px-2 py-0.5 bg-emerald-900/40 text-emerald-400 text-xs rounded-full">수락됨</span>
    : inv.isExpired
    ? <span className="px-2 py-0.5 bg-red-900/40 text-red-400 text-xs rounded-full">만료됨</span>
    : <span className="px-2 py-0.5 bg-amber-900/40 text-amber-400 text-xs rounded-full">대기 중</span>;

  return (
    <div className="p-3 bg-[#0F172A] rounded-xl border border-slate-700 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-semibold text-white truncate">{inv.email}</span>
          <span className="text-xs text-slate-500">{inv.role}</span>
          {statusBadge}
        </div>
        <span className="text-[10px] text-slate-600 flex-shrink-0">
          {new Date(inv.expires_at).toLocaleDateString('ko-KR')} 만료
        </span>
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-[11px] text-slate-400 font-mono truncate">{inv.inviteUrl}</code>
        <button onClick={handleCopy}
          className={`flex-shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
            copied ? 'bg-emerald-700 text-white' : 'bg-slate-700 hover:bg-slate-600 text-white'
          }`}>
          {copied ? '✓ 복사됨' : '복사'}
        </button>
      </div>
    </div>
  );
}
