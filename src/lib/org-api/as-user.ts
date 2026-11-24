// src/lib/org-api/as-user.ts
// 기관 API의 사람별 신원(2026-11-25, 0108) — 범위 chat_as_user(chat과 함께).
// 그룹웨어 봇·민원 창구처럼 직원을 이미 확인한 기관 시스템이 `asUser: "이메일"`로 **그 직원으로** 묻는다(첨부도 그 직원의 첨부).
// 그러면 비서 사용 권한·월 한도·금지어·대화 기록이 키를 만든 관리자가 아니라 그 직원의 것이 된다.
//
// - 이 기관 부서(키 주인의 관리 범위 = 기관 전체)에 등록된 **쓸 수 있는 직원**만 — 이메일 대소문자 무시, 하나만.
//   슈퍼관리자 계정·사용 중지·탈퇴·소속 없음은 막는다. 계정을 만들지 않는다.
// - 그 직원이 그 비서를 쓸 수 있는지·한도는 대화 실행기가 그 직원의 세션 꼴로 다시 본다.
// - 기관 시스템이 직원을 제대로 확인했는지는 WORKON이 알 수 없다 — 그래서 이 범위는 따로 고르고 화면이 경고한다.
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { canSignIn } from '@/lib/user-withdrawal';
import { decideSignIn } from '@/lib/sign-in-user';
import type { OrgApiContext } from './keys';

export const ORG_API_AS_USER_SCOPE_DENIED = 'asUser로 묻으려면 키에 \'직원으로 묻기(chat_as_user)\' 범위가 있어야 합니다.';
export const ORG_API_AS_USER_NOT_FOUND = '그 이메일로 등록된 이 기관 직원을 찾을 수 없습니다.';
export const ORG_API_AS_USER_INACTIVE = '사용 중지되었거나 탈퇴한 직원입니다.';
export const ORG_API_AS_USER_UNREAD = '직원 정보를 지금 확인하지 못했습니다. 잠시 뒤 다시 호출해 주세요.';

export type ApiActor = { id: string; role: 'ADMIN' | 'USER'; departmentId: string; asUser: boolean };
type UserRow = { id: string; email: string | null; full_name: string | null; role: string | null; department_id: string | null; is_active: boolean | null; deleted_at: string | null; is_super_admin: boolean | null };

export interface AsUserIo {
  /** 이메일(대소문자 무시)로 직원 — 둘까지. 못 읽으면 던진다 */
  findByEmail(email: string): Promise<UserRow[]>;
}

export function asUserIo(): AsUserIo {
  return {
    async findByEmail(email) {
      const pattern = email.replace(/[\\%_]/g, (c) => `\\${c}`);
      const { data, error } = await supabaseAdmin.from('users')
        .select('id, email, full_name, role, department_id, is_active, deleted_at, is_super_admin')
        .ilike('email', pattern).limit(2);
      if (error) throw new Error(`users: ${error.code ?? ''}`);
      return (data ?? []) as UserRow[];
    },
  };
}

/** 키 주인(asUser 없음) 또는 asUser 직원 — 실패면 상태·글 */
export async function apiActor(ctx: OrgApiContext, asUser: string | null, io: AsUserIo = asUserIo()): Promise<{ ok: true; actor: ApiActor } | { ok: false; status: number; message: string }> {
  if (!asUser) return { ok: true, actor: { id: ctx.creatorId, role: 'ADMIN', departmentId: ctx.creatorDepartmentId, asUser: false } };
  if (!(ctx.scopes ?? []).includes('chat_as_user')) return { ok: false, status: 403, message: ORG_API_AS_USER_SCOPE_DENIED };
  let rows: UserRow[];
  try {
    rows = await io.findByEmail(asUser);
  } catch {
    return { ok: false, status: 503, message: ORG_API_AS_USER_UNREAD };
  }
  // 같은 주소가 둘이거나 다른 기관 사람·슈퍼관리자면 고르지 않는다(있는지 드러내지 않게 같은 404)
  if (rows.length !== 1) return { ok: false, status: 404, message: ORG_API_AS_USER_NOT_FOUND };
  const user = rows[0];
  if (user.is_super_admin || !user.department_id || !ctx.departmentIds.includes(user.department_id)) return { ok: false, status: 404, message: ORG_API_AS_USER_NOT_FOUND };
  // 로그인과 같은 규칙(user-withdrawal.ts canSignIn) — 그 모듈은 무거운 의존을 끌고 와 여기 적는다
  if (user.is_active === false || user.deleted_at) return { ok: false, status: 403, message: ORG_API_AS_USER_INACTIVE };
  const decision = decideSignIn(user, false);
  if (!decision.ok) return { ok: false, status: 404, message: ORG_API_AS_USER_NOT_FOUND };
  return { ok: true, actor: { id: user.id, role: decision.role, departmentId: decision.departmentId, asUser: true } };
}

export { parseAsUser } from './spec';
