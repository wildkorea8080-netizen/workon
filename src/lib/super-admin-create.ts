import { supabaseAdmin } from './supabaseAdmin';

/**
 * 슈퍼관리자 추가 도우미(2026-11-19).
 * - 입력 검사: 이름 1~50자(제어·보이지 않는 글자 빼고 공백 하나로), 이메일 꼴·254자, 소문자로 맞춤
 * - Auth 계정 찾기: `listUsers`를 쪽마다 끝까지 본다 — 예전엔 첫 1,000명만 보아, 그 뒤 계정이면 못 찾고
 *   만들기가 '이미 있음'으로 실패했다. 찾지 못하면 null, 읽지 못하면 undefined(판정에 쓰지 않음)
 */
export const MAX_SUPER_ADMIN_NAME = 50;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseSuperAdminInput(body: unknown):
  | { ok: true; name: string; email: string }
  | { ok: false; message: string } {
  if (!body || typeof body !== 'object') return { ok: false, message: '요청 형식이 올바르지 않습니다.' };
  const b = body as Record<string, unknown>;
  const name = typeof b.name === 'string'
    ? b.name.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()
    : '';
  if (!name || name.length > MAX_SUPER_ADMIN_NAME) return { ok: false, message: `이름은 1~${MAX_SUPER_ADMIN_NAME}자로 적어 주세요.` };
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !EMAIL.test(email)) return { ok: false, message: '이메일 주소 형식이 올바르지 않습니다.' };
  return { ok: true, name, email };
}

const PER_PAGE = 1000;
const MAX_PAGES = 100;

type ListUsers = (args: { page: number; perPage: number }) => Promise<{
  data: { users?: Array<{ id: string; email?: string | null }> } | null;
  error: unknown;
}>;

/** 이메일이 같은 Auth 계정의 id — 없으면 null, 못 읽으면 undefined. */
export async function findAuthUserByEmail(
  email: string,
  listUsers: ListUsers = (args) => supabaseAdmin.auth.admin.listUsers(args) as never,
): Promise<string | null | undefined> {
  const want = email.trim().toLowerCase();
  for (let page = 1; page <= MAX_PAGES; page++) {
    let res: Awaited<ReturnType<ListUsers>>;
    try {
      res = await listUsers({ page, perPage: PER_PAGE });
    } catch {
      return undefined;
    }
    if (res.error) return undefined;
    const users = res.data?.users ?? [];
    const hit = users.find((u) => (u.email ?? '').toLowerCase() === want);
    if (hit) return hit.id;
    if (users.length < PER_PAGE) return null;
  }
  return undefined; // 끝까지 보지 못했다
}
