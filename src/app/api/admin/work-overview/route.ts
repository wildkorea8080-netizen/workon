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

/** 업무별 작업 수·완료·검토 대기·최근 30일 실패 실행(원문·파일 없음) */
export async function GET() {
  return handleWork(async () => {
    const session = await getServerAuthSession();
    if (!session?.user?.id || !isAdminSession(session)) return fail('FORBIDDEN', '기관 관리자만 할 수 있습니다.', 403);
    const a = await adminActor();
    if (!a.ok) return a.error;
    return ok(await admin.workOverview(a.ctx, a.actor));
  });
}
