import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { dbErrorText } from '@/lib/db-error-text';
import { writeAuditRow } from '@/lib/audit-write';

export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  try {
    const body = await request.json();
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (body.title      !== undefined) update.title       = body.title;
    if (body.content    !== undefined) update.content     = body.content;
    if (body.importance !== undefined) update.importance  = body.importance;
    if (body.targetType !== undefined) update.target_type = body.targetType;
    if (body.targetOrgIds !== undefined) update.target_org_ids = body.targetOrgIds;
    if (body.expiresAt  !== undefined) update.expires_at  = body.expiresAt;
    if (body.isPublished !== undefined) {
      update.is_published = body.isPublished;
      update.published_at = body.isPublished ? new Date().toISOString() : null;
    }

    const { data: before } = await supabaseAdmin.from('notices').select('title, is_published').eq('id', params.id).maybeSingle();
    const { data, error } = await supabaseAdmin
      .from('notices').update(update).eq('id', params.id).select().single();
    if (error) throw error;
    // 조작 기록(2026-11-17) — 본문은 남기지 않고 제목·발행 여부만
    await writeAuditRow('super_admin_logs', {
      admin_user_id: admin.sub,
      action: 'notice_updated',
      target_type: 'notice',
      target_id: params.id,
      before_data: before ? { title: before.title, is_published: before.is_published } : null,
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

  const { data: before } = await supabaseAdmin.from('notices').select('title, is_published').eq('id', params.id).maybeSingle();
  const { error } = await supabaseAdmin.from('notices').delete().eq('id', params.id);
  if (error) return NextResponse.json({ ok: false, error: dbErrorText(error) }, { status: 500 });
  await writeAuditRow('super_admin_logs', {
    admin_user_id: admin.sub,
    action: 'notice_deleted',
    target_type: 'notice',
    target_id: params.id,
    before_data: before ? { title: before.title, is_published: before.is_published } : null,
  }, 'notice_deleted');
  return NextResponse.json({ ok: true });
}
