'use client';

import { useState, useEffect, useCallback } from 'react';
import { isImeComposing } from '@/lib/ime';
import { lockUntilLabel, normalizeIp } from '@/lib/sign-in-lock-spec';
import { passwordPolicyError } from '@/lib/password-policy';

type Tab = 'users' | 'superadmins';

const fmtDate = (s?: string) => s ? new Date(s).toLocaleDateString('ko-KR') : '—';

function CopyBtn({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={async () => { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      className={`px-2 py-0.5 text-xs rounded font-mono transition-colors ${copied ? 'bg-emerald-700 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-300'}`}>
      {copied ? '✓' : '복사'}
    </button>
  );
}

// ═══════════════════════════════════════════════════════════
export default function AccountsPage() {
  const [tab, setTab] = useState<Tab>('users');
  const [toast, setToast] = useState<string | null>(null);
  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000); };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">계정 관리</h1>
        <p className="text-slate-400 text-sm mt-1">전체 사용자 및 슈퍼관리자 계정 관리</p>
      </div>

      <div className="flex gap-1 border-b border-slate-700/50">
        {([['users','전체 사용자'],['superadmins','슈퍼관리자 계정']] as [Tab,string][]).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2.5 text-sm font-semibold rounded-t-lg transition-colors border-b-2 ${tab === k ? 'border-[#7C3AED] text-[#A78BFA] bg-[#7C3AED]/10' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
            {label}
          </button>
        ))}
      </div>

      <IpLockPanel onToast={showToast} />

      {tab === 'users'      && <UsersTab onToast={showToast} />}
      {tab === 'superadmins' && <SuperAdminsTab onToast={showToast} />}

      {toast && (
        <div className="fixed bottom-6 right-6 px-5 py-3 bg-[#7C3AED] text-white text-sm font-semibold rounded-xl shadow-lg z-50">{toast}</div>
      )}
    </div>
  );
}

// ─── IP 로그인 잠금(2026-11-17) ──────────────────────────────
// 한 IP가 30분에 30번 틀리면 그 IP를 막는다. 기관 전체가 바깥 IP 하나를 함께 쓰면 기관 전체가 못 들어오므로, IP를 넣어 확인하고 푼다.
// IP는 해시로만 남아 목록은 없다 — 기관 담당자에게 그 기관의 바깥 IP를 받아 넣는다.
function IpLockPanel({ onToast }: { onToast: (m: string) => void }) {
  const [ip, setIp] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ip: string; failures: number; lockedUntil: string | null } | null>(null);
  const valid = normalizeIp(ip) !== null;

  const check = async () => {
    if (!valid) { onToast('IP 주소 꼴이 아닙니다(예: 203.0.113.5).'); return; }
    setBusy(true);
    try {
      const res = await fetch(`/api/super/sign-in-ip-lock?ip=${encodeURIComponent(ip.trim())}`);
      const data = await res.json();
      if (data.ok) setStatus(data.data); else onToast(data.error?.message ?? '확인 실패');
    } finally { setBusy(false); }
  };
  const unlock = async () => {
    if (!confirm(`${ip.trim()}의 로그인 실패 기록을 지워 잠금을 풀까요?
그 IP로 들어오는 모든 계정의 실패 수도 함께 지워집니다.`)) return;
    setBusy(true);
    try {
      const res = await fetch('/api/super/sign-in-ip-lock', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip: ip.trim() }) });
      const data = await res.json();
      if (data.ok) { onToast(`IP 잠금을 풀었습니다(실패 기록 ${data.data.cleared}건 지움).`); setStatus(null); }
      else onToast(data.error?.message ?? '잠금 풀기 실패');
    } finally { setBusy(false); }
  };

  return (
    <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-slate-200">IP 로그인 잠금</span>
        <span className="text-xs text-slate-500">한 IP가 30분에 30번 틀리면 그 IP의 로그인을 30분 막습니다.</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input value={ip} onChange={(e) => { setIp(e.target.value); setStatus(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !isImeComposing(e)) check(); }}
          placeholder="기관의 바깥 IP (예: 203.0.113.5)"
          className="w-64 px-3 py-1.5 text-sm bg-slate-900 border border-slate-700 rounded-lg text-slate-200 placeholder-slate-600" />
        <button onClick={check} disabled={busy || !valid}
          className="px-3 py-1.5 text-sm rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-40">확인</button>
        {status && (
          status.lockedUntil ? (
            <>
              <span className="text-sm text-amber-300">{status.ip} 잠김 · {lockUntilLabel(status.lockedUntil)} (30분 안 실패 {status.failures}번)</span>
              <button onClick={unlock} disabled={busy}
                className="px-3 py-1.5 text-sm rounded-lg bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-40">잠금 풀기</button>
            </>
          ) : (
            <span className="text-sm text-slate-400">{status.ip} 잠기지 않음 (30분 안 실패 {status.failures}번)</span>
          )
        )}
      </div>
    </div>
  );
}

