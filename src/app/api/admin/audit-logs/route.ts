import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getManagedDepartmentIds } from '@/lib/department-scope';
import { sumCostUsd, usdToKrw } from '@/lib/models';
import { logSecurityEvent } from '@/lib/filter';

export const dynamic = 'force-dynamic';

/**
 * 감사 대응용 사용 내역 조회·추출.
 *
 * 공공기관은 감사나 정보공개 청구가 들어오면 "특정 기간, 특정 직원의 AI 사용
 * 내역"을 제출해야 합니다. 화면에 보이는 페이지만으로는 대응이 안 되므로
 * 기간 전체를 CSV로 내려받을 수 있어야 합니다.
 *
 * 조회 범위는 관리자의 관리 범위(자기 부서 + 하위 부서)로 한정됩니다.
 */

/** 한 번에 내보낼 수 있는 최대 건수. 그 이상은 기간을 나눠 받도록 안내한다. */
const MAX_EXPORT_ROWS = 50_000;

/**
 * 질문 원문 열람 기준.
 *
 * 직원이 무엇을 물었는지는 감사에 필요할 수 있지만, 상시로 열려 있으면
 * 근로자 감시가 된다. 감사 CSV는 정보공개 청구로 기관 밖에 나갈 수도 있다.
 * 그래서 기본은 가리고, 사유를 남기고 명시적으로 요청할 때만 연다.
 *
 * 저장 자체를 막지 않는 이유: 실제 감사에서 "무엇을 물었는지"를 제출하라는
 * 요구가 들어오면 없는 자료는 만들 수 없다. 수집은 하되 열람을 통제한다.
 */
const QUERY_PREVIEW_CHARS = 12;

/** 질문 원문을 앞 일부만 남기고 가린다. 무엇에 관한 건지는 알 수 있게 둔다. */
function maskQuery(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (trimmed.length <= QUERY_PREVIEW_CHARS) return `${trimmed} (…)`;
  return `${trimmed.slice(0, QUERY_PREVIEW_CHARS)}… (전문 비공개)`;
}
const DEFAULT_PAGE_SIZE = 100;

type LogKind = 'usage' | 'security';

interface AuditRow {
  일시: string;
  구분: string;
  직원: string;
  이메일: string;
  부서: string;
  활동: string;
  상세: string;
  모델: string;
  입력토큰: number | '';
  출력토큰: number | '';
  '비용(원)': number | '';
}

/** 활동 코드 → 한국어. 감사 자료는 담당자가 바로 읽을 수 있어야 한다. */
const ACTION_LABEL: Record<string, string> = {
  chat_message: 'AI 대화',
  qna_search: '문서 질의응답',
  generate_report: '보고서 생성',
  document_ocr: '스캔 문서 판독',
  create_agent: '비서 생성',
  add_forbidden_word: '금지어 추가',
  delete_forbidden_word: '금지어 삭제',
  activate_forbidden_word: '금지어 활성화',
  deactivate_forbidden_word: '금지어 비활성화',
};

const SECURITY_LABEL: Record<string, string> = {
  query_revealed: '질문 원문 열람',
  forbidden_word: '금지어 감지',
  personal_info: '개인정보 패턴 감지',
  blocked_upload: '업로드 차단',
  rate_limit: '요청 제한',
};

const SEVERITY_LABEL: Record<string, string> = {
  low: '낮음',
  medium: '보통',
  high: '높음',
  critical: '심각',
};

function formatDateTime(iso: string) {
  // 감사 자료는 한국 시간 기준으로 제출한다
  return new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
}

/** CSV 한 칸 이스케이프 */
function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows: AuditRow[]): string {
  if (rows.length === 0) return '조회된 내역이 없습니다.\n';
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.join(','),
    ...rows.map((row) => headers.map((h) => csvCell((row as any)[h])).join(',')),
  ];
  return lines.join('\r\n') + '\r\n';
}

