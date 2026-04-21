'use client';

import { signOut, useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import ChatInterface from '@/components/chat/ChatInterface';
import Shell from '@/components/Shell';
import Link from 'next/link';

export default function HomePage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === 'loading') return;
    if (!session) {
      return;
    }
  }, [session, status, router]);

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-slate-600">로딩 중...</div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center px-4">
        <div className="max-w-md w-full space-y-8">
          <div className="text-center">
            <h1 className="text-4xl font-bold text-gray-900 mb-2">WORKON</h1>
            <p className="text-lg text-gray-600">AI 기반 문서 관리 및 보고서 생성 플랫폼</p>
          </div>

          <div className="space-y-4">
            <div className="bg-white rounded-lg shadow-lg p-6 border border-gray-200">
              <h2 className="text-xl font-semibold text-gray-900 mb-4 text-center">로그인 유형 선택</h2>

              <div className="space-y-3">
                <Link
                  href="/login?role=admin"
                  className="w-full flex items-center justify-center px-4 py-3 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
                >
                  <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                  관리자로 로그인
                </Link>

                <Link
                  href="/login?role=user"
                  className="w-full flex items-center justify-center px-4 py-3 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
                >
                  <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  사용자로 로그인
                </Link>

                <Link
                  href="/signup"
                  className="w-full flex items-center justify-center px-4 py-3 text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 transition-colors"
                >
                  회원가입
                </Link>
              </div>
            </div>
            <div className="text-center text-sm text-gray-500">
              <p>WORKON은 부서별 데이터 격리로 안전한 협업을 제공합니다.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const departmentId = session.user.departmentId;
  if (!departmentId) {
    return (
      <Shell>
        <div className="min-h-[60vh] flex flex-col items-center justify-center text-center space-y-4">
          <h1 className="text-2xl font-semibold text-gray-900">부서 정보가 없습니다</h1>
          <p className="text-slate-600 max-w-md">
            로그인은 되었지만 사용자 정보에 부서가 등록되어 있지 않습니다. 로그아웃 후 다시 로그인하거나 관리자에게 부서 할당을 요청해주세요.
          </p>
          <button
            type="button"
            onClick={() => signOut({ callbackUrl: '/' })}
            className="inline-flex items-center justify-center px-4 py-3 text-sm font-medium text-white bg-slate-900 rounded-lg"
          >
            로그아웃 후 재시도
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex h-[calc(100vh-4rem)] bg-white">
        <ChatInterface />
      </div>
    </Shell>
  );
}
