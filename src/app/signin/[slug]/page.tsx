import { Suspense } from 'react';
import LoginForm from '@/components/auth/LoginForm';

/**
 * 기관 전용 로그인 경로 (0020).
 *
 * 직원에게 /signin/우리기관 을 안내하면 기관명과 로고가 붙은 로그인 화면이
 * 열린다. 웍스AI가 senGPT를 gov.wrks.ai로 분리해 "전용 시스템"으로 보이게 한
 * 것과 같은 효과를, 도메인을 나누지 않고 낸다.
 *
 * 없는 slug면 기본 브랜딩으로 떨어진다(/api/branding 참조). 404를 주면
 * 어떤 기관이 등록돼 있는지 확인하는 통로가 된다.
 */
export default function OrgSignInPage({ params }: { params: { slug: string } }) {
  return (
    <Suspense fallback={
      <main className="min-h-screen bg-gradient-to-br from-[#001a5c] via-[#003087] to-[#0066CC]" />
    }>
      <LoginForm slug={params.slug} />
    </Suspense>
  );
}
