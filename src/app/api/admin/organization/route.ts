import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { enabledModels } from '@/lib/models';
import { isValidIpPattern, parseIpList, clientIpFrom } from '@/lib/ip-access';
import { getAllowedModelIds } from '@/lib/model-policy';
import { DEFAULT_THEME_COLOR, normalizeHex, themeColorProblem } from '@/lib/theme-color';
import { actorScopeOr503 } from '@/lib/actor-scope-response';
import { writeAuditRow } from '@/lib/audit-write';
import { ORG_SLUG_PATTERN } from '@/lib/org-slug';
import { logSecurityEvent } from '@/lib/security-log';
import { organizationChanges, sameList } from '@/lib/organization-audit';

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

/** 영문 소문자·숫자·하이픈만. URL 경로에 그대로 들어간다 — 규칙은 슈퍼관리자 기관 등록과 한 곳(`org-slug.ts`) */
const SLUG_PATTERN = ORG_SLUG_PATTERN;

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

  const { data, error: readError } = await supabaseAdmin
    .from('departments')
    .select('organization_id')
    .eq('id', departmentId)
    .maybeSingle();

  // 못 읽은 것을 '기관 없음'으로 보지 않는다(2026-11-18)
  if (readError) {
    return {
      error: NextResponse.json(
        { ok: false, error: { message: '기관 정보를 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' } },
        { status: 503 }
      ),
    };
  }

  const organizationId = data?.organization_id;
  if (!organizationId) {
    return {
      error: NextResponse.json(
        { ok: false, error: { message: '기관 정보를 찾을 수 없습니다.' } },
        { status: 409 }
      ),
    };
  }

  return { session, departmentId, organizationId };
}

/** 화면이 받는 기관 칸 — 조회와 저장 응답이 **같은 칸**을 돌려준다 */
const ORG_COLUMNS =
  'id, name, slug, logo_url, ai_notice, theme_color, domain, type, allowed_models, allowed_ips, dormant_lock_days, dormant_lock_since';

/**
 * 화면이 받는 기관 정보 — 조회(GET)와 저장(PATCH)이 같은 꼴을 돌려준다(2026-11-18).
 * 예전 저장 응답에는 `allowed_ips`·`currentIp`·`availableModels`가 없었고 화면은 그 응답으로 상태를 통째로 바꿨다 —
 * 저장하고 나면 접속 허용 IP 칸이 비고 모델 목록이 사라졌으며, **그대로 한 번 더 저장하면 접속 허용 IP가 지워졌다.**
 */
async function organizationPayload(row: Record<string, unknown>, organizationId: string, request: NextRequest) {
  // 고를 수 있는 전체 모델과, 실제로 적용 중인 목록을 함께 준다.
  // 저장된 값에 레지스트리에서 사라진 모델이 남아 있을 수 있어
  // 화면이 그대로 믿으면 안 된다.
  return {
    ...row,
    // 지금 관리자가 접속한 주소. 허용 목록을 정할 때 이 값을 넣지 않으면
    // 저장하는 순간 본인부터 잠긴다. 화면이 그걸 막으려면 값을 알아야 한다.
    currentIp: clientIpFrom(request.headers, request.ip),
    effectiveModels: await getAllowedModelIds(organizationId),
    availableModels: enabledModels().map((m) => ({
      id: m.id,
      label: m.label,
      provider: m.provider,
      inputPerMTok: m.inputPerMTok,
      outputPerMTok: m.outputPerMTok,
    })),
  };
}

export async function GET(request: NextRequest) {
  const ctx = await requireAdminOrg();
  if ('error' in ctx) return ctx.error;

  const { data, error } = await supabaseAdmin
    .from('organizations')
    .select(ORG_COLUMNS)
    .eq('id', ctx.organizationId)
    .maybeSingle();

  if (error || !data) {
    console.error('[organization GET]', error);
    return NextResponse.json(
      { ok: false, error: { message: '기관 정보 조회에 실패했습니다.' } },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, data: await organizationPayload(data as Record<string, unknown>, ctx.organizationId, request) });
}

