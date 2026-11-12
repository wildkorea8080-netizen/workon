import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * 금지어의 범위(2026-11-12).
 *
 * - **관리**(목록·켜고 끄기·지우기): 관리자의 관리 범위 부서(`getManagedDepartmentIds` — 자기 부서 + 하위, 최상위 부서
 *   관리자는 기관 전체)의 금지어만. 예전 목록(`GET /api/forbidden-words`)은 부서·기관 조건이 아예 없어
 *   **모든 기관의 금지어가 어느 기관 관리자에게나 보였다.** 켜고 끄기·지우기는 관리자 자기 부서 것만 찾아
 *   하위 부서 금지어를 고칠 수 없었다.
 * - **걸기**(대화 입력 필터, `filterUserInput`): 직원 부서 + 상위 부서(`getVisibleDepartmentIds`)의 켜진 금지어.
 *   예전에는 직원 부서 것만 봐 기관 직속 부서(최상위) 관리자가 넣은 금지어가 하위 부서 직원에게 걸리지 않았다 —
 *   자료 공개 범위(상위 부서 자료를 하위가 함께 씀)와 같은 방향이다.
 */

export interface ForbiddenWordRow {
  id: string;
  department_id: string;
  word: string;
  context: string | null;
  is_active: boolean;
  created_at: string;
  updated_at?: string | null;
}

const COLUMNS = 'id, department_id, word, context, is_active, created_at, updated_at';

/** 관리 범위 안의 금지어 하나 — 없거나 범위 밖이면 null(있는지 알리지 않음), 조회 실패면 'error' */
export async function findManagedForbiddenWord(id: string, managedDepartmentIds: string[]): Promise<ForbiddenWordRow | null | 'error'> {
  if (!id || managedDepartmentIds.length === 0) return null;
  const { data, error } = await supabaseAdmin
    .from('forbidden_words')
    .select(COLUMNS)
    .eq('id', id)
    .in('department_id', managedDepartmentIds)
    .maybeSingle();
  if (error) return 'error';
  return (data as ForbiddenWordRow | null) ?? null;
}

export type ManagedForbiddenWord = ForbiddenWordRow & { department_name: string | null };

/** 관리 범위 안의 금지어 목록(최근 것부터) + 부서 이름 */
export async function listManagedForbiddenWords(managedDepartmentIds: string[]): Promise<{ rows: ManagedForbiddenWord[] } | { error: string }> {
  if (managedDepartmentIds.length === 0) return { rows: [] };
  const [words, departments] = await Promise.all([
    supabaseAdmin
      .from('forbidden_words')
      .select(COLUMNS)
      .in('department_id', managedDepartmentIds)
      .order('created_at', { ascending: false }),
    supabaseAdmin.from('departments').select('id, name').in('id', managedDepartmentIds),
  ]);
  if (words.error) return { error: words.error.message };
  const names = new Map<string, string>();
  for (const d of (departments.data ?? []) as { id: string; name: string | null }[]) {
    if (d.name) names.set(d.id, d.name);
  }
  return {
    rows: ((words.data ?? []) as ForbiddenWordRow[]).map((row) => ({ ...row, department_name: names.get(row.department_id) ?? null })),
  };
}
