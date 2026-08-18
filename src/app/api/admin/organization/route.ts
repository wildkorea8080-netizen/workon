import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * 기관 정보 — 기관명 / 로고 / 로그인 경로 / AI 고지 문구 (0020).
 *
 * 공공기관은 CI 사용이 규정 사항이라 화면에 기관 이름과 로고가 나와야
 * "우리 기관 시스템"으로 인식된다. 지금까지 브랜딩이 NEXT_PUBLIC_APP_NAME
 * 전역 단일값이라 기관마다 다르게 보여줄 방법이 아예 없었다.
 */

/** wrks.ai와 같은 기준. 로고는 화면 한 귀퉁이에 들어가므로 클 이유가 없다. */
const MAX_LOGO_BYTES = 500 * 1024;
const ALLOWED_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];

/** 영문 소문자·숫자·하이픈만. URL 경로에 그대로 들어간다. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

async function requireAdminOrg() {
  const session = await getServerAuthSession();
  if (!session?.user?.id || !isAdminSession(session)) {
    return {
      error: NextResponse.json(
        { ok: false, error: { message: '관리자 권한이 필요합니다.' } },
        { status: 403 }
      ),
    };
  }

  const departmentId = session.user.departmentId;
  if (!departmentId) {
    return {
      error: NextResponse.json(
        { ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } },
        { status: 403 }
      ),
    };
  }

  const { data } = await supabaseAdmin
    .from('departments')
    .select('organization_id')
    .eq('id', departmentId)
    .maybeSingle();

  const organizationId = data?.organization_id;
  if (!organizationId) {
    return {
      error: NextResponse.json(
        { ok: false, error: { message: '기관 정보를 찾을 수 없습니다.' } },
        { status: 409 }
      ),
    };
  }

  return { session, organizationId };
}

export async function GET() {
  const ctx = await requireAdminOrg();
  if ('error' in ctx) return ctx.error;

  const { data, error } = await supabaseAdmin
    .from('organizations')
    .select('id, name, slug, logo_url, ai_notice, domain, type')
    .eq('id', ctx.organizationId)
    .maybeSingle();

  if (error || !data) {
    console.error('[organization GET]', error);
    return NextResponse.json(
      { ok: false, error: { message: '기관 정보 조회에 실패했습니다.' } },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, data });
}

export async function PATCH(request: NextRequest) {
  const ctx = await requireAdminOrg();
  if ('error' in ctx) return ctx.error;

  // 로고는 파일이라 multipart로 온다. 나머지 필드만 바꿀 때는 JSON으로 온다.
  const contentType = request.headers.get('content-type') ?? '';
  const update: Record<string, unknown> = {};

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('logo');

    if (file instanceof File && file.size > 0) {
      if (!ALLOWED_LOGO_TYPES.includes(file.type)) {
        return NextResponse.json(
          { ok: false, error: { message: 'PNG, JPG, SVG, WEBP 파일만 올릴 수 있습니다.' } },
          { status: 400 }
        );
      }
      if (file.size > MAX_LOGO_BYTES) {
        return NextResponse.json(
          { ok: false, error: { message: '로고는 500KB 미만이어야 합니다.' } },
          { status: 400 }
        );
      }

      const ext = file.type.split('/')[1].replace('svg+xml', 'svg');
      // 기관마다 한 자리를 쓰고 덮어쓴다. 예전 파일이 쌓이지 않는다.
      const path = `branding/${ctx.organizationId}/logo.${ext}`;
      const buffer = Buffer.from(await file.arrayBuffer());

      const { error: uploadError } = await supabaseAdmin.storage
        .from(SUPABASE_DOCUMENTS_BUCKET)
        .upload(path, buffer, { contentType: file.type, upsert: true });

      if (uploadError) {
        console.error('[organization PATCH] 로고 업로드 실패', uploadError);
        return NextResponse.json(
          { ok: false, error: { message: '로고 업로드에 실패했습니다.' } },
          { status: 500 }
        );
      }

      // 버킷이 비공개라 공개 URL 대신 우리 라우트를 거친다.
      // 경로에 확장자를 남겨 두면 나중에 형식이 바뀌어도 찾을 수 있다.
      update.logo_url = path;
    }

    const name = form.get('name');
    if (typeof name === 'string' && name.trim()) update.name = name.trim();
  } else {
    const body = await request.json();

    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (!name) {
        return NextResponse.json(
          { ok: false, error: { message: '기관명을 입력해주세요.' } },
          { status: 400 }
        );
      }
      update.name = name;
    }

    if (body.slug !== undefined) {
      const slug = String(body.slug ?? '').trim().toLowerCase();
      if (slug && !SLUG_PATTERN.test(slug)) {
        return NextResponse.json(
          {
            ok: false,
            error: {
              message:
                '로그인 경로는 영문 소문자·숫자·하이픈으로 3~40자여야 하며, 하이픈으로 시작하거나 끝날 수 없습니다.',
            },
          },
          { status: 400 }
        );
      }
      update.slug = slug || null;
    }

    if (body.ai_notice !== undefined) {
      const notice = String(body.ai_notice ?? '').trim();
      update.ai_notice = notice || null;
    }

    // 로고 제거
    if (body.logo_url === null) update.logo_url = null;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json(
      { ok: false, error: { message: '변경할 내용이 없습니다.' } },
      { status: 400 }
    );
  }

  const { data, error } = await supabaseAdmin
    .from('organizations')
    .update(update)
    .eq('id', ctx.organizationId)
    .select('id, name, slug, logo_url, ai_notice, domain, type')
    .single();

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { ok: false, error: { message: '이미 사용 중인 로그인 경로입니다.' } },
        { status: 409 }
      );
    }
    console.error('[organization PATCH]', error);
    return NextResponse.json(
      { ok: false, error: { message: '기관 정보 저장에 실패했습니다.' } },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, data });
}
