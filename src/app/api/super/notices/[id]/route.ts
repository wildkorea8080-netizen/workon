import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

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

    const { data, error } = await supabaseAdmin
      .from('notices').update(update).eq('id', params.id).select().single();
    if (error) throw error;
    return NextResponse.json({ ok: true, data });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const { error } = await supabaseAdmin.from('notices').delete().eq('id', params.id);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
