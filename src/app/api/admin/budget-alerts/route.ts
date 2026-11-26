import { NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { actorScopeOr503 } from '@/lib/actor-scope-response';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isMailConfigured } from '@/lib/mailer';
import { BUDGET_ALERT_HISTORY_LIMIT, budgetAlertView, parseBudgetAlertEmails, type BudgetAlertRow, type BudgetAlertView } from '@/lib/budget-alert-history-spec';
import { readJsonObject, BAD_BODY_MESSAGE } from '@/lib/request-body';
import { logSecurityEvent } from '@/lib/security-log';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}
const UNREAD = '예산 알림 이력을 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.';

/**
 * 예산 알림 이력(2026-11-26) — 이 기관의 예산 알림 메일을 언제·무엇에·몇 %에서 보냈는지(보냄·받는 사람 없음·못 보냄).
 * 기관 알림은 관리자 누구나(예산 현황과 같이), 부서 알림은 관리 범위 부서만, 개인 월 한도 알림은 싣지 않는다(직원 본인에게만 간다).
 * 받는 사람 주소는 저장하지 않으므로 수만. 못 읽으면 503(빈 이력으로 보이지 않게)
 */
export async function GET() {
  const session = await getServerAuthSession();
  if (!session?.user?.id || !isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
  const scope = await actorScopeOr503(session);
  if (scope instanceof Response) return scope;
  if (!scope?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);

  const { data, error } = await supabaseAdmin.from('budget_alerts')
    .select('id, subject, period_key, threshold, kind, status, attempts, percent, recipients, created_at, updated_at')
    .eq('organization_id', scope.organizationId)
    .not('subject', 'like', 'user:%')
    .order('created_at', { ascending: false })
    .limit(BUDGET_ALERT_HISTORY_LIMIT * 3);
  if (error) return jsonError(UNREAD, 503);

  const managed = new Set(scope.managedDepartmentIds.map((d) => d.toLowerCase()));
  const rows = (data ?? []) as BudgetAlertRow[];
  const deptIds = [...new Set(rows.map((r) => /^dept:([0-9a-f-]{36})$/i.exec(r.subject)?.[1]?.toLowerCase()).filter((d): d is string => !!d && managed.has(d)))];
  const names = new Map<string, string>();
  if (deptIds.length) {
    const { data: depts, error: deptError } = await supabaseAdmin.from('departments').select('id, name').in('id', deptIds).eq('organization_id', scope.organizationId);
    // 이름을 못 읽으면 '(지금 없는 부서)'로 보이지 않는다
    if (deptError) return jsonError(UNREAD, 503);
    for (const d of (depts ?? []) as { id: string; name: string }[]) names.set(d.id.toLowerCase(), d.name);
  }
  const alerts: BudgetAlertView[] = [];
  for (const row of rows) {
    const view = budgetAlertView(row, managed, names);
    if (view) alerts.push(view);
    if (alerts.length >= BUDGET_ALERT_HISTORY_LIMIT) break;
  }
  // 기관 예산 알림을 더 받을 주소(0135) — 못 읽으면 빈 목록으로 보이지 않는다
  const { data: org, error: orgError } = await supabaseAdmin.from('organizations').select('budget_alert_emails').eq('id', scope.organizationId).maybeSingle();
  if (orgError) return jsonError(UNREAD, 503);
  const extraRecipients = Array.isArray((org as { budget_alert_emails?: unknown } | null)?.budget_alert_emails) ? (org as { budget_alert_emails: string[] }).budget_alert_emails : [];
  return NextResponse.json({ ok: true, data: { alerts, mailConfigured: isMailConfigured(), extraRecipients, canManage: scope.managesWholeOrganization && !session.user.isImpersonating } });
}

/** 기관 예산 알림을 더 받을 주소 정하기(0135) — `{ emails: string[] }`(5개까지, 빈 목록이면 지움). 기관 전체 관리자만, 대리 접근 중 403, 보안 로그 medium(수만) */
export async function PUT(request: Request) {
  const session = await getServerAuthSession();
  if (!session?.user?.id || !isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
  if (session.user.isImpersonating) return jsonError('대리 접근 중에는 받는 사람을 바꿀 수 없습니다.', 403);
  const scope = await actorScopeOr503(session);
  if (scope instanceof Response) return scope;
  if (!scope?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);
  if (!scope.managesWholeOrganization) return jsonError('예산 알림 받는 사람은 기관 전체 관리자(최상위 부서 소속)만 정합니다.', 403);
  const body = await readJsonObject(request);
  if (!body) return jsonError(BAD_BODY_MESSAGE, 400);
  const parsed = parseBudgetAlertEmails(body.emails);
  if (!parsed.ok) return jsonError(parsed.message, 400);
  const { data, error } = await supabaseAdmin.from('organizations').update({ budget_alert_emails: parsed.emails }).eq('id', scope.organizationId).select('budget_alert_emails');
  if (error || !data?.length) return jsonError('받는 사람을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  await logSecurityEvent(scope.departmentId, scope.userId, 'budget_alert_recipients_changed', { count: parsed.emails.length }, 'medium');
  return NextResponse.json({ ok: true, data: { extraRecipients: parsed.emails } });
}
