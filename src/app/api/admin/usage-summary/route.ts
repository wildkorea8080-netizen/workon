import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getManagedDepartmentIds } from '@/lib/department-scope';
import { getModel, LEGACY_PRICING_MODEL_ID } from '@/lib/models';

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

/** 한 행 안에서 모델·활동별로 다시 나눈 내역 */
interface Breakdown {
  key: string;
  label: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
  costKrw: number;
}

interface SummaryRow {
  key: string;
  name: string;
  sub: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
  costKrw: number;
  /**
   * 어떤 모델을 얼마나 썼는지 (0021 이후 모델이 넷).
   *
   * 합계만 보면 "이 부서가 비싸다"까지는 알아도 **왜 비싼지**를 모른다.
   * Opus를 쓰고 있는 것과 Haiku를 많이 쓰는 것은 대응이 다르다.
   * 기록은 usage_logs.details.model에 이미 들어 있었고 화면에 내지 않았을
   * 뿐이다.
   */
  models: Breakdown[];
  /** 어떤 종류의 활동인지 (대화·문서 판독·Q&A·보고서) */
  actions: Breakdown[];
}

/** usage_logs.action을 담당자가 읽을 말로. 감사 화면과 같은 어휘를 쓴다. */
const ACTION_LABELS: Record<string, string> = {
  chat_message: 'AI 대화',
  qna_search: '문서 질의',
  generate_report: '보고서 생성',
  document_ocr: '스캔 문서 판독',
};

function bump(list: Breakdown[], key: string, label: string, d: any) {
  let row = list.find((r) => r.key === key);
  if (!row) {
    row = { key, label, count: 0, inputTokens: 0, outputTokens: 0, costKrw: 0 };
    list.push(row);
  }
  row.count += 1;
  row.inputTokens += Number(d.input_tokens ?? 0);
  row.outputTokens += Number(d.output_tokens ?? 0);
  row.costKrw += Number(d.cost_krw ?? 0);
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
      models: [],
      actions: [],
    };

    row.count += 1;
    row.inputTokens += Number(details.input_tokens ?? 0);
    row.outputTokens += Number(details.output_tokens ?? 0);
    row.costKrw += Number(details.cost_krw ?? 0);

    // 2026-08 이전 로그에는 details.model이 없다. 그때 실제로 돌던 모델은
    // 하나뿐이었으므로 그 값으로 묶는다 — sumCostUsd의 폴백과 같은 판단이고,
    // 기본 모델을 바꿔도 과거 집계가 흔들리지 않도록 LEGACY 상수를 쓴다.
    if (Number(details.input_tokens ?? 0) > 0 || Number(details.output_tokens ?? 0) > 0) {
      const modelId = String(details.model ?? LEGACY_PRICING_MODEL_ID);
      bump(row.models, modelId, getModel(modelId).label, details);
    }
    bump(row.actions, log.action, ACTION_LABELS[log.action] ?? log.action, details);

    buckets.set(key, row);
  }

  const rows = [...buckets.values()].sort((a, b) => b.costKrw - a.costKrw || b.count - a.count);
  for (const row of rows) {
    row.models.sort((a, b) => b.costKrw - a.costKrw || b.count - a.count);
    row.actions.sort((a, b) => b.count - a.count);
  }

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
