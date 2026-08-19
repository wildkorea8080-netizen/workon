import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getManagedDepartmentIds } from '@/lib/department-scope';

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

type Axis = 'agent' | 'user' | 'department';

interface SummaryRow {
  key: string;
  name: string;
  sub: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
  costKrw: number;
}

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

  const { data: logs, error } = await supabaseAdmin
    .from('usage_logs')
    .select('user_id, department_id, action, details, created_at')
    .in('department_id', managedDeptIds)
    .gte('created_at', from.toISOString())
    .lte('created_at', to.toISOString());

  if (error) {
    console.error('[usage-summary]', error);
    return NextResponse.json(
      { ok: false, error: { message: '사용량 집계에 실패했습니다.' } },
      { status: 500 }
    );
  }

  // ── 이름 사전 ──
  // 로그에는 id만 있다. 집계 후 이름을 붙이려면 미리 모아 둬야 한다.
  const [{ data: members }, { data: agents }, { data: depts }] = await Promise.all([
    supabaseAdmin.from('users').select('id, full_name, email').in('department_id', managedDeptIds),
    supabaseAdmin.from('agents').select('id, name, icon').in('department_id', managedDeptIds),
    supabaseAdmin.from('departments').select('id, name').in('id', managedDeptIds),
  ]);

  interface Named { name: string; sub: string }
  const memberMap = new Map<string, Named>(
    (members ?? []).map((m: any): [string, Named] => [
      m.id,
      { name: m.full_name ?? '(이름 없음)', sub: m.email ?? '' },
    ])
  );
  const agentMap = new Map<string, Named>(
    (agents ?? []).map((a: any): [string, Named] => [
      a.id,
      { name: a.name, sub: a.icon ?? '' },
    ])
  );
  const deptMap = new Map<string, Named>(
    (depts ?? []).map((d: any): [string, Named] => [d.id, { name: d.name, sub: '' }])
  );

  // ── 집계 ──
  const buckets = new Map<string, SummaryRow>();

  for (const log of (logs ?? []) as any[]) {
    const details = log.details ?? {};

    let key: string;
    let named: Named | undefined;

    if (axis === 'agent') {
      // 비서를 쓰지 않는 활동(문서 업로드·판독 등)은 비서별 집계 대상이 아니다.
      if (!details.agent_id) continue;
      key = details.agent_id;
      named = agentMap.get(key);
    } else if (axis === 'user') {
      key = log.user_id ?? '(알 수 없음)';
      named = memberMap.get(key);
    } else {
      key = log.department_id ?? '(알 수 없음)';
      named = deptMap.get(key);
    }

    const row = buckets.get(key) ?? {
      key,
      name: named?.name ?? '(삭제됨)',
      sub: named?.sub ?? '',
      count: 0,
      inputTokens: 0,
      outputTokens: 0,
      costKrw: 0,
    };

    row.count += 1;
    row.inputTokens += Number(details.input_tokens ?? 0);
    row.outputTokens += Number(details.output_tokens ?? 0);
    row.costKrw += Number(details.cost_krw ?? 0);
    buckets.set(key, row);
  }

  const rows = [...buckets.values()].sort((a, b) => b.costKrw - a.costKrw || b.count - a.count);

  if (isExport) {
    const axisLabel = axis === 'agent' ? '비서별' : axis === 'user' ? '직원별' : '부서별';
    const headers = ['구분', '이름', '상세', '사용횟수', '입력토큰', '출력토큰', '비용(원)'];
    const lines = [
      headers.join(','),
      ...rows.map((r) =>
        [
          axisLabel,
          r.name,
          r.sub,
          r.count,
          r.inputTokens,
          r.outputTokens,
          Math.round(r.costKrw),
        ]
          .map(csvCell)
          .join(',')
      ),
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
