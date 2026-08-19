import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getManagedDepartmentIds } from '@/lib/department-scope';

export const dynamic = 'force-dynamic';

/**
 * 일자별 사용량 추이.
 *
 * 이 화면은 그동안 `Math.random()`으로 만든 숫자를 보여주고 있었다. 부르는
 * API가 없어 404가 나면 폴백으로 무작위 데이터를 그리도록 짜여 있었다.
 *
 * 공공기관은 이 화면을 보고 분기별 집행률을 보고한다. 무작위 숫자를
 * '사용량 추이'라는 이름으로 띄우는 것은 아무것도 안 보여주는 것보다 나쁘다.
 *
 * 조회 범위는 관리 범위(자기 부서 + 하위)다. 다른 관리자 화면과 같은 기준이라
 * 화면끼리 숫자가 어긋나지 않는다.
 */

/** 한 번에 볼 수 있는 최대 기간. 그 이상은 의미도 없고 응답만 커진다. */
const MAX_DAYS = 180;

interface DayBucket {
  date: string;
  documents: number;
  conversations: number;
  reports: number;
  tokens: number;
}

/** KST 기준 날짜 키. 감사 자료는 한국 시간으로 제출한다. */
function dateKeyKst(iso: string): string {
  const kst = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 10);
}

export async function GET(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id || !isAdminSession(session)) {
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

  const managedDeptIds = await getManagedDepartmentIds(departmentId);

  const { searchParams } = new URL(request.url);
  const end = searchParams.get('end') ? new Date(searchParams.get('end')!) : new Date();
  const start = searchParams.get('start')
    ? new Date(searchParams.get('start')!)
    : new Date(end.getTime() - 30 * 86400000);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return NextResponse.json(
      { ok: false, error: { message: '기간이 올바르지 않습니다.' } },
      { status: 400 }
    );
  }

  const days = Math.ceil((end.getTime() - start.getTime()) / 86400000);
  if (days > MAX_DAYS) {
    return NextResponse.json(
      { ok: false, error: { message: `조회 기간은 ${MAX_DAYS}일 이내여야 합니다.` } },
      { status: 400 }
    );
  }

  const from = start.toISOString();
  const to = end.toISOString();

  const [documents, conversations, logs] = await Promise.all([
    supabaseAdmin
      .from('documents')
      .select('created_at')
      .in('department_id', managedDeptIds)
      .gte('created_at', from)
      .lte('created_at', to),
    supabaseAdmin
      .from('conversations')
      .select('created_at')
      .in('department_id', managedDeptIds)
      .gte('created_at', from)
      .lte('created_at', to),
    supabaseAdmin
      .from('usage_logs')
      .select('created_at, action, details')
      .in('department_id', managedDeptIds)
      .gte('created_at', from)
      .lte('created_at', to),
  ]);

  // 기간 안의 모든 날짜를 미리 채운다. 빈 날을 건너뛰면 차트에서
  // 사용이 없던 날과 데이터가 없는 날이 구분되지 않는다.
  const buckets = new Map<string, DayBucket>();
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    const key = dateKeyKst(new Date(t).toISOString());
    buckets.set(key, { date: key, documents: 0, conversations: 0, reports: 0, tokens: 0 });
  }

  const bump = (iso: string, apply: (b: DayBucket) => void) => {
    const bucket = buckets.get(dateKeyKst(iso));
    if (bucket) apply(bucket);
  };

  for (const row of documents.data ?? []) bump(row.created_at, (b) => (b.documents += 1));
  for (const row of conversations.data ?? []) bump(row.created_at, (b) => (b.conversations += 1));

  for (const row of (logs.data ?? []) as { created_at: string; action: string; details: any }[]) {
    bump(row.created_at, (b) => {
      const d = row.details ?? {};
      b.tokens += Number(d.input_tokens ?? 0) + Number(d.output_tokens ?? 0);
      if (row.action === 'generate_report') b.reports += 1;
    });
  }

  return NextResponse.json({
    ok: true,
    data: [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date)),
  });
}