export async function PATCH(request: NextRequest) {
  const ctx = await requireAdminOrg();
  if ('error' in ctx) return ctx.error;

  // 기관 전체 설정(기관명·로그인 경로·허용 모델·접속 허용 IP·테마)은 기관 전체 관리자만(2026-11-16).
  // 예전엔 하위 부서 관리자도 바꿀 수 있어, 과 단위 관리자가 기관 전체의 접속 허용 IP·모델을 바꿀 수 있었다
  const scope = await actorScopeOr503(ctx.session);
  if (scope instanceof Response) return scope;
  if (!scope?.managesWholeOrganization) {
    return NextResponse.json(
      { ok: false, error: { message: '기관 정보는 기관 전체 관리자(최상위 부서 소속)만 바꿀 수 있습니다.' } },
      { status: 403 }
    );
  }

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
    let body: Record<string, any>;
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      body = parsed;
    } catch {
      return NextResponse.json({ ok: false, error: { message: '요청 형식이 올바르지 않습니다.' } }, { status: 400 });
    }

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

    // 테마 색 (0067) — null·빈 값이면 기본 청록. 흰 단추 글이 읽히지 않는 밝은 색은 거절
    if (body.theme_color !== undefined) {
      const raw = body.theme_color === null ? '' : String(body.theme_color).trim();
      if (!raw) {
        update.theme_color = null;
      } else {
        const problem = themeColorProblem(raw);
        if (problem) {
          return NextResponse.json({ ok: false, error: { message: problem } }, { status: 400 });
        }
        const hex = normalizeHex(raw);
        // 기본 색을 고르면 NULL로 둔다 — 기본 색을 나중에 바꿔도 따라가게
        update.theme_color = hex === DEFAULT_THEME_COLOR ? null : hex;
      }
    }

    // 허용 모델 정책 (0021)
    if (body.allowed_models !== undefined) {
      const known = new Set(enabledModels().map((m) => m.id));
      const requested = Array.isArray(body.allowed_models) ? body.allowed_models : [];
      const valid = requested.filter((id: unknown) => typeof id === 'string' && known.has(id));

      if (requested.length > 0 && valid.length === 0) {
        return NextResponse.json(
          { ok: false, error: { message: '선택한 모델을 찾을 수 없습니다.' } },
          { status: 400 }
        );
      }

      // 빈 배열을 그대로 저장하면 그 기관은 아무 대화도 못 하게 잠긴다.
      // 정책 계층이 기본 모델로 되돌리지만, 저장값도 NULL로 두어
      // "정하지 않음"과 "아무것도 허용 안 함"이 뒤섞이지 않게 한다.
      update.allowed_models = valid.length > 0 ? valid : null;
    }

    // 접속 허용 IP (0023)
    if (body.allowed_ips !== undefined) {
      const raw =
        typeof body.allowed_ips === 'string'
          ? parseIpList(body.allowed_ips)
          : Array.isArray(body.allowed_ips)
          ? body.allowed_ips.map((v: unknown) => String(v ?? '').trim()).filter(Boolean)
          : [];

      // 오타 하나가 조용히 아무에게도 안 맞는 항목으로 남으면, 관리자는
      // 막았다고 믿는데 그 대역만 빠져 있다. 저장 전에 알려준다.
      const bad = raw.filter((p: string) => !isValidIpPattern(p));
      if (bad.length > 0) {
        return NextResponse.json(
          {
            ok: false,
            error: {
              message: `IP 형식이 올바르지 않습니다: ${bad.slice(0, 3).join(', ')}`,
            },
          },
          { status: 400 }
        );
      }

      // 빈 값은 NULL로. 빈 배열을 저장하면 "정하지 않음"과 구분되지 않는다
      // (allowed_models와 같은 규칙).
      update.allowed_ips = raw.length > 0 ? raw : null;
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

  // 고치기 전 값 — 모델 정책·접속 허용 IP는 이력을 남긴다. 보안성 검토와 감사에서 "그 시점에 무엇이
  // 허용돼 있었는가"를 실제로 묻는데, 현재 값만 보관하면 답할 수 없다.
  // 못 읽으면 저장하지 않는다 — 예전에는 읽기 오류를 '정한 적 없음'으로 보고 이력에 남겼다(2026-11-18).
  const { data: beforeRow, error: beforeError } = await supabaseAdmin
    .from('organizations')
    .select(ORG_COLUMNS)
    .eq('id', ctx.organizationId)
    .maybeSingle();
  if (beforeError || !beforeRow) {
    console.error('[organization PATCH] 고치기 전 값 조회 실패', beforeError);
    return NextResponse.json(
      { ok: false, error: { message: '기관 정보를 확인하지 못해 저장하지 않았습니다. 잠시 뒤 다시 시도해 주세요.' } },
      { status: 503 }
    );
  }
  const before = beforeRow as Record<string, unknown>;
  const beforeModels = (before.allowed_models as string[] | null) ?? null;

  const { data, error } = await supabaseAdmin
    .from('organizations')
    .update(update)
    .eq('id', ctx.organizationId)
    .select(ORG_COLUMNS)
    .single();

  if (error || !data) {
    if (error?.code === '23505') {
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

  // 화면은 저장할 때마다 모든 칸을 보낸다 — **실제로 달라졌을 때만** 이력을 남긴다(예전엔 이름만 고쳐도 모델 정책 이력이 한 줄씩 쌓였다)
  const afterModels = (update.allowed_models as string[] | null | undefined) ?? null;
  if (update.allowed_models !== undefined && !sameList(beforeModels, afterModels)) {
    await writeAuditRow('model_policy_logs', {
      organization_id: ctx.organizationId,
      changed_by: ctx.session.user.id,
      before_models: beforeModels,
      after_models: afterModels,
    }, 'allowed_models_changed');
  }

  // 접속 허용 IP·기관 정보 변경을 보안 로그에(2026-11-18 — 접속 허용 IP를 바꾸거나 없애도 어디에도 남지 않았다).
  // 기록 실패는 저장을 되돌리지 않는다(실패는 운영 기록에 남는다)
  const changed = organizationChanges(before, update);
  const mark = ctx.session.user.isImpersonating ? { impersonating: true } : {};
  if (changed.ips) {
    await logSecurityEvent(ctx.departmentId, ctx.session.user.id, 'org_access_ips_changed', { ...changed.ips, ...mark }, 'high');
  }
  if (changed.info) {
    await logSecurityEvent(ctx.departmentId, ctx.session.user.id, 'organization_updated', { ...changed.info, ...mark }, 'low');
  }

  return NextResponse.json({ ok: true, data: await organizationPayload(data as Record<string, unknown>, ctx.organizationId, request) });
}
