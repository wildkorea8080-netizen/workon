import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { logSecurityEvent } from '@/lib/filter';
import { checkUploadFile, checkUploadTargets, documentStoragePath } from '@/lib/document-upload';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * ① 참고 문서 업로드 주소. 원본은 브라우저가 저장소에 직접 올린다 —
 * Vercel 함수의 요청 본문 상한(4.5MB) 때문이다. 경로는 서버가 정한다.
 * 검사는 확인(POST /api/documents/confirm)이 같은 함수로 다시 한다 — 화면과 이 신고값은 믿지 않는다.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('로그인이 필요합니다.', 401);

    // 소속을 모르면 거절한다 — 추측해서 배정하지 않는다(CLAUDE.md 구조적 위험 0)
    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    let body: { file_name?: unknown; size?: unknown; file_type?: unknown; agent_ids?: unknown };
    try {
      body = await request.json();
    } catch {
      return jsonError('요청 형식이 올바르지 않습니다.', 400);
    }

    const targets = await checkUploadTargets(body.agent_ids, actor);
    if (!targets.ok) return jsonError(targets.message, targets.status);

    const fileName = typeof body.file_name === 'string' ? body.file_name : '';
    const file = checkUploadFile({
      fileName,
      size: typeof body.size === 'number' ? body.size : Number.NaN,
      mimeType: typeof body.file_type === 'string' ? body.file_type : '',
    });
    if (!file.ok) {
      if (file.securityReason) {
        await logSecurityEvent(actor.departmentId, actor.userId, 'file_upload_blocked', {
          reason: file.securityReason,
          filename: fileName,
          ...file.securityDetail,
        }, 'high');
      }
      return jsonError(file.message, file.status);
    }

    const path = documentStoragePath({
      departmentId: actor.departmentId,
      userId: actor.userId,
      ext: file.ext,
      now: Date.now(),
      id: randomUUID(),
    });
    const { data, error } = await supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET).createSignedUploadUrl(path);
    if (error || !data?.token) {
      console.error('[documents upload-url] 업로드 주소 발급 실패:', error?.message);
      return jsonError('업로드 주소를 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 500);
    }

    return NextResponse.json({ ok: true, data: { path, token: data.token } });
  } catch (error) {
    console.error('[documents upload-url]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
