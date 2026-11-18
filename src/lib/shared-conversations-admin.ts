// src/lib/shared-conversations-admin.ts
// 기관 관리자가 **공개 링크로 공유 중인 대화**를 보고 멈춘다(2026-11-18).
//
// 대화 공개 공유는 로그인 없이 열리는 링크다. 직원이 만든 링크를 기관이 알 방법도 멈출 방법도 없었다 —
// 공공기관 대화에는 민원인 정보·검토 중인 방침이 섞이고, 링크를 만든 직원이 그 사실을 잊으면 계속 열려 있다.
// 관리자는 **누가 언제 공유했는지만** 본다. 대화 제목·내용·링크 주소는 내보내지 않는다(직원 질문 원문을 가리는 것과 같은 원칙) —
// 관리자가 링크를 받아 내용을 열어 보는 길이 되면 안 된다.
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSecurityEvent } from '@/lib/security-log';

const MAX_LISTED = 200;
export const STOP_REASON_MIN = 5;
export const STOP_REASON_MAX = 300;

export interface SharedConversationRow {
  id: string;
  userId: string | null;
  userName: string | null;
  departmentName: string | null;
  /** 링크에 보이는 범위 — 이때까지의 대화. 없으면 이 기능 전에 공유한 것(대화 전체) */
  sharedAt: string | null;
}

/** 관리 범위 부서의 공유 중인 대화 — 최근에 바뀐 것부터 200건. 못 읽으면 `{ error }` */
export async function listSharedConversations(
  managedDepartmentIds: string[],
): Promise<{ rows: SharedConversationRow[]; truncated: boolean } | { error: true }> {
  if (managedDepartmentIds.length === 0) return { rows: [], truncated: false };

  const { data, error } = await supabaseAdmin
    .from('conversations')
    .select('id, user_id, department_id, metadata, updated_at')
    .eq('is_shared', true)
    .in('department_id', managedDepartmentIds)
    .order('updated_at', { ascending: false })
    .limit(MAX_LISTED + 1);
  if (error) return { error: true };

  const all = (data ?? []) as Array<{ id: string; user_id: string | null; department_id: string | null; metadata: { shared_at?: unknown } | null }>;
  const listed = all.slice(0, MAX_LISTED);

  const userIds = Array.from(new Set(listed.map((c) => c.user_id).filter((v): v is string => Boolean(v))));
  const deptIds = Array.from(new Set(listed.map((c) => c.department_id).filter((v): v is string => Boolean(v))));
  const [users, depts] = await Promise.all([
    userIds.length ? supabaseAdmin.from('users').select('id, full_name, email').in('id', userIds) : Promise.resolve({ data: [], error: null }),
    deptIds.length ? supabaseAdmin.from('departments').select('id, name').in('id', deptIds) : Promise.resolve({ data: [], error: null }),
  ]);
  // 이름을 못 읽은 것을 '이름 없음'으로 꾸미지 않는다 — 누구의 링크인지 모르는 목록은 쓸모가 없다
  if (users.error || depts.error) return { error: true };

  const userName = new Map(
    ((users.data ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>).map((u) => [u.id, u.full_name || u.email || null]),
  );
  const deptName = new Map(((depts.data ?? []) as Array<{ id: string; name: string | null }>).map((d) => [d.id, d.name]));

  return {
    rows: listed.map((c) => ({
      id: c.id,
      userId: c.user_id,
      userName: c.user_id ? userName.get(c.user_id) ?? null : null,
      departmentName: c.department_id ? deptName.get(c.department_id) ?? null : null,
      sharedAt: typeof c.metadata?.shared_at === 'string' ? c.metadata.shared_at : null,
    })),
    truncated: all.length > MAX_LISTED,
  };
}

/** 사유 다듬기 — 5~300자 */
export function cleanStopReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, STOP_REASON_MAX);
  return text.length >= STOP_REASON_MIN ? text : null;
}

export type StopSharedResult =
  | { ok: true }
  | { ok: false; status: 404 | 500; message: string };

/**
 * 관리 범위 직원의 공개 링크를 멈춘다 — 주소와 공유한 때를 버린다(직원이 스스로 멈춘 것과 같다, 다시 공유하면 새 주소).
 * 관리 범위 밖이거나 공유 중이 아니면 404(있는지 알리지 않음). 보안 로그에 남긴다(high — 관리자가 직원의 대화 설정을 바꿨다).
 */
export async function stopSharedConversation(input: {
  conversationId: string;
  managedDepartmentIds: string[];
  actorId: string;
  actorDepartmentId: string;
  reason: string;
  impersonating?: boolean;
}): Promise<StopSharedResult> {
  const notFound: StopSharedResult = { ok: false, status: 404, message: '공유 중인 대화를 찾을 수 없습니다. 이미 중단됐을 수 있습니다.' };
  if (input.managedDepartmentIds.length === 0) return notFound;

  const { data: row, error: readError } = await supabaseAdmin
    .from('conversations')
    .select('id, user_id, metadata')
    .eq('id', input.conversationId)
    .eq('is_shared', true)
    .in('department_id', input.managedDepartmentIds)
    .maybeSingle();
  if (readError) return { ok: false, status: 500, message: '대화를 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  if (!row) return notFound;

  const current = row as { id: string; user_id: string | null; metadata: Record<string, unknown> | null };
  const metadata = current.metadata && typeof current.metadata === 'object' && !Array.isArray(current.metadata) ? { ...current.metadata } : {};
  delete metadata.shared_at;

  const { data: stopped, error } = await supabaseAdmin
    .from('conversations')
    .update({ is_shared: false, share_token: null, metadata })
    .eq('id', current.id)
    .eq('is_shared', true)
    .in('department_id', input.managedDepartmentIds)
    .select('id');
  if (error) return { ok: false, status: 500, message: '공유를 중단하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  if (((stopped ?? []) as unknown[]).length === 0) return notFound;

  await logSecurityEvent(
    input.actorDepartmentId,
    input.actorId,
    'conversation_unshared_by_admin',
    {
      conversation_id: current.id,
      ...(current.user_id ? { target_user_id: current.user_id } : {}),
      reason: input.reason,
      ...(input.impersonating ? { impersonating: true } : {}),
    },
    'high',
  );
  return { ok: true };
}