// ─── 전체 사용자 탭 ──────────────────────────────────────────
function UsersTab({ onToast }: { onToast: (m: string) => void }) {
  const [users, setUsers]   = useState<any[]>([]);
  const [orgs, setOrgs]     = useState<any[]>([]);
  const [meta, setMeta]     = useState({ total: 0, newThisMonth: 0 });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterOrg, setFilterOrg]   = useState('');
  const [filterRole, setFilterRole] = useState('all');
  const [page, setPage]     = useState(1);
  const LIMIT = 30;

  const fetchOrgs = useCallback(async () => {
    const res  = await fetch('/api/super/organizations?limit=100');
    const data = await res.json();
    if (data.ok) setOrgs(data.data);
  }, []);

  const fetchUsers = useCallback(async (p = 1) => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(p), limit: String(LIMIT) });
    if (search)           params.set('search', search);
    if (filterOrg)        params.set('orgId', filterOrg);
    if (filterRole !== 'all') params.set('role', filterRole);
    const res  = await fetch(`/api/super/accounts/users?${params}`);
    const data = await res.json();
    if (data.ok) { setUsers(data.data); setMeta({ total: data.meta.total, newThisMonth: data.meta.newThisMonth }); }
    setLoading(false);
  }, [search, filterOrg, filterRole]);

  useEffect(() => { fetchOrgs(); }, [fetchOrgs]);
  useEffect(() => { fetchUsers(1); setPage(1); }, [fetchUsers]);

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string; email: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handlePatch = async (id: string, body: object) => {
    const res  = await fetch(`/api/super/accounts/users/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.ok) { fetchUsers(page); onToast('변경됐습니다.'); }
    else onToast(data.error);
  };

  const handleUnlock = async (id: string) => {
    const res  = await fetch(`/api/super/accounts/users/${id}/sign-in-lock`, { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) { fetchUsers(page); onToast('로그인 잠금을 풀었습니다.'); }
    else onToast(data.error?.message ?? '잠금 풀기 실패');
  };

  // 임시 비밀번호 재발급 — 새 비밀번호는 이 화면에 한 번만 보인다(저장하지 않음)
  const [resetInfo, setResetInfo] = useState<{ email: string; tempPassword: string; emailSent: boolean } | null>(null);
  const handleResetPassword = async (id: string, email: string) => {
    if (!confirm(`${email}의 임시 비밀번호를 다시 발급할까요?\n지금 비밀번호와 열려 있는 로그인은 모두 쓸 수 없게 되고, 다음 로그인에 비밀번호부터 바꿔야 합니다.`)) return;
    const res  = await fetch(`/api/super/accounts/users/${id}/password-reset`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) { setResetInfo({ email, tempPassword: data.data.tempPassword, emailSent: Boolean(data.data.emailSent) }); fetchUsers(page); }
    else onToast(data.error?.message ?? '재발급 실패');
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const res  = await fetch(`/api/super/accounts/users/${deleteTarget.id}`, { method: 'DELETE' });
    const data = await res.json();
    setDeleting(false);
    setDeleteTarget(null);
    if (data.ok) { fetchUsers(page); onToast('계정이 삭제됐습니다.'); }
    else onToast(data.error?.message ?? '삭제 실패');
  };

  const activeCount   = users.filter(u => u.is_active !== false).length;
  const inactiveCount = users.filter(u => u.is_active === false).length;
  const totalPages    = Math.ceil(meta.total / LIMIT);

  const STATS = [
    { label: '전체 사용자',   value: meta.total,       icon: '👥' },
    { label: '이번달 신규',   value: meta.newThisMonth, icon: '✨' },
    { label: '활성 사용자',   value: activeCount,       icon: '🟢' },
    { label: '비활성 사용자', value: inactiveCount,     icon: '⚫' },
  ];

  return (
    <div className="space-y-5">
      {resetInfo && (
        <div className="bg-amber-900/20 border border-amber-700/50 rounded-2xl p-4 text-sm text-amber-200 space-y-2">
          <p className="font-semibold">{resetInfo.email}의 임시 비밀번호를 발급했습니다</p>
          <div className="flex items-center gap-2">
            <code className="px-2 py-1 bg-slate-900 rounded font-mono text-base text-white">{resetInfo.tempPassword}</code>
            <CopyBtn value={resetInfo.tempPassword} />
          </div>
          <p className="text-xs text-amber-300/80">
            {resetInfo.emailSent ? '본인 메일로도 보냈습니다. ' : '메일 발송이 설정돼 있지 않아 직접 전해 주세요. '}
            이 안내를 닫으면 다시 볼 수 없습니다. 직원은 다음 로그인에 비밀번호부터 바꿉니다.
          </p>
          <button onClick={() => setResetInfo(null)} className="text-xs text-amber-400 hover:text-amber-200">닫기</button>
        </div>
      )}
      {/* 통계 카드 */}
      <div className="grid grid-cols-4 gap-4">
        {STATS.map(s => (
          <div key={s.label} className="bg-[#1E293B] border border-slate-700/50 rounded-2xl p-4">
            <span className="text-xl">{s.icon}</span>
            <p className="text-2xl font-bold text-white mt-2">{s.value.toLocaleString()}</p>
            <p className="text-xs text-slate-500">{s.label}</p>
          </div>
        ))}
      </div>

      {/* 검색/필터 */}
      <div className="flex flex-wrap gap-3">
        <div className="flex-1 min-w-[180px] relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="이름 또는 이메일..."
            className="w-full pl-10 pr-4 py-2.5 bg-[#1E293B] border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-[#7C3AED]"
            onKeyDown={e => e.key === 'Enter' && !isImeComposing(e) && fetchUsers(1)} />
        </div>
        <select value={filterOrg} onChange={e => setFilterOrg(e.target.value)}
          className="px-3 py-2.5 bg-[#1E293B] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]">
          <option value="">기관 전체</option>
          {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <select value={filterRole} onChange={e => setFilterRole(e.target.value)}
          className="px-3 py-2.5 bg-[#1E293B] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]">
          <option value="all">권한 전체</option>
          <option value="ADMIN">관리자</option>
          <option value="USER">일반 직원</option>
        </select>
        <button onClick={() => fetchUsers(1)} className="px-5 py-2.5 bg-[#7C3AED] hover:bg-[#6D28D9] text-white text-sm font-semibold rounded-xl">검색</button>
      </div>

      {/* 테이블 */}
      <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-700/50">
            <tr>
              {['이름', '이메일', '기관', '부서', '권한', '가입일', '상태', '관리'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/30">
            {loading ? (
              Array.from({length:5}).map((_,i) => (
                <tr key={i}>{Array.from({length:8}).map((_,j) => (
                  <td key={j} className="px-4 py-3"><div className="h-3 bg-slate-700/50 rounded animate-pulse"/></td>
                ))}</tr>
              ))
            ) : users.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-10 text-center text-slate-500">사용자가 없습니다.</td></tr>
            ) : (
              users.map(u => (
                <tr key={u.id} className={`hover:bg-slate-700/20 transition-colors ${u.is_active === false ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-3 font-medium text-white">{u.full_name || '—'}</td>
                  <td className="px-4 py-3 text-slate-400 text-xs">{u.email}</td>
                  <td className="px-4 py-3 text-slate-400 text-xs">{u.organization_name}</td>
                  <td className="px-4 py-3 text-slate-500 text-xs">{u.department_name}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${u.role === 'ADMIN' ? 'bg-purple-900/40 text-purple-400' : 'bg-slate-700 text-slate-400'}`}>
                      {u.role === 'ADMIN' ? '관리자' : '직원'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-xs">{fmtDate(u.created_at)}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs ${u.is_active !== false ? 'bg-emerald-900/30 text-emerald-400' : 'bg-slate-700 text-slate-500'}`}>
                      {u.is_active !== false ? '활성' : '비활성'}
                    </span>
                    {u.sign_in_locked_until && (
                      <span className="ml-1 px-2 py-0.5 rounded-full text-xs bg-red-900/30 text-red-400" title="로그인을 30분 안에 5번 틀려 잠겼습니다">
                        잠김 · {lockUntilLabel(u.sign_in_locked_until)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1.5">
                      {u.sign_in_locked_until && (
                        <button
                          onClick={() => handleUnlock(u.id)}
                          className="px-2.5 py-1 text-xs font-medium rounded-lg bg-red-900/20 hover:bg-red-900/40 text-red-300 transition-colors">
                          잠금 풀기
                        </button>
                      )}
                      <button
                        onClick={() => handlePatch(u.id, { isActive: u.is_active === false })}
                        className={`px-2.5 py-1 text-xs font-medium rounded-lg transition-colors ${u.is_active !== false ? 'bg-slate-700 hover:bg-amber-900/40 text-slate-300 hover:text-amber-400' : 'bg-emerald-900/30 hover:bg-emerald-900/50 text-emerald-400'}`}>
                        {u.is_active !== false ? '비활성화' : '활성화'}
                      </button>
                      <button
                        onClick={() => handlePatch(u.id, { role: u.role === 'ADMIN' ? 'USER' : 'ADMIN' })}
                        className="px-2.5 py-1 text-xs font-medium rounded-lg bg-slate-700 hover:bg-purple-900/40 text-slate-300 hover:text-purple-400 transition-colors">
                        {u.role === 'ADMIN' ? '권한 해제' : '관리자 권한'}
                      </button>
                      <button
                        onClick={() => handleResetPassword(u.id, u.email)}
                        disabled={u.is_active === false}
                        title="임시 비밀번호를 다시 발급합니다"
                        className="px-2.5 py-1 text-xs font-medium rounded-lg bg-slate-700 hover:bg-amber-900/40 text-slate-300 hover:text-amber-300 transition-colors disabled:opacity-40">
                        비밀번호 재발급
                      </button>
                      <button
                        onClick={() => setDeleteTarget({ id: u.id, name: u.full_name || u.email, email: u.email })}
                        className="px-2.5 py-1 text-xs font-medium rounded-lg bg-red-900/20 hover:bg-red-900/50 text-red-400 transition-colors">
                        삭제
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* 페이지네이션 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-slate-500">총 {meta.total}명</p>
          <div className="flex items-center gap-2">
            <button onClick={() => { const p = page-1; setPage(p); fetchUsers(p); }} disabled={page===1}
              className="px-4 py-2 bg-[#1E293B] border border-slate-700 rounded-xl text-sm text-slate-400 disabled:opacity-40 hover:border-[#7C3AED] transition-colors">이전</button>
            <span className="text-sm text-slate-400">{page} / {totalPages}</span>
            <button onClick={() => { const p = page+1; setPage(p); fetchUsers(p); }} disabled={page>=totalPages}
              className="px-4 py-2 bg-[#1E293B] border border-slate-700 rounded-xl text-sm text-slate-400 disabled:opacity-40 hover:border-[#7C3AED] transition-colors">다음</button>
          </div>
        </div>
      )}

      {/* 계정 삭제 확인 모달 */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
          <div className="bg-[#1E293B] border border-red-700/40 rounded-2xl p-6 w-full max-w-sm space-y-4">
            <h3 className="text-base font-bold text-red-400">계정 삭제 확인</h3>
            <div className="p-3 bg-[#0F172A] rounded-xl">
              <p className="text-sm font-semibold text-white">{deleteTarget.name}</p>
              <p className="text-xs text-slate-400">{deleteTarget.email}</p>
            </div>
            <p className="text-sm text-slate-300">
              계정을 삭제하면 <span className="text-red-400 font-semibold">복구할 수 없습니다.</span><br/>
              로그인할 수 없게 되고 대화·만든 파일·개인 비서가 지워집니다.
              사용 기록은 과금·감사 근거라 이름과 함께 남습니다.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteTarget(null)}
                className="flex-1 py-2.5 border border-slate-700 rounded-xl text-sm text-slate-400 hover:text-white transition-colors">
                취소
              </button>
              <button onClick={handleDelete} disabled={deleting}
                className="flex-1 py-2.5 bg-red-600 hover:bg-red-700 disabled:bg-slate-700 text-white font-semibold rounded-xl text-sm transition-colors">
                {deleting ? '삭제 중...' : '영구 삭제'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 슈퍼관리자 탭 ──────────────────────────────────────────
function SuperAdminsTab({ onToast }: { onToast: (m: string) => void }) {
  const [list, setList]       = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newResult, setNewResult]       = useState<{ email: string; tempPassword: string } | null>(null);

  // 비밀번호 변경 폼
  const [pwForm, setPwForm] = useState({ current: '', next: '', confirm: '' });
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSaving, setPwSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res  = await fetch('/api/super/accounts/super-admins');
    const data = await res.json();
    if (data.ok) setList(data.data);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDeactivate = async (id: string, isActive: boolean) => {
    const res  = await fetch(`/api/super/accounts/super-admins/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isActive }),
    });
    const data = await res.json();
    if (data.ok) { load(); onToast(isActive ? '활성화됐습니다.' : '비활성화됐습니다.'); }
    else onToast(data.error);
  };

  const handleUnlockSuper = async (id: string) => {
    const res  = await fetch(`/api/super/accounts/users/${id}/sign-in-lock`, { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) { load(); onToast('로그인 잠금을 풀었습니다.'); }
    else onToast(data.error?.message ?? '잠금 풀기 실패');
  };

  const handleChangePw = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pwForm.next !== pwForm.confirm) { setPwError('새 비밀번호가 일치하지 않습니다.'); return; }
    // 규칙은 직원과 같다(서버가 다시 본다) — 영문 대·소문자·숫자·특수문자 중 세 종류 8자 또는 두 종류 10자 이상
    const policy = passwordPolicyError(pwForm.next);
    if (policy) { setPwError(policy); return; }
    setPwSaving(true); setPwError(null);
    const res  = await fetch('/api/super/accounts/me/password', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: pwForm.current, newPassword: pwForm.next }),
    });
    const data = await res.json();
    if (data.ok) {
      setPwForm({ current: '', next: '', confirm: '' });
      // 모든 슈퍼관리자 로그인이 끝났다 — 새 비밀번호로 다시 로그인
      if (data.data?.signedOut) { window.location.href = '/super/login'; return; }
      onToast('비밀번호가 변경됐습니다.');
    }
    else setPwError(typeof data.error === 'string' ? data.error : data.error?.message ?? '비밀번호를 바꾸지 못했습니다.');
    setPwSaving(false);
  };

  return (
    <div className="space-y-8">
      {/* 슈퍼관리자 목록 */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-400 uppercase tracking-wider">슈퍼관리자 목록</h2>
          <button onClick={() => setShowAddModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-[#7C3AED] hover:bg-[#6D28D9] text-white text-xs font-semibold rounded-xl transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4"/></svg>
            슈퍼관리자 추가
          </button>
        </div>

        <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-700/50">
              <tr>
                {['이름', '이메일', '등록일', '최근 활동', '상태', '관리'].map(h => (
                  <th key={h} className="px-5 py-3 text-left text-xs font-semibold text-slate-500">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/30">
              {loading ? (
                <tr><td colSpan={6} className="px-5 py-8 text-center"><div className="w-5 h-5 border-2 border-[#7C3AED]/30 border-t-[#7C3AED] rounded-full animate-spin mx-auto"/></td></tr>
              ) : list.map(sa => (
                <tr key={sa.id} className={`hover:bg-slate-700/20 transition-colors ${sa.is_active === false ? 'opacity-50' : ''}`}>
                  <td className="px-5 py-3.5 font-medium text-white">{sa.full_name || '—'}</td>
                  <td className="px-5 py-3.5 text-slate-400">{sa.email}</td>
                  <td className="px-5 py-3.5 text-slate-500 text-xs">{fmtDate(sa.created_at)}</td>
                  <td className="px-5 py-3.5 text-slate-500 text-xs">{fmtDate(sa.updated_at)}</td>
                  <td className="px-5 py-3.5">
                    <span className={`px-2 py-0.5 rounded-full text-xs ${sa.is_active !== false ? 'bg-emerald-900/30 text-emerald-400' : 'bg-slate-700 text-slate-500'}`}>
                      {sa.is_active !== false ? '활성' : '비활성'}
                    </span>
                    {sa.sign_in_locked_until && (
                      <span className="ml-1 px-2 py-0.5 rounded-full text-xs bg-red-900/30 text-red-400" title="로그인을 30분 안에 5번 틀려 잠겼습니다">
                        잠김 · {lockUntilLabel(sa.sign_in_locked_until)}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3.5">
                    {sa.sign_in_locked_until && (
                      <button
                        onClick={() => handleUnlockSuper(sa.id)}
                        className="mr-1.5 px-3 py-1 text-xs rounded-lg bg-red-900/20 hover:bg-red-900/40 text-red-300 transition-colors">
                        잠금 풀기
                      </button>
                    )}
                    <button
                      onClick={() => handleDeactivate(sa.id, sa.is_active === false)}
                      className="px-3 py-1 text-xs rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors">
                      {sa.is_active !== false ? '비활성화' : '활성화'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 내 비밀번호 변경 */}
      <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl p-6 space-y-4 max-w-md">
        <h2 className="text-sm font-bold text-slate-400 uppercase tracking-wider">내 비밀번호 변경</h2>
        <form onSubmit={handleChangePw} className="space-y-3">
          {[['current','현재 비밀번호'],['next','새 비밀번호'],['confirm','새 비밀번호 확인']].map(([k,label]) => (
            <div key={k}>
              <label className="block text-xs font-semibold text-slate-400 mb-1.5">{label}</label>
              <input type="password" value={(pwForm as any)[k]} onChange={e => setPwForm(f => ({ ...f, [k]: e.target.value }))} required
                className="w-full px-4 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]" />
            </div>
          ))}
          {pwError && <p className="text-xs text-red-400">{pwError}</p>}
          <button type="submit" disabled={pwSaving}
            className="w-full py-3 bg-[#7C3AED] hover:bg-[#6D28D9] disabled:bg-slate-700 text-white font-semibold rounded-xl text-sm transition-colors">
            {pwSaving ? '변경 중...' : '비밀번호 변경'}
          </button>
        </form>
      </div>

      {/* 슈퍼관리자 추가 모달 */}
      {showAddModal && (
        <AddSuperAdminModal
          onClose={() => { setShowAddModal(false); setNewResult(null); }}
          onCreated={(r) => { setNewResult(r); load(); }}
          result={newResult}
        />
      )}
    </div>
  );
}

// ─── 슈퍼관리자 추가 모달 ─────────────────────────────────────
function AddSuperAdminModal({
  onClose, onCreated, result,
}: { onClose: () => void; onCreated: (r: any) => void; result: any }) {
  const [name, setName]   = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true); setError(null);
    const res  = await fetch('/api/super/accounts/super-admins', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email }),
    });
    const data = await res.json();
    if (data.ok) onCreated(data.data);
    else setError(data.error);
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
      <div className="bg-[#1E293B] border border-slate-700 rounded-2xl p-6 w-full max-w-sm">
        <h3 className="text-base font-bold text-white mb-5">슈퍼관리자 추가</h3>

        {result ? (
          <div className="space-y-4">
            <div className="p-4 bg-emerald-900/20 border border-emerald-700/40 rounded-xl">
              <p className="text-sm font-bold text-emerald-400 mb-3">✅ 계정이 생성됐습니다!</p>
              <p className="text-xs text-slate-400 mb-1">이메일: <span className="text-white">{result.email}</span></p>
              <div className="flex items-center gap-2 mt-2">
                <p className="text-xs text-slate-400">임시 비밀번호:</p>
                <code className="text-xs text-white font-mono bg-[#0F172A] px-2 py-1 rounded flex-1">{result.tempPassword}</code>
                <CopyBtn value={result.tempPassword} />
              </div>
              <p className="text-xs text-amber-400 mt-3">⚠️ 지금 복사하세요. 다시 확인할 수 없습니다.</p>
              <p className="text-xs text-slate-400 mt-1">첫 로그인에서 이 임시 비밀번호를 본인 비밀번호로 바꿔야 다른 화면을 쓸 수 있습니다.</p>
            </div>
            <button onClick={onClose} className="w-full py-2.5 bg-[#7C3AED] hover:bg-[#6D28D9] text-white font-semibold rounded-xl text-sm">닫기</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1.5">이름 <span className="text-red-400">*</span></label>
              <input value={name} onChange={e => setName(e.target.value)} required placeholder="홍길동"
                className="w-full px-4 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:border-[#7C3AED]"/>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1.5">이메일 <span className="text-red-400">*</span></label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="admin@workon.ai"
                className="w-full px-4 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:border-[#7C3AED]"/>
            </div>
            <p className="text-xs text-slate-500">임시 비밀번호는 생성 후 자동으로 표시됩니다.</p>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <div className="flex gap-3 pt-1">
              <button type="button" onClick={onClose}
                className="flex-1 py-2.5 border border-slate-700 rounded-xl text-sm text-slate-400 hover:text-white transition-colors">취소</button>
              <button type="submit" disabled={saving}
                className="flex-1 py-2.5 bg-[#7C3AED] hover:bg-[#6D28D9] disabled:bg-slate-700 text-white font-semibold rounded-xl text-sm transition-colors">
                {saving ? '추가 중...' : '추가하기'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
