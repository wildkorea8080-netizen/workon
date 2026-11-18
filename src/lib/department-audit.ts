// src/lib/department-audit.ts
// 부서 만들기·고치기·삭제를 보안 로그에(2026-11-18) — 그 전에는 어디에도 남지 않았다.
//
// 부서 트리는 권한이다: 상위 부서를 바꾸면 **누가 그 부서를 관리하는지**(관리 범위 = 자기 부서 + 하위)와 그 부서 직원이 보는 자료 범위가 바뀐다.
// 부서 월 한도·1인당 월 한도(기본값)는 그 부서 직원의 대화가 언제 멈추는지를 정한다. 직원 한 사람의 한도 변경은 남는데(`user_budget_changed`)
// 부서 전체의 한도 변경은 남지 않았다.
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { SecuritySeverity } from '@/lib/security-log';

export type DepartmentBefore = {
  name: string;
  parent_id: string | null;
  monthly_budget_krw?: unknown;
  user_monthly_budget_krw?: unknown;
};

/** DB의 금액 칸(숫자·숫자 글·null) → 0보다 큰 숫자 또는 null(제한 없음) */
const amount = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * 고치기 전 값과 저장할 값(`update` — 바꾸려는 칸만 들어 있다)을 맞대 **실제로 달라진 것만** 돌려준다. 달라진 것이 없으면 null.
 * 심각도: 상위 부서 바꾸기는 high(관리 범위가 바뀐다), 한도는 medium, 이름만이면 low.
 */
export function departmentChanges(
  before: DepartmentBefore,
  update: Record<string, unknown>,
): { changes: Record<string, unknown>; severity: SecuritySeverity; parentChanged: boolean } | null {
  const changes: Record<string, unknown> = {};
  let severity: SecuritySeverity = 'low';
  let parentChanged = false;

  if (typeof update.name === 'string' && update.name !== before.name) {
    changes.from_dept_name = before.name;
    changes.to_dept_name = update.name;
  }

  for (const [key, label] of [
    ['monthly_budget_krw', 'dept_budget_krw'],
    ['user_monthly_budget_krw', 'user_default_budget_krw'],
  ] as const) {
    if (!(key in update)) continue;
    const from = amount(before[key]);
    const to = amount(update[key]);
    if (from === to) continue;
    changes[`from_${label}`] = from;
    changes[`to_${label}`] = to;
    severity = 'medium';
  }

  if ('parent_id' in update) {
    const to = (update.parent_id as string | null) ?? null;
    if (to !== (before.parent_id ?? null)) {
      changes.from_parent_id = before.parent_id ?? null;
      changes.to_parent_id = to;
      severity = 'high';
      parentChanged = true;
    }
  }

  return Object.keys(changes).length > 0 ? { changes, severity, parentChanged } : null;
}

/** 부서 이름 — 기록에 그때의 이름을 남기려고 읽는다. 없거나 못 읽으면 null(기록은 이름 없이 남긴다) */
export async function departmentNameOf(id: string | null | undefined, organizationId: string): Promise<string | null> {
  if (!id) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from('departments')
      .select('name')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error) return null;
    const name = (data as { name?: unknown } | null)?.name;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}
