'use client';

import { useState, useEffect, useCallback } from 'react';
import type { User } from '@/lib/db';

interface Invitation {
  id: string;
  email: string;
  role: string;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' });
}

function isExpired(d: string) {
  return new Date(d) < new Date();
}

export default function UsersManager() {
  const [users, setUsers] = useState<User[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 초대 모달 상태
  const [showModal, setShowModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'USER' | 'ADMIN'>('USER');
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ url: string } | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [usersRes, invitesRes] = await Promise.all([
        fetch('/api/users').then(r => r.json()),
        fetch('/api/admin/invite').then(r => r.json()),
      ]);
      if (usersRes.ok) setUsers(usersRes.data);
      if (invitesRes.ok) setInvitations(invitesRes.data);
    } catch {
      setError('데이터를 불러올 수 없습니다.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const openModal = () => {
    setInviteEmail('');
    setInviteRole('USER');
    setInviteResult(null);
    setInviteError(null);
    setCopied(false);
    setShowModal(true);
  };

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
      setInviteResult({ url: result.data.inviteUrl });
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
    } catch {
      alert('초대 취소에 실패했습니다.');
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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-slate-500">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-600 mr-3" />
        로딩 중...
      </div>
    );
  }

  return (
    <div className="space-y-8">

      {/* 헤더 */}
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-semibold">사용자 관리</h2>
          <p className="text-slate-500 text-sm mt-1">부서 구성원을 초대하고 관리합니다.</p>
        </div>
        <button
          onClick={openModal}
          className="flex items-center gap-2 px-4 py-2.5 bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold rounded-xl transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
          </svg>
          직원 초대
        </button>
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-red-600 text-sm">{error}</div>
      )}

      {/* 등록된 사용자 목록 */}
      <section>
        <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3">
          등록된 사용자 ({users.length}명)
        </h3>
        <div className="space-y-2">
          {users.map(user => (
            <div key={user.id} className="flex items-center justify-between p-4 bg-white border border-slate-100 rounded-xl hover:shadow-sm transition-shadow">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-brand-100 flex items-center justify-center text-brand-700 font-bold text-sm">
                  {(user.full_name || user.email).charAt(0).toUpperCase()}
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-900">{user.full_name || '(이름 없음)'}</p>
                  <p className="text-xs text-slate-400">{user.email}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className={`px-2.5 py-1 text-xs font-medium rounded-full ${
                  user.role === 'ADMIN'
                    ? 'bg-purple-100 text-purple-700'
                    : 'bg-slate-100 text-slate-600'
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

      {/* 대기 중인 초대 */}
      {pendingInvitations.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3">
            대기 중인 초대 ({pendingInvitations.length}건)
          </h3>
          <div className="border border-slate-100 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">이메일</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">권한</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">만료일</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500">작업</th>
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
                      <button
                        onClick={() => handleCancelInvite(inv.id)}
                        className="text-xs text-red-500 hover:text-red-700 font-medium"
                      >
                        취소
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* 만료/수락된 초대 요약 */}
      {(expiredInvitations.length > 0 || acceptedInvitations.length > 0) && (
        <p className="text-xs text-slate-400">
          수락된 초대 {acceptedInvitations.length}건 · 만료된 초대 {expiredInvitations.length}건
        </p>
      )}

      {/* 초대 모달 */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-semibold text-slate-900">직원 초대</h3>
              <button
                onClick={() => setShowModal(false)}
                className="w-8 h-8 rounded-lg hover:bg-slate-100 flex items-center justify-center text-slate-400"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {!inviteResult ? (
              <form onSubmit={handleInvite} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">이메일 주소 <span className="text-red-400">*</span></label>
                  <input
                    type="email"
                    required
                    value={inviteEmail}
                    onChange={e => setInviteEmail(e.target.value)}
                    placeholder="colleague@company.com"
                    className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">권한</label>
                  <div className="flex gap-3">
                    {(['USER', 'ADMIN'] as const).map(r => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setInviteRole(r)}
                        className={`flex-1 py-2.5 rounded-xl text-sm font-medium border-2 transition-colors ${
                          inviteRole === r
                            ? 'border-brand-600 bg-brand-50 text-brand-700'
                            : 'border-slate-200 text-slate-500 hover:border-slate-300'
                        }`}
                      >
                        {r === 'USER' ? '일반 직원' : '관리자'}
                      </button>
                    ))}
                  </div>
                </div>

                {inviteError && (
                  <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">
                    {inviteError}
                  </div>
                )}

                <div className="flex gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowModal(false)}
                    className="flex-1 py-2.5 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50"
                  >
                    취소
                  </button>
                  <button
                    type="submit"
                    disabled={inviting}
                    className="flex-1 py-2.5 bg-brand-600 hover:bg-brand-700 disabled:bg-slate-300 text-white font-semibold rounded-xl text-sm transition-colors"
                  >
                    {inviting ? '초대 링크 생성 중...' : '초대 링크 생성'}
                  </button>
                </div>
              </form>
            ) : (
              <div className="space-y-5">
                <div className="flex items-center gap-3 p-4 bg-green-50 border border-green-200 rounded-xl">
                  <svg className="w-5 h-5 text-green-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                  </svg>
                  <p className="text-sm text-green-700 font-medium">초대 링크가 생성됐습니다!</p>
                </div>

                <div>
                  <p className="text-xs text-slate-500 mb-2 font-medium">초대 링크 (7일 유효)</p>
                  <div className="flex items-center gap-2 p-3 bg-slate-50 border border-slate-200 rounded-xl">
                    <p className="flex-1 text-xs text-slate-700 truncate font-mono">{inviteResult.url}</p>
                    <button
                      onClick={() => handleCopy(inviteResult.url)}
                      className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                        copied
                          ? 'bg-green-100 text-green-700'
                          : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {copied ? (
                        <>
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                          </svg>
                          복사됨
                        </>
                      ) : (
                        <>
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                          복사
                        </>
                      )}
                    </button>
                  </div>
                  <p className="mt-2 text-xs text-slate-400">이 링크를 초대할 직원에게 직접 전달하세요.</p>
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={() => { setInviteResult(null); setInviteEmail(''); }}
                    className="flex-1 py-2.5 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50"
                  >
                    추가 초대
                  </button>
                  <button
                    onClick={() => setShowModal(false)}
                    className="flex-1 py-2.5 bg-brand-600 hover:bg-brand-700 text-white font-semibold rounded-xl text-sm"
                  >
                    닫기
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
