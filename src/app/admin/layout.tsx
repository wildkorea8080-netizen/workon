import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import Link from 'next/link';
import AdminSidebar from '@/components/admin/AdminSidebar';
import ImpersonateBanner from '@/components/admin/ImpersonateBanner';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { APP_NAME } from '@/lib/config';
import { themeStyle } from '@/lib/theme-color';
import type { CSSProperties } from 'react';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerAuthSession();
  const isAdmin = isAdminSession(session);

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-red-600">접근 거부</h1>
          <p className="text-slate-600 mt-2">관리자 권한이 필요합니다.</p>
          <Link href="/" className="inline-block mt-4 px-4 py-2 bg-ws-accent text-white rounded-xl hover:bg-ws-accent-hover">
            돌아가기
          </Link>
        </div>
      </div>
    );
  }

  const isImpersonating = session?.user?.isImpersonating === true;
  const orgName = session?.user?.impersonateOrgName ?? '';

  // 기관 브랜딩 (0020). 서버 컴포넌트라 여기서 바로 읽는다.
  // 클라이언트에서 받아오면 첫 화면에 기본 이름이 잠깐 스쳤다가 바뀐다.
  let brandName = APP_NAME;
  let brandLogo: string | null = null;
  // 기관 테마 색(0067) — 직원 화면과 같은 색으로 단추·고른 메뉴를 칠한다. 못 읽거나 없으면 기본 청록(globals.css :root)
  let themeColor: string | null = null;
  const departmentId = session?.user?.departmentId;
  if (departmentId) {
    const { data: dept } = await supabaseAdmin
      .from('departments')
      .select('organization_id')
      .eq('id', departmentId)
      .maybeSingle();
    if (dept?.organization_id) {
      const { data: org } = await supabaseAdmin
        .from('organizations')
        .select('name, logo_url, theme_color')
        .eq('id', dept.organization_id)
        .maybeSingle();
      if (org?.name) brandName = org.name;
      if (org?.logo_url) brandLogo = `/api/branding/logo?org=${dept.organization_id}`;
      if (typeof org?.theme_color === 'string') themeColor = org.theme_color;
    }
  }

  return (
    // 직원 화면(업무 틀)과 같은 바탕·글꼴·테마 색(2026-11-27) — 예전엔 짙은 남색 사이드바에 박힌 남색이라 다른 제품처럼 보였다
    <div
      className="flex h-screen flex-col bg-[#F7F8FC] text-[#22283D] md:flex-row"
      style={{ fontFamily: 'Pretendard, -apple-system, sans-serif', ...((themeStyle(themeColor) ?? {}) as CSSProperties) }}
    >
      {/* 대리 접근 배너 */}
      {isImpersonating && <ImpersonateBanner orgName={orgName} />}

      {/* 대리 접근 중이면 띠(52px) 아래로 민다 — 사이드바·작은 화면 막대는 AdminSidebar가, 넓은 화면 콘텐츠는 아래가 */}
      <AdminSidebar brandName={brandName} brandLogo={brandLogo} email={session?.user?.email ?? ''} isImpersonating={isImpersonating} />

      {/* 우측 콘텐츠 */}
      <div className={`flex min-w-0 flex-1 flex-col overflow-hidden ${isImpersonating ? 'md:mt-[52px]' : ''}`}>
        <main className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