export async function GET(request: NextRequest) {
  try {
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
    const kind = (searchParams.get('kind') ?? 'usage') as LogKind;
    const userId = searchParams.get('userId') ?? '';
    const format = searchParams.get('format') ?? 'json';
    // 질문 원문 열람. 사유를 함께 받아 보안 로그에 남긴다.
    const revealQuery = searchParams.get('reveal') === 'true';
    const revealReason = (searchParams.get('reason') ?? '').trim();
    const page = Math.max(Number(searchParams.get('page')) || 1, 1);

    // 기간 미지정 시 최근 30일
    const to = searchParams.get('to')
      ? new Date(`${searchParams.get('to')}T23:59:59+09:00`)
      : new Date();
    const from = searchParams.get('from')
      ? new Date(`${searchParams.get('from')}T00:00:00+09:00`)
      : new Date(to.getTime() - 30 * 86400000);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return NextResponse.json(
        { ok: false, error: { message: '기간 형식이 올바르지 않습니다. (YYYY-MM-DD)' } },
        { status: 400 }
      );
    }
    if (from > to) {
      return NextResponse.json(
        { ok: false, error: { message: '시작일이 종료일보다 늦습니다.' } },
        { status: 400 }
      );
    }

    // 관리 범위 안의 직원만 대상으로 한다
    const { data: members } = await supabaseAdmin
      .from('users')
      .select('id, full_name, email, department_id, departments(name)')
      .in('department_id', managedDeptIds);

    // 명시적 제네릭이 없으면 [키, 값] 배열이 유니온으로 추론돼 Map 값 타입이 {}가 된다
    interface MemberInfo { name: string; email: string; dept: string }

    const memberMap = new Map<string, MemberInfo>(
      (members ?? []).map((m: any): [string, MemberInfo] => {
        const dept = Array.isArray(m.departments) ? m.departments[0] : m.departments;
        return [m.id, { name: m.full_name ?? '(이름 없음)', email: m.email, dept: dept?.name ?? '-' }];
      })
    );

    // 특정 직원 지정 시 관리 범위 안인지 확인
    if (userId && !memberMap.has(userId)) {
      return NextResponse.json(
        { ok: false, error: { message: '관리 권한이 없는 직원입니다.' } },
        { status: 403 }
      );
    }

    const isExport = format === 'csv';

    // 질문 원문을 열려면 사유가 있어야 한다. 사유 없는 열람은 거절한다 —
    // 기록만 남기고 통과시키면 사실상 상시 열람과 같아진다.
    if (revealQuery) {
      if (revealReason.length < 5) {
        return NextResponse.json(
          {
            ok: false,
            error: {
              message:
                '질문 원문을 열람하려면 사유를 5자 이상 입력해야 합니다. 열람 사실은 보안 로그에 기록됩니다.',
            },
          },
          { status: 400 }
        );
      }

      // 누가·언제·왜 열었는지 남긴다. 열람 자체가 감사 대상이다.
      await logSecurityEvent(
        adminDeptId,
        session.user.id,
        'query_revealed',
        {
          reason: revealReason,
          target_user_id: userId || '(전체)',
          from: from.toISOString(),
          to: to.toISOString(),
          exported: isExport,
        },
        'high'
      );
    }

    const table = kind === 'security' ? 'security_logs' : 'usage_logs';

    let query = supabaseAdmin
      .from(table)
      .select(
        kind === 'security'
          ? 'id, user_id, department_id, event_type, severity, details, created_at'
          : 'id, user_id, department_id, action, resource_type, details, created_at',
        { count: 'exact' }
      )
      .in('department_id', managedDeptIds)
      .gte('created_at', from.toISOString())
      .lte('created_at', to.toISOString())
      .order('created_at', { ascending: false });

    if (userId) query = query.eq('user_id', userId);

    query = isExport
      ? query.limit(MAX_EXPORT_ROWS)
      : query.range((page - 1) * DEFAULT_PAGE_SIZE, page * DEFAULT_PAGE_SIZE - 1);

    const { data: logs, count, error } = await query;

    if (error) {
      console.error('[audit-logs]', error);
      return NextResponse.json(
        { ok: false, error: { message: '로그 조회에 실패했습니다.' } },
        { status: 500 }
      );
    }

    const rows: AuditRow[] = (logs ?? []).map((log: any) => {
      const member = memberMap.get(log.user_id) ?? { name: '(삭제된 계정)', email: '-', dept: '-' };
      const details = log.details ?? {};

      if (kind === 'security') {
        return {
          일시: formatDateTime(log.created_at),
          구분: '보안',
          직원: member.name,
          이메일: member.email,
          부서: member.dept,
          활동: SECURITY_LABEL[log.event_type] ?? log.event_type,
          상세: `심각도 ${SEVERITY_LABEL[log.severity] ?? log.severity}${
            details.word ? ` / 탐지어: ${details.word}` : ''
          }`,
          모델: '',
          입력토큰: '',
          출력토큰: '',
          '비용(원)': '',
        };
      }

      return {
        일시: formatDateTime(log.created_at),
        구분: '사용',
        직원: member.name,
        이메일: member.email,
        부서: member.dept,
        활동: ACTION_LABEL[log.action] ?? log.action,
        // 질문 원문은 기본적으로 가린다(D1). 템플릿명·비서명 같은 식별자는
        // 개인의 발화가 아니므로 그대로 둔다.
        상세: details.query
          ? revealQuery
            ? String(details.query)
            : maskQuery(String(details.query))
          : (details.template_name ?? details.name ?? ''),
        모델: details.model ?? '',
        입력토큰: details.input_tokens ?? '',
        출력토큰: details.output_tokens ?? '',
        '비용(원)': details.cost_krw != null ? Math.round(details.cost_krw) : '',
      };
    });

    if (isExport) {
      const period = `${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}`;
      const filename = `사용내역_${kind === 'security' ? '보안' : '사용'}_${period}.csv`;

      // Excel이 한글을 깨뜨리지 않도록 UTF-8 BOM을 붙인다
      const body = '﻿' + toCsv(rows);

      return new NextResponse(body, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
          'Cache-Control': 'no-store',
        },
      });
    }

    // 요약 — 감사 보고에 함께 쓰인다
    const totalCostKrw =
      kind === 'usage'
        ? usdToKrw(sumCostUsd((logs ?? []).map((l: any) => ({ details: l.details }))))
        : 0;

    return NextResponse.json({
      ok: true,
      data: rows,
      meta: {
        total: count ?? rows.length,
        page,
        pageSize: DEFAULT_PAGE_SIZE,
        from: from.toISOString(),
        to: to.toISOString(),
        totalCostKrw,
        truncatedForExport: (count ?? 0) > MAX_EXPORT_ROWS,
      },
    });
  } catch (error) {
    console.error('[audit-logs] 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
