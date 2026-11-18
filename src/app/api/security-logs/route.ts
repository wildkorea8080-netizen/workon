import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getManagedDepartmentIds } from '@/lib/department-scope';
import { SECURITY_EVENT_LABELS, SECURITY_SEVERITY_LABELS, securityDetailParts } from '@/lib/security-event-text';

export const dynamic = 'force-dynamic';

/**
 * 관리자 설정 화면의 '보안 이벤트 로그'(최근 몇 건). 전체 기간·CSV는 감사 화면(`/api/admin/audit-logs?kind=security`).
 *
 * 2026-11-18에 고친 것:
 * - **기록 원문(`details`)을 내보내지 않는다.** 금지어 기록에는 직원 질문의 앞 100자(`context`)가 들어 있어, 화면이 원문을 그대로 펼쳐
 *   사유를 적고 열람하는 길(감사 화면 '질문 원문 열람')을 거치지 않고 질문이 보였다. 이제 감사 화면과 같은 상세 한 줄만
 * - **관리 범위로 본다**(자기 부서 + 하위, 기관 직속 부서 관리자는 기관 전체) — 예전에는 자기 부서 한 곳만이라 감사 화면과 달랐다
 * - 사건 이름·심각도를 한국어로, 대상 이름은 관리 범위 안 직원만
 * - 수·대상 이름을 못 읽으면 0·'모름'으로 꾸미지 않고 500
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 숫자가 아니거나 범위 밖이면 기본값 */
function intParam(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw === null ? NaN : Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

const failed = () =>
  NextResponse.json({ ok: false, error: { message: '보안 로그 조회 중 오류가 발생했습니다.' } }, { status: 500 });

export async function GET(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    if (!isAdminSession(session)) {
      return NextResponse.json(
        { ok: false, error: { message: '관리자 권한이 필요합니다.' } },
        { status: 403 }
      );
    }

    const departmentId = session.user.departmentId;
    if (!departmentId) {
      return NextResponse.json(
        { ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } },
        { status: 403 }
      );
    }

    // 감사 화면과 같은 범위 — 못 읽으면 자기 부서만(좁히는 쪽)
    const managed = await getManagedDepartmentIds(departmentId);

    const { searchParams } = new URL(request.url);
    const limit = intParam(searchParams.get('limit'), 50, 1, 200);
    const offset = intParam(searchParams.get('offset'), 0, 0, 1_000_000);
    const eventType = searchParams.get('event_type');
    const severity = searchParams.get('severity');

    let query = supabaseAdmin
      .from('security_logs')
      .select(`
        id, event_type, severity, details, created_at,
        users:user_id (
          full_name,
          email
        )
      `)
      .in('department_id', managed)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (eventType) {
      query = query.eq('event_type', eventType);
    }

    if (severity) {
      query = query.eq('severity', severity);
    }

    const { data: logs, error } = await query;
    if (error) return failed();

    // 전체 개수 조회
    let countQuery = supabaseAdmin
      .from('security_logs')
      // 수만 센다 — 행은 받지 않는다(예전에는 개수를 세려고 최대 1,000행을 함께 받았다)
      .select('id', { count: 'exact', head: true })
      .in('department_id', managed);

    if (eventType) {
      countQuery = countQuery.eq('event_type', eventType);
    }

    if (severity) {
      countQuery = countQuery.eq('severity', severity);
    }

    const { count, error: countError } = await countQuery;
    if (countError || typeof count !== 'number') return failed();

    type Row = {
      id: string;
      event_type: string;
      severity: string;
      details: Record<string, unknown> | null;
      created_at: string;
      users: { full_name: string | null; email: string } | Array<{ full_name: string | null; email: string }> | null;
    };
    const rows = (logs ?? []) as unknown as Row[];

    // 대상 직원의 이름 — 관리 범위 안 사람만(범위 밖 사람의 이름은 내보내지 않는다)
    const targetIds = Array.from(new Set(
      rows
        .map((r) => r.details?.target_user_id)
        .filter((v): v is string => typeof v === 'string' && UUID.test(v))
    ));
    const names = new Map<string, string>();
    if (targetIds.length > 0) {
      const { data: targets, error: targetError } = await supabaseAdmin
        .from('users')
        .select('id, full_name')
        .in('id', targetIds)
        .in('department_id', managed);
      if (targetError) return failed();
      for (const t of (targets ?? []) as Array<{ id: string; full_name: string | null }>) {
        names.set(t.id, t.full_name ?? '(이름 없음)');
      }
    }

    return NextResponse.json({
      ok: true,
      data: {
        // `details`는 싣지 않는다 — 질문 글·패턴 원문이 들어 있다
        logs: rows.map((r) => ({
          id: r.id,
          event_type: r.event_type,
          label: SECURITY_EVENT_LABELS[r.event_type] ?? r.event_type,
          severity: r.severity,
          severity_label: SECURITY_SEVERITY_LABELS[r.severity] ?? r.severity,
          created_at: r.created_at,
          users: Array.isArray(r.users) ? r.users[0] ?? null : r.users,
          detail: securityDetailParts(r.details, (id) => names.get(id) ?? null).join(' / '),
        })),
        total: count,
        limit,
        offset,
      }
    });
  } catch (error) {
    console.error('보안 로그 조회 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
