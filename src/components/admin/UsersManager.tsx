'use client';

import { useState, useEffect } from 'react';
import type { User } from '@/lib/db';

interface UserFormData {
  email: string;
  full_name: string;
  role: 'USER' | 'ADMIN';
}

export default function UsersManager() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [formData, setFormData] = useState<UserFormData>({
    email: '',
    full_name: '',
    role: 'USER',
  });

  useEffect(() => {
    loadUsers();
  }, []);

  const loadUsers = async () => {
    try {
      const response = await fetch('/api/users');
      const result = await response.json();

      if (!result.ok) {
        throw new Error(result.error?.message || '사용자 목록을 불러올 수 없습니다.');
      }

      setUsers(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '알 수 없는 오류');
    } finally {
      setLoading(false);
    }
  };

  const handleInviteUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviting(true);

    try {
      const response = await fetch('/api/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(formData),
      });

      const result = await response.json();

      if (!result.ok) {
        throw new Error(result.error?.message || '사용자 초대에 실패했습니다.');
      }

      // 성공 시 목록 새로고침
      await loadUsers();
      setShowInviteForm(false);
      setFormData({ email: '', full_name: '', role: 'USER' });
      alert(result.message || '사용자가 성공적으로 초대되었습니다.');
    } catch (err) {
      alert(err instanceof Error ? err.message : '알 수 없는 오류가 발생했습니다.');
    } finally {
      setInviting(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('ko-KR', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-slate-600"></div>
        <span className="ml-3 text-slate-600">로딩 중...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-semibold">부서 사용자 목록</h2>
          <p className="text-slate-600 mt-1">현재 부서의 모든 사용자를 확인하고 관리할 수 있습니다.</p>
        </div>
        <button
          onClick={() => setShowInviteForm(true)}
          className="px-4 py-2 bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition-colors flex items-center space-x-2"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          <span>사용자 초대</span>
        </button>
      </div>

      {error && (
        <div className="p-4 text-red-700 bg-red-100 rounded-lg border border-red-200">
          <div className="flex items-center space-x-2">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>{error}</span>
          </div>
        </div>
      )}

      {/* 초대 폼 */}
      {showInviteForm && (
        <div className="p-6 border rounded-lg bg-white shadow-sm">
          <h3 className="text-lg font-medium mb-4">새 사용자 초대</h3>
          <form onSubmit={handleInviteUser} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-slate-700 mb-1">
                이메일 주소 *
              </label>
              <input
                type="email"
                id="email"
                required
                value={formData.email}
                onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
                className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-500 focus:border-slate-500"
                placeholder="user@example.com"
              />
            </div>

            <div>
              <label htmlFor="full_name" className="block text-sm font-medium text-slate-700 mb-1">
                이름
              </label>
              <input
                type="text"
                id="full_name"
                value={formData.full_name}
                onChange={(e) => setFormData(prev => ({ ...prev, full_name: e.target.value }))}
                className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-500 focus:border-slate-500"
                placeholder="홍길동"
              />
            </div>

            <div>
              <label htmlFor="role" className="block text-sm font-medium text-slate-700 mb-1">
                권한
              </label>
              <select
                id="role"
                value={formData.role}
                onChange={(e) => setFormData(prev => ({ ...prev, role: e.target.value as 'USER' | 'ADMIN' }))}
                className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-500 focus:border-slate-500"
              >
                <option value="USER">일반 사용자</option>
                <option value="ADMIN">관리자</option>
              </select>
            </div>

            <div className="flex justify-end space-x-3 pt-4">
              <button
                type="button"
                onClick={() => setShowInviteForm(false)}
                className="px-4 py-2 text-slate-600 border border-slate-300 rounded-md hover:bg-slate-50 transition-colors"
              >
                취소
              </button>
              <button
                type="submit"
                disabled={inviting}
                className="px-4 py-2 bg-slate-900 text-white rounded-md hover:bg-slate-800 disabled:bg-slate-400 disabled:cursor-not-allowed flex items-center space-x-2"
              >
                {inviting && (
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                )}
                <span>{inviting ? '초대 중...' : '초대하기'}</span>
              </button>
            </div>
          </form>
        </div>
      )}

      {/* 사용자 목록 */}
      <div className="space-y-3">
        {users.map((user) => (
          <div key={user.id} className="p-4 border rounded-lg bg-white hover:shadow-sm transition-shadow">
            <div className="flex justify-between items-start">
              <div className="flex-1">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center">
                    <span className="text-sm font-medium text-slate-600">
                      {(user.full_name || user.email).charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div>
                    <h3 className="font-medium text-slate-900">{user.email}</h3>
                    {user.full_name && (
                      <p className="text-sm text-slate-600">{user.full_name}</p>
                    )}
                  </div>
                </div>
                <div className="mt-2 flex items-center space-x-4 text-xs text-slate-500">
                  <span>가입일: {formatDate(user.created_at)}</span>
                </div>
              </div>
              <div className="flex items-center space-x-3">
                <span className={`px-2 py-1 text-xs rounded-full ${
                  user.role === 'ADMIN'
                    ? 'bg-purple-100 text-purple-800'
                    : 'bg-blue-100 text-blue-800'
                }`}>
                  {user.role === 'ADMIN' ? '관리자' : '사용자'}
                </span>
              </div>
            </div>
          </div>
        ))}

        {users.length === 0 && !error && (
          <div className="text-center py-12 text-slate-500">
            <svg className="w-12 h-12 mx-auto mb-4 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197m13.5-9a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z" />
            </svg>
            <div className="text-sm">아직 초대된 사용자가 없습니다.</div>
            <div className="text-xs mt-1">사용자 초대 버튼을 클릭해서 첫 사용자를 초대해보세요.</div>
          </div>
        )}
      </div>
    </div>
  );
}