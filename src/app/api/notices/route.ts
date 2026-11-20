import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { noticeVisibleTo, type NoticeRow } from '@/lib/notice-visibility';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 직원 화면의 공지(업무 틀·대화 화면 위 띠 — `NoticesBanner`).
 *
 * 2026-11-18 — 예전엔 대상 칸(`target_type`·`target_org_ids`)을 고르지 않은 채 그 칸으로 걸러 **모든 공지가 빠졌다**(운영 공지 1건,
 * 읽음 0건). 이제 대상(전체 또는 내 기관)·발행·기한을 DB 조회에서 걸고, 최근 발행 순 20건을 돌려준다(가장 중요한 것 고르기는 띠가 한다).
 */
export async function GET(_request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return NextResponse.json({ ok: true, data: [] });

  try {
    // 기관을 못 읽으면 '전체 공지만'으로 보이지 않는다(2026-11-19 — 예전엔 내 기관 공지가 조용히 빠졌다). 세션에 부서가 없으면 사용자 행에서
    const orgId = await getOrgIdOf(session.user.id, session.user.departmentId ?? null);
    const now = new Date().toISOString();

    let q = supabaseAdmin
      .from('notices')
      .select('id, title, content, importance, published_at, expires_at, target_type, target_org_ids')
      .eq('is_published', true)
      .or(`expires_at.is.null,expires_at.gt.${now}`);
    // 대상 — 전체 공지 또는 내 기관이 든 공지(기관을 모르면 전체 공지만)
    q = orgId && UUID.test(orgId)
      ? q.or(`target_type.eq.all,target_org_ids.cs.{${orgId}}`)
      : q.eq('target_type', 'all');

    const { data: notices, error } = await q.order('published_at', { ascending: false, nullsFirst: false }).limit(20);
    if (error) throw error;
    if (!notices?.length) return NextResponse.json({ ok: true, data: [] });

    const visible = (notices as NoticeRow[]).filter((n) => noticeVisibleTo(n, orgId));
    const ids = visible.map((n) => n.id);
    const { data: reads, error: readErr } = ids.length
      ? await supabaseAdmin.from('notice_reads').select('notice_id').eq('user_id', session.user.id).in('notice_id', ids)
      : { data: [], error: null };
    if (readErr) throw readErr;

    const readSet = new Set((reads ?? []).map((r: { notice_id: string }) => r.notice_id));
    const result = visible.map(({ target_type: _t, target_org_ids: _o, ...n }) => ({ ...n, isRead: readSet.has(n.id) }));
    return NextResponse.json({ ok: true, data: result });
  } catch (err) {
    console.warn('[notices GET]', (err as { code?: string })?.code ?? 'error');
    return NextResponse.json({ ok: false, error: { message: '공지를 불러오지 못했습니다.' } }, { status: 503 });
  }
}

async function getOrgIdOf(userId: string, sessionDeptId: string | null): Promise<string | null> {
  let deptId = sessionDeptId;
  if (!deptId) {
    const { data: user, error } = await supabaseAdmin.from('users').select('department_id').eq('id', userId).maybeSingle();
    if (error) throw error;
    deptId = (user as { department_id?: string | null } | null)?.department_id ?? null;
  }
  if (!deptId) return null;
  const { data, error } = await supabaseAdmin
    .from('departments').select('organization_id').eq('id', deptId).maybeSingle();
  if (error) throw error;
  return data?.organization_id ?? null;
}
