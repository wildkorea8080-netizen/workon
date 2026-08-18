import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { APP_NAME } from '@/lib/config';
import { DEFAULT_AI_NOTICE } from '@/lib/branding';

export const dynamic = 'force-dynamic';

/**
 * 화면에 쓸 기관 브랜딩 (0020).
 *
 * **인증 없이 열린다.** 기관 전용 로그인 화면(/signin/{slug})이 로그인 전에
 * 기관명과 로고를 보여줘야 하기 때문이다. 기관명·로고는 기관 홈페이지에도
 * 공개돼 있는 정보라 노출 위험이 없다. 다만 그 외 항목은 절대 싣지 않는다 —
 * 도메인·연락처·한도는 인증 뒤에만 나가야 한다.
 *
 * 조회 방법 두 가지:
 *   ?slug=xxx  로그인 전. 경로로 기관을 특정한다
 *   (없음)      로그인 후. 세션의 소속 기관을 쓴다
 */

export async function GET(request: NextRequest) {
  const slug = new URL(request.url).searchParams.get('slug');

  let organizationId: string | null = null;

  if (slug) {
    const { data } = await supabaseAdmin
      .from('organizations')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();
    organizationId = data?.id ?? null;

    if (!organizationId) {
      // 존재하지 않는 경로. 기본 브랜딩으로 떨어뜨린다.
      // 404를 주면 어떤 slug가 존재하는지 확인하는 통로가 된다.
      return NextResponse.json({
        ok: true,
        data: { name: APP_NAME, logoUrl: null, slug: null, aiNotice: DEFAULT_AI_NOTICE },
      });
    }
  } else {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json({
        ok: true,
        data: { name: APP_NAME, logoUrl: null, slug: null, aiNotice: DEFAULT_AI_NOTICE },
      });
    }

    let departmentId = session.user.departmentId;
    if (!departmentId) {
      const { data } = await supabaseAdmin
        .from('users')
        .select('department_id')
        .eq('id', session.user.id)
        .maybeSingle();
      departmentId = data?.department_id ?? undefined;
    }

    if (departmentId) {
      const { data } = await supabaseAdmin
        .from('departments')
        .select('organization_id')
        .eq('id', departmentId)
        .maybeSingle();
      organizationId = data?.organization_id ?? null;
    }
  }

  if (!organizationId) {
    return NextResponse.json({
      ok: true,
      data: { name: APP_NAME, logoUrl: null, slug: null, aiNotice: DEFAULT_AI_NOTICE },
    });
  }

  const { data: org } = await supabaseAdmin
    .from('organizations')
    .select('name, slug, logo_url, ai_notice')
    .eq('id', organizationId)
    .maybeSingle();

  return NextResponse.json({
    ok: true,
    data: {
      name: org?.name || APP_NAME,
      slug: org?.slug ?? null,
      // 저장은 스토리지 경로다. 화면은 우리 라우트를 통해 받는다.
      logoUrl: org?.logo_url ? `/api/branding/logo?org=${organizationId}` : null,
      aiNotice: org?.ai_notice || DEFAULT_AI_NOTICE,
    },
  });
}
