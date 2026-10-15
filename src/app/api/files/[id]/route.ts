import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { findOwnedFile, signedDownloadUrl } from '@/lib/generated-files';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 비서가 만든 파일 내려받기. 주인만 받는다 — 관리자도 못 받는다(설계 5.3).
 * 감사 화면에는 생성 사실과 파일 이름만 남는다.
 */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

  if (!UUID.test(params.id)) return jsonError('파일을 찾을 수 없습니다.', 404);

  const file = await findOwnedFile(params.id, session.user.id);
  if (!file) return jsonError('파일을 찾을 수 없습니다.', 404);

  const url = await signedDownloadUrl(file.storage_path, file.file_name);
  if (!url) return jsonError('내려받을 주소를 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 500);

  return NextResponse.redirect(url, 302);
}
