import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { dbErrorText } from '@/lib/db-error-text';
import { writeAuditRow } from '@/lib/audit-write';
import { parseNoticeInput } from '@/lib/notice-input';

export const dynamic = 'force-dynamic';

// PATCH: 공지 고치기·발행/취소
//
// 2026-11-19 — 입력을 먼저 본다(`parseNoticeInput`). 또 예전에는 발행된 공지를 고칠 때마다(화면이 발행 여부를 늘 보냄)
// 발행 시각을 지금으로 다시 찍어 오래된 공지가 새 공지처럼 맨 위로 올라왔고, 대상이 없으면 500이었다.
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const parsed = parseNoticeInput(await request.json().catch(() => null), true);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.message }, { status: 400 });
  const v = parsed.value;

  try {
    const { data: before, error: beforeError } = await supabaseAdmin
      .from('notices').select('title, is_published, target_type, target_org_ids').eq('id', params.id).maybeSingle();
    if (beforeError) return NextResponse.json({ ok: false, error: '공지를 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }, { status: 503 });
    if (!before) return NextResponse.json({ ok: false, error: '공지를 찾을 수 없습니다.' }, { status: 404 });

    // 대상은 지금 값과 합쳐 본다 — '특정 기관'인데 기관이 하나도 없으면 아무에게도 안 보인다
    const targetType = v.targetType ?? before.target_type;
    const targetOrgIds = v.targetOrgIds ?? (before.target_org_ids ?? []);
    if (targetType === 'specific' && targetOrgIds.length === 0)
      return NextResponse.json({ ok: false, error: '특정 기관 공지는 대상 기관을 하나 이상 고르세요.' }, { status: 400 });

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (v.title      !== undefined) update.title       = v.title;
    if (v.content    !== undefined) update.content     = v.content;
    if (v.importance !== undefined) update.importance  = v.importance;
    if (v.targetType !== undefined) update.target_type = v.targetType;
    if (v.targetOrgIds !== undefined || v.targetType === 'all') update.target_org_ids = targetType === 'all' ? [] : targetOrgIds;
    if (v.expiresAt  !== undefined) update.expires_at  = v.expiresAt;
    if (v.isPublished !== undefined) {
      update.is_published = v.isPublished;
      // 발행 시각은 새로 발행할 때만 찍는다 — 발행된 공지를 고쳐도 그대로
      if (v.isPublished && !before.is_published) update.published_at = new Date().toISOString();
      if (!v.isPublished) update.published_at = null;
    }

    const { data, error } = await supabaseAdmin
      .from('notices').update(update).eq('id', params.id).select().maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ ok: false, error: '공지를 찾을 수 없습니다.' }, { status: 404 });
    // 조작 기록(2026-11-17) — 본문은 남기지 않고 제목·발행 여부만
    await writeAuditRow('super_admin_logs', {
      admin_user_id: admin.sub,
      action: 'notice_updated',
      target_type: 'notice',
      target_id: params.id,
      before_data: { title: before.title, is_published: before.is_published },
      after_data: { title: data.title, is_published: data.is_published },
    }, 'notice_updated');
    return NextResponse.json({ ok: true, data });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: dbErrorText(err) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin)
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  // 지우기 전 값 — 못 읽으면 지우지 않는다, 없으면 404(2026-11-19 — 예전엔 없는 공지도 '삭제됨'·기록만 남았다)
  const { data: before, error: beforeError } = await supabaseAdmin.from('notices').select('title, is_published').eq('id', params.id).maybeSingle();
  if (beforeError) return NextResponse.json({ ok: false, error: '공지를 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }, { status: 503 });
  if (!before) return NextResponse.json({ ok: false, error: '공지를 찾을 수 없습니다.' }, { status: 404 });
  const { error } = await supabaseAdmin.from('notices').delete().eq('id', params.id);
  if (error) return NextResponse.json({ ok: false, error: dbErrorText(error) }, { status: 500 });
  await writeAuditRow('super_admin_logs', {
    admin_user_id: admin.sub,
    action: 'notice_deleted',
    target_type: 'notice',
    target_id: params.id,
    before_data: { title: before.title, is_published: before.is_published },
  }, 'notice_deleted');
  return NextResponse.json({ ok: true });
}
