import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const status = new URL(request.url).searchParams.get('status') ?? 'all';

  let query = supabaseAdmin
    .from('notices')
    .select('*, notice_reads(count)')
    .order('created_at', { ascending: false });

  if (status === 'published') query = query.eq('is_published', true);
  if (status === 'draft')     query = query.eq('is_published', false);

  const { data, error } = await query;
  if (error) {
    // notices 테이블 없을 경우 빈 배열 반환
    console.warn('[super/notices GET]', error.message);
    return NextResponse.json({ ok: true, data: [] });
  }

  const notices = (data ?? []).map((n: any) => ({
    ...n,
    readCount: n.notice_reads?.[0]?.count ?? 0,
    notice_reads: undefined,
  }));

  return NextResponse.json({ ok: true, data: notices });
}

export async function POST(request: NextRequest) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  try {
    const { title, content, importance, targetType, targetOrgIds, isPublished, expiresAt } = await request.json();
    if (!title || !content) return NextResponse.json({ ok: false, error: '제목, 내용 필수' }, { status: 400 });

    const { data, error } = await supabaseAdmin.from('notices').insert({
      title, content,
      importance:      importance  ?? 'normal',
      target_type:     targetType  ?? 'all',
      target_org_ids:  targetOrgIds ?? [],
      is_published:    isPublished ?? false,
      published_at:    isPublished ? new Date().toISOString() : null,
      expires_at:      expiresAt   ?? null,
      created_by:      admin.sub,
    }).select().single();

    if (error) throw error;
    return NextResponse.json({ ok: true, data });
  } catch (err: any) {
    console.error('[super/notices POST]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
