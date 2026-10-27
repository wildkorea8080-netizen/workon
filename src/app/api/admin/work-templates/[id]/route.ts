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
export const maxDuration = 120;

/** { action: 'test' | 'attest' | 'retire', note? } — 시험 생성 다시·한글 확인 기록(관리자가 직접 연 것)·사용 중지 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  return handleWork(async () => {
    const session = await getServerAuthSession();
    if (!session?.user?.id || !isAdminSession(session)) return fail('FORBIDDEN', '기관 관리자만 할 수 있습니다.', 403);
    const a = await adminActor();
    if (!a.ok) return a.error;
    if (!/^[0-9a-f-]{36}$/i.test(params.id)) return fail('NOT_FOUND', '양식을 찾을 수 없습니다.', 404);
    const body = await readJson(request);
    if (body.action === 'test') return ok(await admin.testOrgTemplate(a.ctx, a.actor, params.id));
    if (body.action === 'attest') return ok(await admin.attestOrgTemplate(a.ctx, a.actor, params.id, body.note));
    if (body.action === 'retire') return ok(await admin.retireOrgTemplate(a.ctx, a.actor, params.id));
    return fail('INVALID_INPUT', '알 수 없는 동작입니다.', 400);
  });
}
