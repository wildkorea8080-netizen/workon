// src/lib/agent-category-admin.ts
// 비서 카테고리 관리 라우트 둘(`/api/admin/agent-categories`·`[id]`)이 함께 쓰는 확인·이름 다듬기.
//
// 2026-11-18에 한 곳으로 모으며 고친 것:
// - **바꾸기(추가·이름·순서·삭제)는 기관 전체 관리자만** — 카테고리는 기관 전체의 표시 분류이고, 이름 바꾸기·삭제는 그 이름을 쓰는
//   기관의 모든 비서(다른 부서의 비서·직원의 나만의 비서)를 함께 고친다. 예전에는 하위 부서 관리자도 관리 범위 밖 비서의 분류를 바꿨다.
//   목록 읽기는 관리자 누구나(비서 만들기·편집 창의 분류 고르기가 쓴다)
// - 부서를 읽지 못한 것을 '기관 없음'으로 보지 않는다(503)
import { NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const MAX_CATEGORY_NAME = 30;

export const CATEGORY_EDIT_ONLY =
  '비서 카테고리는 기관 전체를 관리하는 관리자(최상위 부서 소속)만 바꿀 수 있습니다.';

const fail = (message: string, status: number) =>
  NextResponse.json({ ok: false, error: { message } }, { status });

export type CategoryAdmin = {
  userId: string;
  departmentId: string;
  organizationId: string;
  /** 기관 전체 관리자(최상위 부서 소속)인가 — 바꾸기는 이 사람만 */
  canEdit: boolean;
};

/**
 * 관리자 세션에서 기관을 얻는다. 모든 작업을 이 기관으로 한정한다.
 * `mode`가 'edit'이면 기관 전체 관리자가 아닐 때 403.
 */
export async function requireAdminOrg(mode: 'read' | 'edit'): Promise<CategoryAdmin | { error: NextResponse }> {
  const session = await getServerAuthSession();
  if (!session?.user?.id || !isAdminSession(session)) {
    return { error: fail('관리자 권한이 필요합니다.', 403) };
  }

  const departmentId = session.user.departmentId;
  if (!departmentId) return { error: fail('부서 정보를 찾을 수 없습니다.', 403) };

  const { data, error } = await supabaseAdmin
    .from('departments')
    .select('organization_id, parent_id')
    .eq('id', departmentId)
    .maybeSingle();

  // 못 읽은 것과 기관이 없는 것은 다르다 — 못 읽었으면 다시 해 보라고 한다
  if (error) return { error: fail('기관 정보를 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503) };

  const row = data as { organization_id: string | null; parent_id: string | null } | null;
  const organizationId = row?.organization_id;
  if (!organizationId) return { error: fail('기관 정보를 찾을 수 없습니다.', 409) };

  // getManagedDepartmentIds·getActorScope와 같은 규칙: 상위가 없는 부서 소속 관리자가 기관 전체를 관리한다
  const canEdit = row?.parent_id == null;
  if (mode === 'edit' && !canEdit) return { error: fail(CATEGORY_EDIT_ONLY, 403) };

  return { userId: session.user.id, departmentId, organizationId, canEdit };
}

/**
 * 카테고리 이름 다듬기 — NFC, 제어 글자는 공백으로, 보이지 않는 서식 글자는 뺀다(이모지를 잇는 U+200D는 남김), 공백은 하나로.
 * 보이지 않는 글자 하나로 '인사'가 둘이 되면 직원 화면에 같은 이름의 묶음이 두 개 보인다.
 */
export function cleanCategoryName(raw: unknown): { ok: true; name: string } | { ok: false; message: string } {
  if (typeof raw !== 'string') return { ok: false, message: '카테고리 이름을 입력해주세요.' };
  const name = raw
    .normalize('NFC')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/(?!‍)\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) return { ok: false, message: '카테고리 이름을 입력해주세요.' };
  if (name.length > MAX_CATEGORY_NAME) {
    return { ok: false, message: `카테고리는 ${MAX_CATEGORY_NAME}자 이내로 입력해주세요.` };
  }
  return { ok: true, name };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isCategoryId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
