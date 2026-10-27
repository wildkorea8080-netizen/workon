import { NextRequest } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { defaultWorkContext, getWorkActor, handleWork, ok, fail, readJson, UNAUTHORIZED, NO_ACTOR } from '@/lib/work/server';
import * as admin from '@/lib/work/admin';

export const dynamic = 'force-dynamic';

async function adminActor() {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return { ok: false as const, error: UNAUTHORIZED() };
  if (!isAdminSession(session)) return { ok: false as const, error: fail('FORBIDDEN', '기관 관리자만 할 수 있습니다.', 403) };
  const ctx = defaultWorkContext();
  const actor = await getWorkActor(session, ctx);
  if (!actor) return { ok: false as const, error: NO_ACTOR() };
  return { ok: true as const, ctx, actor };
}

/** 업무 비서 10개의 이 기관 사용 상태 */
export async function GET() {
  return handleWork(async () => {
    const session = await getServerAuthSession();
    if (!session?.user?.id || !isAdminSession(session)) return fail('FORBIDDEN', '기관 관리자만 할 수 있습니다.', 403);
    const a = await adminActor();
    if (!a.ok) return a.error;
    return ok(await admin.listInstallations(a.ctx, a.actor));
  });
}

/** { key, enabled } — 끄면 새 작업만 막는다(이미 만든 작업·파일은 그대로) */
export async function PATCH(request: NextRequest) {
  return handleWork(async () => {
    const session = await getServerAuthSession();
    if (!session?.user?.id || !isAdminSession(session)) return fail('FORBIDDEN', '기관 관리자만 할 수 있습니다.', 403);
    const a = await adminActor();
    if (!a.ok) return a.error;
    const body = await readJson(request);
    return ok(await admin.setInstallation(a.ctx, a.actor, body.key, body.enabled));
  });
}
