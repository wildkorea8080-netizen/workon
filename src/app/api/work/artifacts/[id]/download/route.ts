import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { defaultWorkContext, getWorkActor, handleWork, UNAUTHORIZED, NO_ACTOR } from '@/lib/work/server';
import * as svc from '@/lib/work/services';

export const dynamic = 'force-dynamic';

/** 결과 파일 내려받기 — 지금 권한을 다시 보고 60초 서명 주소로 302(Vercel 응답 상한 때문에 직접 보내지 않는다) */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  return handleWork(async () => {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return UNAUTHORIZED();
    const ctx = defaultWorkContext();
    const actor = await getWorkActor(session, ctx);
    if (!actor) return NO_ACTOR();
    return NextResponse.redirect(await svc.artifactDownloadUrl(ctx, actor, params.id), 302);
  });
}
