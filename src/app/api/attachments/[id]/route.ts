import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { deleteAttachment } from '@/lib/attachments/store';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/** 보내기 전 첨부 지우기. 대화에 묶인 첨부는 대화를 지울 때 함께 지워진다(설계 4.7) */
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

  const deleted = await deleteAttachment(session.user.id, params.id);
  if (!deleted) return jsonError('첨부를 찾을 수 없습니다.', 404);
  return NextResponse.json({ ok: true, data: { id: params.id } });
}
