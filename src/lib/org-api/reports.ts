// src/lib/org-api/reports.ts
// 기관 통계 읽기 API(0075)가 내는 숫자 — 관리자 화면과 같은 DB 함수(0056 adoption_report·0065 adoption_by_department·0058 usage_summary)와
// 같은 읽기 함수를 쓴다(셈이 두 벌이 되지 않게). 직원 이름·질문 원문·결과 글은 싣지 않는다 — 직원별 이용통계는 내지 않고,
// 나만의 비서는 이름 없이 '(나만의 비서)'로 묶어 보인다(답변 평가 요약과 같은 판단).
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { adoptionRows, currentMonth, monthRange, parseMonth, previousMonth, readAdoptionStats } from '@/lib/adoption-report';
import { readDepartmentAdoption } from '@/lib/department-adoption';
import { LEGACY_PRICING_MODEL_ID } from '@/lib/models';
import { pagedRows } from '@/lib/paged-select';
import { parseUsageGroups, usageRowsFromGroups } from '@/lib/usage-summary';
import { kstDay } from '@/lib/kst-time';
import { parseUsagePeriod } from './spec';
import type { OrgApiContext } from './keys';

type Out = { data: unknown } | { status: number; message: string };

/** `?month=`(비우면 이번 달, KST) — 관리자 화면과 같은 검사 */
function monthOf(raw: string | null, nowMs: number): { ok: true; month: string } | { ok: false; message: string } {
  const month = raw ? parseMonth(raw) : currentMonth(nowMs);
  if (!month) return { ok: false, message: 'month는 2026-11처럼 적어 주세요.' };
  if (month > currentMonth(nowMs)) return { ok: false, message: '아직 오지 않은 달입니다.' };
  return { ok: true, month };
}

export async function adoptionReport(ctx: OrgApiContext, rawMonth: string | null, nowMs = Date.now()): Promise<Out> {
  const m = monthOf(rawMonth, nowMs);
  if (!m.ok) return { status: 400, message: m.message };
  const previous = previousMonth(m.month);
  const call = async (month: string) => {
    const { from, to } = monthRange(month);
    const { data, error } = await supabaseAdmin.rpc('adoption_report', {
      p_organization_id: ctx.organizationId, p_department_ids: ctx.departmentIds, p_from: from, p_to: to,
    });
    if (error) throw new Error(error.message);
    return readAdoptionStats(data);
  };
  const [current, prior] = await Promise.all([call(m.month), call(previous)]);
  return { data: { month: m.month, previous, partial: m.month === currentMonth(nowMs), rows: adoptionRows(current, prior) } };
}

export async function departmentAdoption(ctx: OrgApiContext, rawMonth: string | null, nowMs = Date.now()): Promise<Out> {
  const m = monthOf(rawMonth, nowMs);
  if (!m.ok) return { status: 400, message: m.message };
  const { from, to } = monthRange(m.month);
  const { data, error } = await supabaseAdmin.rpc('adoption_by_department', {
    p_organization_id: ctx.organizationId, p_department_ids: ctx.departmentIds, p_from: from, p_to: to,
  });
  if (error) throw new Error(error.message);
  return { data: { month: m.month, partial: m.month === currentMonth(nowMs), departments: readDepartmentAdoption(data) } };
}

export const PERSONAL_AGENT_LABEL = '(나만의 비서)';
export const USAGE_USER_AXIS_DENIED = '직원별 이용통계는 API로 내지 않습니다 — by=agent 또는 by=department를 쓰세요.';

/** 비서 이름 사전 — 나만의 비서는 이름 대신 '(나만의 비서)'(직원이 붙인 이름이 기관 밖 시스템으로 가지 않게) */
export function agentNameEntry(a: { name: string; tier: string | null }): { name: string; sub: string } {
  return a.tier === 'personal' ? { name: PERSONAL_AGENT_LABEL, sub: '' } : { name: a.name, sub: '' };
}

export async function usageSummary(ctx: OrgApiContext, params: { by: string | null; from: string | null; to: string | null }, nowMs = Date.now()): Promise<Out> {
  const by = params.by ?? 'agent';
  if (by === 'user') return { status: 400, message: USAGE_USER_AXIS_DENIED };
  if (by !== 'agent' && by !== 'department') return { status: 400, message: 'by는 agent 또는 department입니다.' };
  const period = parseUsagePeriod(params.from, params.to, kstDay(nowMs));
  if (!period.ok) return { status: 400, message: period.message };
  const from = new Date(`${period.from}T00:00:00+09:00`);
  const to = new Date(`${period.to}T23:59:59.999+09:00`);
  const { data: grouped, error } = await supabaseAdmin.rpc('usage_summary', {
    p_department_ids: ctx.departmentIds, p_from: from.toISOString(), p_to: to.toISOString(), p_axis: by, p_legacy_model: LEGACY_PRICING_MODEL_ID,
  });
  if (error) throw new Error(error.message);
  const names = new Map<string, { name: string; sub: string }>();
  if (by === 'agent') {
    const { data: agents, error: agentError } = await pagedRows<{ id: string; name: string; tier: string | null }>((a, b, w) => supabaseAdmin
      .from('agents').select('id, name, tier', w ? { count: 'exact' } : undefined).in('department_id', ctx.departmentIds).order('id').range(a, b));
    if (agentError) throw new Error(agentError.message);
    for (const a of agents ?? []) names.set(a.id, agentNameEntry(a));
  } else {
    const { data: depts, error: deptError } = await supabaseAdmin.from('departments').select('id, name').in('id', ctx.departmentIds);
    if (deptError) throw new Error(deptError.message);
    for (const d of (depts ?? []) as Array<{ id: string; name: string }>) names.set(d.id, { name: d.name, sub: '' });
  }
  const rows = usageRowsFromGroups(parseUsageGroups(grouped), names)
    // 화면용 칸(sub — 비서 아이콘 등)은 빼고 숫자만
    .map(({ sub: _sub, ...row }) => row);
  return {
    data: {
      by, from: period.from, to: period.to,
      totalCount: rows.reduce((s, r) => s + r.count, 0),
      totalCostKrw: Math.round(rows.reduce((s, r) => s + r.costKrw, 0) * 100) / 100,
      rows,
    },
  };
}
