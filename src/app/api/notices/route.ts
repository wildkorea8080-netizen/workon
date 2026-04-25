import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return NextResponse.json({ ok: true, data: [] });

    const orgId = session.user.departmentId
      ? await getOrgIdFromDept(session.user.departmentId)
      : null;

    const now = new Date().toISOString();
    const { data: notices } = await supabaseAdmin
      .from('notices')
      .select('id, title, content, importance, published_at, expires_at')
      .eq('is_published', true)
      .or(`expires_at.is.null,expires_at.gt.${now}`)
      .order('importance', { ascending: false })
      .order('published_at', { ascending: false })
      .limit(10);

    if (!notices?.length) return NextResponse.json({ ok: true, data: [] });

    // 내 기관 공지만 필터
    const visible = notices.filter((n: any) =>
      n.target_type === 'all' ||
      (orgId && Array.isArray(n.target_org_ids) && n.target_org_ids.includes(orgId))
    );

    // 읽음 여부 확인
    const ids = visible.map((n: any) => n.id);
    const { data: reads } = await supabaseAdmin
      .from('notice_reads')
      .select('notice_id')
      .eq('user_id', session.user.id)
      .in('notice_id', ids);

    const readSet = new Set((reads ?? []).map((r: any) => r.notice_id));
    const result = visible.map((n: any) => ({ ...n, isRead: readSet.has(n.id) }));

    return NextResponse.json({ ok: true, data: result });
  } catch (err: any) {
    console.warn('[notices GET]', err.message);
    return NextResponse.json({ ok: true, data: [] });
  }
}

async function getOrgIdFromDept(deptId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('departments').select('organization_id').eq('id', deptId).maybeSingle();
  return data?.organization_id ?? null;
}
