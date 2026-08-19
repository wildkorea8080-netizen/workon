'use client';

import { useState, useEffect, useCallback } from 'react';
import type { User } from '@/lib/db';
import CsvRegisterTab from './CsvRegisterTab';

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
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 초대 폼 상태
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'USER' | 'ADMIN'>('USER');
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ url: string; emailSent: boolean } | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // 부서 이동
  const [depts, setDepts] = useState<DeptOption[]>([]);
  const [movingId, setMovingId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [usersRes, invitesRes, deptsRes] = await Promise.all([
        fetch('/api/users').then(r => r.json()),
        fetch('/api/admin/invite').then(r => r.json()),
        fetch('/api/departments').then(r => r.json()),
      ]);
      if (usersRes.ok) setUsers(usersRes.data);
      if (invitesRes.ok) setInvitations(invitesRes.data);
      if (deptsRes.ok) setDepts(flattenDepts(deptsRes.data ?? []));
    } catch {
      setError('데이터를 불러올 수 없습니다.');
    } finally {
      setLoading(false);
    }
  }, []);

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
      setInviteResult({ url: result.data.inviteUrl, emailSent: Boolean(result.data.emailSent) });
      await loadData();
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : '초대 발송에 실패했습니다.');
    } finally {
      setInviting(false);
    }
  };

  const handleCancelInvite = async (id: string) => {
    if (!confirm('이 초대를 취소하시겠습니까?')) return;
    try {
      await fetch(`/api/admin/invite/${id}`, { method: 'DELETE' });
      setInvitations(prev => prev.filter(i => i.id !== id));
    } catch { alert('초대 취소에 실패했습니다.'); }
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
      setError(err instanceof Error ? err.message : '부서 이동에 실패했습니다.');
      // 실패했으면 화면이 실제 상태와 어긋나므로 다시 불러온다
      await loadData();
    } finally {
      setMovingId(null);
    }
  };

  const handleCopy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch { /* ignore */ }
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

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-red-600 text-sm">{error}</div>
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
                <div className="space-y-2">
                  {users.map(user => (
                    <div key={user.id} className="flex items-center justify-between p-4 bg-white border border-slate-100 rounded-xl hover:shadow-sm transition-shadow">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl bg-blue-50 flex items-center justify-center text-[#003087] font-bold text-sm">
                          {(user.full_name || user.email).charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-slate-900">{user.full_name || '(이름 없음)'}</p>
                          <p className="text-xs text-slate-400">{user.email}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <select
                          value={(user as any).department_id ?? ''}
                          onChange={e => handleMoveDepartment(user.id, e.target.value)}
                          disabled={movingId === user.id || depts.length === 0}
                          title="소속 부서 변경"
                          className="px-2.5 py-1.5 border border-slate-200 rounded-lg text-xs bg-white text-slate-700 max-w-[180px] disabled:opacity-50"
                        >
                          {depts.map(d => (
                            <option key={d.id} value={d.id}>
                              {' '.repeat(d.depth * 2)}{d.name}
                            </option>
                          ))}
                        </select>
                        <span className={`px-2.5 py-1 text-xs font-medium rounded-full ${
                          user.role === 'ADMIN' ? 'bg-purple-100 text-purple-700' : 'bg-slate-100 text-slate-600'
                        }`}>
                          {user.role === 'ADMIN' ? '관리자' : '일반 직원'}
                        </span>
                        <span className="text-xs text-slate-400">{formatDate(user.created_at)}</span>
                      </div>
                    </div>
                  ))}
                  {users.length === 0 && (
                    <div className="text-center py-8 text-slate-400 text-sm">등록된 사용자가 없습니다.</div>
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
                              <button onClick={() => handleCancelInvite(inv.id)} className="text-xs text-red-500 hover:text-red-700 font-medium">취소</button>
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
                    메일 발송이 설정되지 않아 자동 발송되지 않았습니다. 아래 링크를 직접 전달해주세요.
                    <br />
                    <span className="text-amber-700">자동 발송하려면 <code className="font-mono">RESEND_API_KEY</code>와 <code className="font-mono">MAIL_FROM</code> 환경변수를 설정하세요.</span>
                  </p>
                </div>
              )}

              <div>
                <p className="text-xs text-slate-500 mb-2 font-medium">초대 링크 (7일 유효)</p>
                <div className="flex items-center gap-2 p-3 bg-slate-50 border border-slate-200 rounded-xl">
                  <p className="flex-1 text-xs text-slate-700 truncate font-mono">{inviteResult.url}</p>
                  <button
                    onClick={() => handleCopy(inviteResult.url)}
                    className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                      copied ? 'bg-green-100 text-green-700' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {copied ? '복사됨' : '복사'}
                  </button>
                </div>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => { setInviteResult(null); setInviteEmail(''); }}
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
