import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { findMyAttachmentOriginal } from '@/lib/my-attachments';
import { signedDownloadUrl } from '@/lib/generated-files';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 내가 대화에 올린 파일 내려받기(2026-11-08). 주인만 — 관리자도 못 받는다(첨부 격리 규칙). 대화에 보낸 읽힌 첨부만.
 * 60초 서명 주소로 302(Vercel 응답 상한 때문에 직접 보내지 않는다)
 */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);
  let file: Awaited<ReturnType<typeof findMyAttachmentOriginal>>;
  try {
    file = await findMyAttachmentOriginal(session.user.id, params.id);
  } catch {
    return jsonError('파일을 지금 불러올 수 없습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  }
  if (!file) return jsonError('파일을 찾을 수 없습니다.', 404);
  const url = await signedDownloadUrl(file.storage_path, file.file_name);
  if (!url) return jsonError('내려받을 주소를 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 500);
  return NextResponse.redirect(url, 302);
}
