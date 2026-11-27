'use client';

import { useState, useEffect, useCallback } from 'react';
import type { User } from '@/lib/db';
import CsvRegisterTab from './CsvRegisterTab';
import { lockUntilLabel } from '@/lib/sign-in-lock-spec';
import { USER_LIST_FILTERS, matchesUserFilter, type UserListFilter } from '@/lib/user-list-filter';
import { actionErrorText, emptyListText, fetchOkJson } from '@/lib/ok-json';

interface Invitation {
  id: string;
  email: string;
  role: string;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
}

interface DeptOption {
  id: string;
  name: string;
  depth: number;
}

type Tab = 'list' | 'invite' | 'csv';

/** 트리를 드롭다운용 평면 목록으로 */
function flattenDepts(nodes: any[], depth = 0): DeptOption[] {
  return nodes.flatMap((n) => [
    { id: n.id, name: n.name, depth },
    ...flattenDepts(n.children ?? [], depth + 1),
  ]);
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' });
}

function isExpired(d: string) {
  return new Date(d) < new Date();
}

export default function UsersManager() {
  const [tab, setTab] = useState<Tab>('list');
  const [users, setUsers] = useState<User[]>([]);
  // 기관의 사용자 수 상한(2026-11-17) — 기관 전체 활성 계정 수. 못 읽으면 null
  const [seats, setSeats] = useState<{ used: number; limit: number | null } | null>(null);
  // 지금 로그인한 관리자 — 본인 줄에서는 부서 옮기기·권한 바꾸기를 막는다(서버도 막는다)
  const [meId, setMeId] = useState<string | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 초대 폼 상태
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'USER' | 'ADMIN'>('USER');
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ url: string; emailSent: boolean; emailError?: string } | null>(null);
  /** 복사가 안 되는 브라우저(2026-11-27) — 클립보드를 못 쓰면 글을 골라 두고 직접 복사하라고 알린다 */
  const [copyFailed, setCopyFailed] = useState(false);
  /** 취소를 한 번 더 눌러 확인하는 초대(2026-11-27) — 확인 창(confirm)이 막힌 브라우저에서 아무 반응이 없었다 */
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // 부서 이동
  const [depts, setDepts] = useState<DeptOption[]>([]);
  const [movingId, setMovingId] = useState<string | null>(null);

  // 못 읽은 것 — '등록된 사용자가 없습니다'·초대 0건과 가른다(2026-11-20 — 예전엔 응답이 실패여도 아무것도 하지 않았다).
  // 조작마다 지워지는 `error`와 따로 둔다. 앞서 읽은 목록은 그대로 둔다
  const [unread, setUnread] = useState({ users: false, invitations: false, depts: false });

  const loadData = useCallback(async () => {
    setLoading(true);
    const [usersRes, invitesRes, deptsRes] = await Promise.all([
      fetchOkJson<{ data: any[]; seats?: any; me?: unknown }>('/api/users'),
      fetchOkJson<{ data: any[] }>('/api/admin/invite'),
      fetchOkJson<{ data?: any[] }>('/api/departments'),
    ]);
    setUnread({ users: !usersRes, invitations: !invitesRes, depts: !deptsRes });
    if (usersRes) { setUsers(usersRes.data); setSeats(usersRes.seats ?? null); setMeId(typeof usersRes.me === 'string' ? usersRes.me : null); }
    if (invitesRes) setInvitations(invitesRes.data);
    if (deptsRes) setDepts(flattenDepts(deptsRes.data ?? []));
    setLoading(false);
  }, []);
  const unreadNames = [unread.users && '사용자 목록', unread.invitations && '초대 목록', unread.depts && '부서 목록'].filter(Boolean) as string[];

  useEffect(() => { loadData(); }, [loadData]);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviting(true);
    setInviteError(null);
    try {
      const res = await fetch('/api/admin/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      setInviteResult({ url: result.data.inviteUrl, emailSent: Boolean(result.data.emailSent), ...(typeof result.data.emailError === 'string' ? { emailError: result.data.emailError } : {}) });
      await loadData();
    } catch (err) {
      setInviteError(actionErrorText(err, '초대 발송에 실패했습니다.'));
    } finally {
      setInviting(false);
    }
  };

  const handleCancelInvite = async (id: string) => {
    // 첫 누름은 확인을 묻고(단추가 '취소 확인'으로 바뀜), 두 번째에 취소한다 — 확인 창(confirm)은 막힌 브라우저가 있다
    if (confirmCancelId !== id) { setConfirmCancelId(id); return; }
    setConfirmCancelId(null);
    try {
      // 실패했는데 목록에서만 사라지지 않게 — 응답을 본다(이미 수락된 초대는 취소되지 않는다)
      const res = await fetch(`/api/admin/invite/${id}`, { method: 'DELETE' });
      const result = await res.json().catch(() => null);
      if (!result?.ok) {
        alert(result?.error?.message || '초대 취소에 실패했습니다.');
        await loadData();
        return;
      }
      setInvitations(prev => prev.filter(i => i.id !== id));
    } catch { alert('초대 취소에 실패했습니다.'); }
  };

  /**
   * 개인 월 한도 저장 (0024).
   *
   * 부서 기본값을 덮어쓰는 예외다. 비우면 부서 기본값으로 되돌아간다.
   */
  const handleBudget = async (userId: string, value: string) => {
    setMovingId(userId);
    setError(null);
    try {
      const res = await fetch(`/api/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monthly_budget_krw: value.trim() === '' ? null : Number(value) }),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      setUsers(prev => prev.map(u => (u.id === userId ? { ...u, ...result.data } : u)));
    } catch (err) {
      setError(actionErrorText(err, '한도 저장에 실패했습니다.'));
      await loadData();
    } finally {
      setMovingId(null);
    }
  };

  // 목록 거르기 — 사용 중지·장기 미접속(2026-11-16)
  const [listFilter, setListFilter] = useState<UserListFilter>('all');
  const shownUsers = users.filter(u => matchesUserFilter(u, listFilter));

  /** 계정 사용 중지·다시 사용 — 끄면 로그인이 막히고 열린 로그인도 30초 안에 끝난다 */
  const handleActive = async (userId: string, email: string, active: boolean) => {
    let reason = '';
    if (!active) {
      const r = prompt(`${email} 계정을 사용 중지합니다. 사유를 적어 주세요(예: 퇴직, 전출).`);
      if (r === null) return;
      reason = r.trim();
    } else if (!confirm(`${email} 계정을 다시 사용하게 할까요?`)) return;
    setMovingId(userId);
    setError(null);
    try {
      const res = await fetch(`/api/users/${userId}/active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active, reason }),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      setUsers(prev => prev.map(u => (u.id === userId ? { ...u, is_active: result.data.is_active } : u)));
    } catch (err) {
      setError(actionErrorText(err, '계정 상태를 바꾸지 못했습니다.'));
    } finally {
      setMovingId(null);
    }
  };

  /** 임시 비밀번호 재발급 — 새 비밀번호는 이 화면에 한 번만 보인다(저장하지 않음) */
  const [resetResult, setResetResult] = useState<{ email: string; tempPassword: string; emailSent: boolean } | null>(null);
  const handleResetPassword = async (userId: string, email: string) => {
    if (!confirm(`${email}의 임시 비밀번호를 다시 발급할까요?
지금 비밀번호와 열려 있는 로그인은 모두 쓸 수 없게 되고, 다음 로그인에 비밀번호부터 바꿔야 합니다. 본인 확인을 먼저 하세요.`)) return;
    setMovingId(userId);
    setError(null);
    setResetResult(null);
    try {
      const res = await fetch(`/api/users/${userId}/password-reset`, { method: 'POST' });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      setResetResult({ email, tempPassword: result.data.tempPassword, emailSent: Boolean(result.data.emailSent) });
      setUsers(prev => prev.map(u => (u.id === userId ? { ...u, sign_in_locked_until: null } : u)));
    } catch (err) {
      setError(actionErrorText(err, '비밀번호를 재발급하지 못했습니다.'));
    } finally {
      setMovingId(null);
    }
  };

  /** 로그인 실패 잠금 풀기(0091) — 그 계정의 실패 기록을 지운다 */
  const handleUnlock = async (userId: string) => {
    if (!confirm('이 직원의 로그인 잠금을 풀까요? 본인이 비밀번호를 여러 번 틀린 것인지 먼저 확인하세요.')) return;
    setMovingId(userId);
    setError(null);
    try {
      const res = await fetch(`/api/users/${userId}/sign-in-lock`, { method: 'DELETE' });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      setUsers(prev => prev.map(u => (u.id === userId ? { ...u, sign_in_locked_until: null } : u)));
    } catch (err) {
      setError(actionErrorText(err, '잠금을 풀지 못했습니다.'));
    } finally {
      setMovingId(null);
    }
  };

  const handleMoveDepartment = async (userId: string, departmentId: string) => {
    setMovingId(userId);
    setError(null);
    try {
      const res = await fetch(`/api/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ department_id: departmentId }),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      setUsers(prev => prev.map(u => (u.id === userId ? { ...u, ...result.data } : u)));
    } catch (err) {
      setError(actionErrorText(err, '부서 이동에 실패했습니다.'));
      // 실패했으면 화면이 실제 상태와 어긋나므로 다시 불러온다
      await loadData();
    } finally {
      setMovingId(null);
    }
  };

  /**
   * 관리자 지정·해제(2026-11-18) — API(`PATCH /api/users/[id]`의 `role`)는 있었지만 화면에 단추가 없어,
   * 직원을 관리자로 올리려면 새로 초대하거나 서비스 운영자에게 요청해야 했다. 바꾼 것은 보안 로그에 남는다(서버).
   */
  const handleRole = async (userId: string, email: string, toAdmin: boolean) => {
    const question = toAdmin
      ? `${email} 계정을 관리자로 지정할까요?\n소속 부서와 그 하위 부서의 직원·비서·문서를 관리하게 됩니다.`
      : `${email} 계정의 관리자 권한을 해제할까요?\n일반 직원이 되고, 열려 있는 로그인은 곧 끝납니다.`;
    if (!confirm(question)) return;
    setMovingId(userId);
    setError(null);
    try {
      const res = await fetch(`/api/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: toAdmin ? 'ADMIN' : 'USER' }),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      setUsers(prev => prev.map(u => (u.id === userId ? { ...u, ...result.data } : u)));
    } catch (err) {
      setError(actionErrorText(err, '권한을 바꾸지 못했습니다.'));
      await loadData();
    } finally {
      setMovingId(null);
    }
  };

  const handleCopy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setCopyFailed(false);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // 클립보드를 못 쓰는 브라우저 — 조용히 넘기지 않는다(예전엔 눌러도 아무 일이 없었다)
      setCopyFailed(true);
    }
  };

  const pendingInvitations = invitations.filter(i => !i.accepted_at && !isExpired(i.expires_at));
  const expiredInvitations = invitations.filter(i => !i.accepted_at && isExpired(i.expires_at));
  const acceptedInvitations = invitations.filter(i => !!i.accepted_at);

  const TABS: { key: Tab; label: string }[] = [
    { key: 'list',   label: `직원 목록 (${users.length})` },
    { key: 'invite', label: '직원 초대' },
    { key: 'csv',    label: 'CSV 일괄 등록' },
  ];

  return (
    <div className="space-y-6">
      {/* 페이지 헤더 */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">사용자 관리</h1>
        <p className="text-sm text-slate-500 mt-1">내 부서와 하위 부서의 구성원을 초대하고 관리합니다. 소속 부서는 드롭다운에서 바로 바꿀 수 있습니다.</p>
        {seats && (
          <p className={`text-sm mt-2 ${seats.limit !== null && seats.used >= seats.limit ? 'text-amber-700 font-semibold' : 'text-slate-600'}`}>
            {seats.limit === null
              ? `기관 사용자 ${seats.used}명 · 인원 상한 없음`
              : seats.used >= seats.limit
                ? `기관 사용자 ${seats.used} / ${seats.limit}명 — 상한에 닿아 새 계정을 만들 수 없습니다. 쓰지 않는 계정을 사용 중지하거나 서비스 운영자에게 계약 인원 변경을 요청하세요.`
                : `기관 사용자 ${seats.used} / ${seats.limit}명 · ${seats.limit - seats.used}명 더 만들 수 있음`}
            <span className="text-xs text-slate-400 ml-2">(사용 중지 계정은 세지 않음)</span>
          </p>
        )}
      </div>

      {/* 탭 */}
      <div className="flex gap-1 border-b border-slate-200">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm font-semibold rounded-t-lg transition-colors border-b-2 ${
              tab === t.key
                ? 'border-[#003087] text-[#003087] bg-blue-50'
                : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {unreadNames.length > 0 && (
        <div role="alert" className="p-4 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-sm">
          {unreadNames.join('·')}을 지금 불러오지 못했습니다. 화면을 새로 고쳐 주세요{unread.depts ? ' — 부서 목록이 없으면 소속 부서를 바꿀 수 없습니다' : ''}.
        </div>
      )}
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-red-600 text-sm">{error}</div>
      )}

      {resetResult && (
        <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-900 space-y-2">
          <p className="font-semibold">{resetResult.email}의 임시 비밀번호를 발급했습니다</p>
          <p className="flex items-center gap-2">
            <code className="px-2 py-1 bg-white border border-amber-200 rounded font-mono text-base">{resetResult.tempPassword}</code>
            <button type="button" onClick={() => handleCopy(resetResult.tempPassword)} className="text-xs font-medium text-amber-800 hover:text-amber-950">
              {copied ? '복사됨' : '복사'}
            </button>
          </p>
          <p className="text-xs text-amber-800">
            {resetResult.emailSent ? '본인 메일로도 보냈습니다. ' : '메일로 보내지 못해 직접 전해 주세요. '}
            이 화면을 닫으면 다시 볼 수 없습니다. 직원은 다음 로그인에 비밀번호부터 바꿉니다.
          </p>
          <button type="button" onClick={() => setResetResult(null)} className="text-xs text-amber-700 hover:text-amber-900">닫기</button>
        </div>
      )}

      {/* ── 탭 1: 직원 목록 ── */}
      {tab === 'list' && (
        <div className="space-y-8">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-slate-500">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[#003087] mr-3" />
              로딩 중...
            </div>
          ) : (
            <>
              <section>
                <div className="mb-3 flex items-center gap-2">
                  <select
                    value={listFilter}
                    onChange={e => setListFilter(e.target.value as UserListFilter)}
                    className="px-2.5 py-1.5 border border-slate-200 rounded-lg text-xs bg-white text-slate-700"
                    title="목록 거르기"
                  >
                    {USER_LIST_FILTERS.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                  </select>
                  {listFilter !== 'all' && <span className="text-xs text-slate-400">{shownUsers.length}명</span>}
                </div>
                <div className="space-y-2">
                  {shownUsers.map(user => (
                    <div key={user.id} className={`flex flex-wrap items-center justify-between gap-3 p-4 bg-white border border-slate-100 rounded-xl hover:shadow-sm transition-shadow ${user.is_active === false ? 'opacity-60' : ''}`}>
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="w-9 h-9 shrink-0 rounded-xl bg-blue-50 flex items-center justify-center text-[#003087] font-bold text-sm">
                          {(user.full_name || user.email).charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-slate-900">
                            {user.full_name || '(이름 없음)'}
                            {user.id === meId && <span className="ml-1.5 text-xs font-normal text-slate-400">(나)</span>}
                          </p>
                          <p className="text-xs text-slate-400 break-all">{user.email}</p>
                        </div>
                      </div>
                      {/* 좁은 화면(사이드바를 연 노트북 등)에서는 줄을 바꿔 놓는다 — 예전엔 줄바꿈 없이 눌려 단추 글자가 한 글자씩 세로로 접혔다 */}
                      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
                        {user.is_active === false && (
                          <span className="whitespace-nowrap px-2.5 py-1 text-xs font-medium rounded-full bg-slate-200 text-slate-600">사용 중지됨</span>
                        )}
                        {user.sign_in_locked_until && (
                          <span className="flex items-center gap-1.5">
                            <span className="whitespace-nowrap px-2.5 py-1 text-xs font-medium rounded-full bg-red-50 text-red-600" title="로그인을 30분 안에 5번 틀려 잠겼습니다">
                              로그인 잠김 · {lockUntilLabel(user.sign_in_locked_until)}
                            </span>
                            <button
                              onClick={() => handleUnlock(user.id)}
                              disabled={movingId === user.id}
                              className="whitespace-nowrap text-xs font-medium text-red-600 hover:text-red-800 disabled:opacity-50"
                            >
                              잠금 풀기
                            </button>
                          </span>
                        )}
                        <select
                          value={(user as any).department_id ?? ''}
                          onChange={e => handleMoveDepartment(user.id, e.target.value)}
                          disabled={movingId === user.id || depts.length === 0 || user.id === meId}
                          title={user.id === meId ? '본인의 소속 부서는 직접 옮길 수 없습니다' : '소속 부서 변경'}
                          className="px-2.5 py-1.5 border border-slate-200 rounded-lg text-xs bg-white text-slate-700 max-w-[180px] disabled:opacity-50"
                        >
                          {depts.map(d => (
                            <option key={d.id} value={d.id}>
                              {' '.repeat(d.depth * 2)}{d.name}
                            </option>
                          ))}
                        </select>
                        {/* 개인 월 한도. 비우면 부서 기본값을 따른다.
                            포커스가 빠질 때 저장한다 — 한 글자마다 저장하면
                            "20000"을 치는 동안 2원·20원 한도가 잠깐씩 걸린다. */}
                        <input
                          type="number"
                          min={0}
                          defaultValue={user.monthly_budget_krw ?? ''}
                          onBlur={(e) => {
                            const next = e.target.value;
                            const now = user.monthly_budget_krw != null ? String(user.monthly_budget_krw) : '';
                            if (next.trim() !== now) handleBudget(user.id, next);
                          }}
                          disabled={movingId === user.id}
                          placeholder="부서 기본값"
                          title="개인 월 한도(원). 비우면 소속 부서의 기본값을 따릅니다"
                          className="w-28 px-2 py-1 border border-slate-200 rounded-lg text-xs disabled:bg-slate-50"
                        />
                        <span className={`whitespace-nowrap px-2.5 py-1 text-xs font-medium rounded-full ${
                          user.role === 'ADMIN' ? 'bg-purple-100 text-purple-700' : 'bg-slate-100 text-slate-600'
                        }`}>
                          {user.role === 'ADMIN' ? '관리자' : '일반 직원'}
                        </span>
                        {user.id !== meId && user.is_active !== false && (
                          <button
                            type="button"
                            onClick={() => handleRole(user.id, user.email, user.role !== 'ADMIN')}
                            disabled={movingId === user.id}
                            title={user.role === 'ADMIN' ? '관리자 권한을 해제합니다(보안 로그에 남습니다)' : '이 직원을 관리자로 지정합니다(보안 로그에 남습니다)'}
                            className="whitespace-nowrap text-xs font-medium text-slate-500 hover:text-purple-700 disabled:opacity-50"
                          >
                            {user.role === 'ADMIN' ? '관리자 해제' : '관리자로 지정'}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleResetPassword(user.id, user.email)}
                          disabled={movingId === user.id}
                          title="임시 비밀번호를 다시 발급합니다(지금 비밀번호와 로그인은 모두 끝남)"
                          className="whitespace-nowrap text-xs font-medium text-slate-500 hover:text-slate-800 disabled:opacity-50"
                        >
                          비밀번호 재발급
                        </button>
                        <button
                          type="button"
                          onClick={() => handleActive(user.id, user.email, user.is_active === false)}
                          disabled={movingId === user.id}
                          title={user.is_active === false ? '계정을 다시 사용하게 합니다' : '계정을 사용 중지합니다(로그인이 막히고 열린 로그인도 끝남)'}
                          className={`whitespace-nowrap text-xs font-medium disabled:opacity-50 ${user.is_active === false ? 'text-emerald-600 hover:text-emerald-800' : 'text-slate-500 hover:text-red-600'}`}
                        >
                          {user.is_active === false ? '다시 사용' : '사용 중지'}
                        </button>
                        <span className="whitespace-nowrap text-xs text-slate-400" title="가입일 · 마지막 로그인">
                          {formatDate(user.created_at)} · {user.last_sign_in_at ? `최근 ${formatDate(user.last_sign_in_at)}` : '로그인 기록 없음'}
                        </span>
                      </div>
                    </div>
                  ))}
                  {users.length > 0 && shownUsers.length === 0 && (
                    <div className="text-center py-8 text-slate-400 text-sm">조건에 맞는 직원이 없습니다.</div>
                  )}
                  {users.length === 0 && (
                    <div className="text-center py-8 text-slate-400 text-sm">{emptyListText(unread.users, '등록된 사용자가 없습니다.', '사용자 목록을')}</div>
                  )}
                </div>
              </section>

              {pendingInvitations.length > 0 && (
                <section>
                  <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3">
                    대기 중인 초대 ({pendingInvitations.length}건)
                  </h3>
                  <div className="border border-slate-100 rounded-xl overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50">
                        <tr>
                          {['이메일', '권한', '만료일', ''].map((h, i) => (
                            <th key={i} className={`px-4 py-3 text-xs font-semibold text-slate-500 ${i === 3 ? 'text-right' : 'text-left'}`}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {pendingInvitations.map(inv => (
                          <tr key={inv.id} className="bg-white hover:bg-slate-50">
                            <td className="px-4 py-3 font-medium text-slate-800">{inv.email}</td>
                            <td className="px-4 py-3">
                              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                                inv.role === 'ADMIN' ? 'bg-purple-100 text-purple-700' : 'bg-slate-100 text-slate-600'
                              }`}>
                                {inv.role === 'ADMIN' ? '관리자' : '일반 직원'}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-slate-500 text-xs">{formatDate(inv.expires_at)}</td>
                            <td className="px-4 py-3 text-right">
                              <button onClick={() => void handleCancelInvite(inv.id)} onBlur={() => setConfirmCancelId((c) => (c === inv.id ? null : c))} className={`text-xs font-medium ${confirmCancelId === inv.id ? 'rounded bg-red-600 px-2 py-1 text-white' : 'text-red-500 hover:text-red-700'}`}>{confirmCancelId === inv.id ? '취소 확인' : '취소'}</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              {(expiredInvitations.length > 0 || acceptedInvitations.length > 0) && (
                <p className="text-xs text-slate-400">
                  수락된 초대 {acceptedInvitations.length}건 · 만료된 초대 {expiredInvitations.length}건
                </p>
              )}
            </>
          )}
        </div>
      )}

      {/* ── 탭 2: 직원 초대 ── */}
      {tab === 'invite' && (
        <div className="max-w-md space-y-5">
          {!inviteResult ? (
            <form onSubmit={handleInvite} className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1.5">이메일 주소 <span className="text-red-400">*</span></label>
                <input
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={e => setInviteEmail(e.target.value)}
                  placeholder="colleague@gov.kr"
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#003087]/30 focus:border-[#003087]"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1.5">권한</label>
                <div className="flex gap-3">
                  {(['USER', 'ADMIN'] as const).map(r => (
                    <button
                      key={r} type="button" onClick={() => setInviteRole(r)}
                      className={`flex-1 py-2.5 rounded-xl text-sm font-medium border-2 transition-colors ${
                        inviteRole === r
                          ? 'border-[#003087] bg-blue-50 text-[#003087]'
                          : 'border-slate-200 text-slate-500 hover:border-slate-300'
                      }`}
                    >
                      {r === 'USER' ? '일반 직원' : '관리자'}
                    </button>
                  ))}
                </div>
              </div>
              {inviteError && (
                <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">{inviteError}</div>
              )}
              <button
                type="submit" disabled={inviting}
                className="w-full py-3 bg-[#003087] hover:bg-[#002070] disabled:bg-slate-300 text-white font-semibold rounded-xl text-sm transition-colors"
              >
                {inviting ? '초대 링크 생성 중...' : '초대 링크 생성'}
              </button>
            </form>
          ) : (
            <div className="space-y-5">
              <div className="flex items-center gap-3 p-4 bg-green-50 border border-green-200 rounded-xl">
                <svg className="w-5 h-5 text-green-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
                <p className="text-sm text-green-700 font-medium">
                  {inviteResult.emailSent
                    ? `${inviteEmail}로 초대 메일을 보냈습니다!`
                    : '초대 링크가 생성됐습니다!'}
                </p>
              </div>

              {!inviteResult.emailSent && (
                <div className="flex items-start gap-2.5 p-3 bg-amber-50 border border-amber-200 rounded-xl">
                  <svg className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                  </svg>
                  <p className="text-xs text-amber-800 leading-relaxed">
                    {inviteResult.emailError === 'not_configured' ? (
                      <>
                        메일 발송이 설정되지 않아 자동 발송되지 않았습니다. 아래 링크를 직접 전달해주세요.
                        <br />
                        <span className="text-amber-700">자동 발송하려면 <code className="font-mono">RESEND_API_KEY</code>와 <code className="font-mono">MAIL_FROM</code> 환경변수를 설정하세요.</span>
                      </>
                    ) : (
                      <>초대 메일을 보내지 못했습니다(메일 서비스가 받지 않음). 아래 링크를 직접 전달해주세요 — 계속되면 서비스 운영자에게 메일 설정(보내는 주소 인증)을 확인해 달라고 하세요.</>
                    )}
                  </p>
                </div>
              )}

              <div>
                <p className="text-xs text-slate-500 mb-2 font-medium">초대 링크 (7일 유효)</p>
                <div className="flex items-center gap-2 p-3 bg-slate-50 border border-slate-200 rounded-xl">
                  {/* 링크 전체를 보이고(예전엔 '…'로 잘려 손으로도 못 옮겼다) 누르면 전체가 골라진다 */}
                  <p className="flex-1 select-all break-all text-xs text-slate-700 font-mono">{inviteResult.url}</p>
                  <button
                    onClick={() => handleCopy(inviteResult.url)}
                    className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                      copied ? 'bg-green-100 text-green-700' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {copied ? '복사됨' : '복사'}
                  </button>
                </div>
                {copyFailed && <p role="alert" className="mt-2 text-xs text-amber-800">이 브라우저에서는 자동 복사가 되지 않습니다 — 위 링크를 눌러 전체를 고른 뒤 Ctrl+C(맥은 ⌘+C)로 복사해 주세요.</p>}
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => { setInviteResult(null); setInviteEmail(''); setCopyFailed(false); }}
                  className="flex-1 py-2.5 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50"
                >
                  추가 초대
                </button>
                <button
                  onClick={() => { setTab('list'); setInviteResult(null); }}
                  className="flex-1 py-2.5 bg-[#003087] hover:bg-[#002070] text-white font-semibold rounded-xl text-sm"
                >
                  완료
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── 탭 3: CSV 일괄 등록 ── */}
      {tab === 'csv' && <CsvRegisterTab />}
    </div>
  );
}
