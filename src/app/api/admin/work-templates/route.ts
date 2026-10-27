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

/** 기관 업무 양식 목록(사용 중지 포함) + 대화 비서에 올린 기관 양식(가져올 후보) */
export async function GET() {
  return handleWork(async () => {
    const session = await getServerAuthSession();
    if (!session?.user?.id || !isAdminSession(session)) return fail('FORBIDDEN', '기관 관리자만 할 수 있습니다.', 403);
    const a = await adminActor();
    if (!a.ok) return a.error;
    return ok(await admin.listAdminTemplates(a.ctx, a.actor));
  });
}

/**
 * 등록 — multipart(file, name) 또는 JSON { agentTemplateId }. 올린 뒤 바로 시험 생성(패키지 검사).
 * 양식은 4MB까지(Vercel 요청 본문 상한 4.5MB 안)
 */
export async function POST(request: NextRequest) {
  return handleWork(async () => {
    const session = await getServerAuthSession();
    if (!session?.user?.id || !isAdminSession(session)) return fail('FORBIDDEN', '기관 관리자만 할 수 있습니다.', 403);
    const a = await adminActor();
    if (!a.ok) return a.error;
    if ((request.headers.get('content-type') ?? '').includes('application/json')) {
      const body = await readJson(request);
      return ok(await admin.importAgentTemplate(a.ctx, a.actor, body.agentTemplateId), 201);
    }
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!form || !file || typeof file === 'string') return fail('INVALID_INPUT', '양식 파일을 골라 주세요.', 400);
    if (file.size > admin.MAX_TEMPLATE_BYTES) return fail('INVALID_INPUT', '양식 파일은 4MB까지 올릴 수 있습니다.', 413);
    const bytes = Buffer.from(await file.arrayBuffer());
    return ok(await admin.registerOrgTemplate(a.ctx, a.actor, { name: form.get('name'), fileName: file.name, bytes }), 201);
  });
}
