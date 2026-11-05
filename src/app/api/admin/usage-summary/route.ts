import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getManagedDepartmentIds } from '@/lib/department-scope';
import { LEGACY_PRICING_MODEL_ID } from '@/lib/models';
import { pagedRows } from '@/lib/paged-select';
import { parseUsageGroups, usageRowsFromGroups, type UsageAxis } from '@/lib/usage-summary';

export const dynamic = 'force-dynamic';

/**
 * 이용통계 — 비서별 / 직원별 / 부서별 집계.
 *
 * 기존 /api/stats는 부서 단위 개수만 냈다. 감사나 정보공개 대응에서는
 * "어느 비서를 얼마나 썼는지", "누가 얼마나 썼는지"를 묻는데 그 단면이 없었다.
 *
 * 조회 범위는 관리자의 관리 범위(자기 부서 + 하위)로 한정한다.
 * 사용 내역 조회(/api/admin/audit-logs)와 같은 기준이다.
 *
 * **질문 원문은 싣지 않는다.** 여기는 집계 화면이고, 개별 내역이 필요하면
 * 사용 내역 조회를 쓴다. 집계에까지 원문을 흘리면 열람 범위만 넓어진다.
 */

type Axis = UsageAxis;

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function GET(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id || !isAdminSession(session)) {
    return NextResponse.json(
      { ok: false, error: { message: '관리자 권한이 필요합니다.' } },
      { status: 403 }
    );
  }

  const adminDeptId = session.user.departmentId;
  if (!adminDeptId) {
    return NextResponse.json(
      { ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } },
      { status: 403 }
    );
  }

  const managedDeptIds = await getManagedDepartmentIds(adminDeptId);

  const { searchParams } = new URL(request.url);
  const axis = (searchParams.get('by') ?? 'agent') as Axis;
  const isExport = searchParams.get('format') === 'csv';

  if (!['agent', 'user', 'department'].includes(axis)) {
    return NextResponse.json(
      { ok: false, error: { message: "by는 agent, user, department 중 하나여야 합니다." } },
      { status: 400 }
    );
  }

  // 기간 미지정 시 최근 30일. 감사 자료는 KST 기준으로 제출한다.
  const to = searchParams.get('to')
    ? new Date(`${searchParams.get('to')}T23:59:59+09:00`)
    : new Date();
  const from = searchParams.get('from')
    ? new Date(`${searchParams.get('from')}T00:00:00+09:00`)
    : new Date(to.getTime() - 30 * 86400000);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    return NextResponse.json(
      { ok: false, error: { message: '기간이 올바르지 않습니다.' } },
      { status: 400 }
    );
  }

  // (묶음 · 활동 · 모델)마다 DB가 센다(0058 usage_summary) — 예전에는 기록을 앱으로 읽어 묶어 50,000행에서 멈췄다(2026-11-05).
  // 2026-08 이전 기록에는 details.model이 없다 — 그때 돌던 모델(LEGACY)로 묶는다(sumCostUsd의 폴백과 같은 판단)
  const { data: grouped, error } = await supabaseAdmin.rpc('usage_summary', {
    p_department_ids: managedDeptIds,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    p_axis: axis,
    p_legacy_model: LEGACY_PRICING_MODEL_ID,
  });

  if (error) {
    console.error('[usage-summary]', error);
    return NextResponse.json(
      { ok: false, error: { message: '사용량 집계에 실패했습니다.' } },
      { status: 500 }
    );
  }

  // ── 이름 사전 ──
  // 기록에는 id만 있다. 묶은 뒤 이름을 붙인다(직원이 1,000명을 넘는 기관도 잘리지 않게 쪽 읽기). 보는 축의 사전만 읽는다
  const names = new Map<string, { name: string; sub: string }>();
  if (axis === 'user') {
    const { data: members } = await pagedRows<any>((a, b, w) => supabaseAdmin.from('users').select('id, full_name, email', w ? { count: 'exact' } : undefined).in('department_id', managedDeptIds).order('id').range(a, b));
    for (const m of members ?? []) names.set(m.id, { name: m.full_name ?? '(이름 없음)', sub: m.email ?? '' });
  } else if (axis === 'agent') {
    const { data: agents } = await pagedRows<any>((a, b, w) => supabaseAdmin.from('agents').select('id, name, icon', w ? { count: 'exact' } : undefined).in('department_id', managedDeptIds).order('id').range(a, b));
    for (const a of agents ?? []) names.set(a.id, { name: a.name, sub: a.icon ?? '' });
  } else {
    const { data: depts } = await supabaseAdmin.from('departments').select('id, name').in('id', managedDeptIds);
    for (const d of (depts ?? []) as Array<{ id: string; name: string }>) names.set(d.id, { name: d.name, sub: '' });
  }

  const rows = usageRowsFromGroups(parseUsageGroups(grouped), names);

  if (isExport) {
    const axisLabel = axis === 'agent' ? '비서별' : axis === 'user' ? '직원별' : '부서별';
    // **모델별로 한 줄씩 낸다.** 감사에서 "어떤 데이터가 어느 모델로 갔는가"를
    // 실제로 묻는데, 합계만 있으면 답할 수 없다.
    //
    // 합계 줄을 함께 넣지 않는 이유는, 비용 열을 통째로 더하는 사람이
    // 반드시 있기 때문이다. 두 층위를 한 파일에 섞으면 그 합이 두 배가 된다.
    // 모델 줄만 두면 열을 더한 값이 곧 총액이다.
    const headers = ['구분', '이름', '상세', '모델', '사용횟수', '입력토큰', '출력토큰', '비용(원)'];
    const lines = [
      headers.join(','),
      ...rows.flatMap((r) => {
        // 토큰을 쓰지 않은 활동만 있는 행(비서 생성 등)도 빠뜨리지 않는다
        const parts = r.models.length > 0
          ? r.models
          : [{ label: '(해당 없음)', count: r.count, inputTokens: 0, outputTokens: 0, costKrw: 0 }];

        return parts.map((m) =>
          [
            axisLabel,
            r.name,
            r.sub,
            m.label,
            m.count,
            m.inputTokens,
            m.outputTokens,
            Math.round(m.costKrw),
          ]
            .map(csvCell)
            .join(',')
        );
      }),
    ];
    const period = `${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}`;
    const filename = `이용통계_${axisLabel}_${period}.csv`;

    // Excel이 한글을 깨뜨리지 않도록 UTF-8 BOM을 붙인다
    return new NextResponse('﻿' + lines.join('\r\n') + '\r\n', {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store',
      },
    });
  }

  return NextResponse.json({
    ok: true,
    data: rows,
    meta: {
      axis,
      from: from.toISOString(),
      to: to.toISOString(),
      totalCount: rows.reduce((sum, r) => sum + r.count, 0),
      totalCostKrw: rows.reduce((sum, r) => sum + r.costKrw, 0),
    },
  });
}
