import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * 기관 로고 파일 (0020).
 *
 * documents 버킷은 비공개라 공개 URL이 없다. 서명 URL은 만료되므로 화면에
 * 박아 두기 어렵고, 로고를 위해 별도 공개 버킷을 만들면 운영자가 버킷을 하나
 * 더 관리해야 한다. 그래서 이 라우트가 대신 흘려 준다.
 *
 * 인증을 걸지 않는 이유: 기관 전용 로그인 화면이 로그인 전에 로고를 그린다.
 * 로고는 기관 홈페이지에도 있는 공개 정보다.
 *
 * 다만 org 파라미터는 UUID로만 받는다. 임의 문자열을 그대로 스토리지 경로에
 * 넣으면 경로를 거슬러 올라가 다른 파일을 요청할 수 있다.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  const organizationId = new URL(request.url).searchParams.get('org') ?? '';

  if (!UUID_PATTERN.test(organizationId)) {
    return new NextResponse(null, { status: 400 });
  }

  const { data: org } = await supabaseAdmin
    .from('organizations')
    .select('logo_url')
    .eq('id', organizationId)
    .maybeSingle();

  const path = org?.logo_url;
  if (!path) return new NextResponse(null, { status: 404 });

  // DB에 적힌 경로가 정말 이 기관의 브랜딩 자리인지 확인한다.
  // 컬럼이 자유 텍스트라 예전 값이나 잘못된 값이 들어 있을 수 있다.
  if (!path.startsWith(`branding/${organizationId}/`)) {
    console.warn('[branding/logo] 예상 밖 경로:', path);
    return new NextResponse(null, { status: 404 });
  }

  const { data, error } = await supabaseAdmin.storage
    .from(SUPABASE_DOCUMENTS_BUCKET)
    .download(path);

  if (error || !data) return new NextResponse(null, { status: 404 });

  const buffer = Buffer.from(await data.arrayBuffer());

  return new NextResponse(buffer, {
    headers: {
      'Content-Type': data.type || 'image/png',
      // 로고는 자주 바뀌지 않는다. 매 화면마다 다시 받을 이유가 없다.
      // 바꾸면 같은 경로에 덮어쓰므로 최대 1시간 뒤 반영된다.
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
