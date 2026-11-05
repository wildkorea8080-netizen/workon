import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { findCommonOriginal, readOriginalText } from '@/lib/source-original';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/** 대화 근거 창의 '원문에서 보기' — 공통 자료실 문서 원본을 글로(같은 기관 유형만). 다른 유형·없는 것은 똑같이 404 */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);
  if (!UUID.test(params.id)) return jsonError('원본을 찾을 수 없습니다.', 404);
  const actor = await getActorScope(session);
  if (!actor?.organizationId) return jsonError('원본을 찾을 수 없습니다.', 404);
  const doc = await findCommonOriginal(params.id, actor.organizationId);
  if (doc === 'error') return jsonError('원본을 지금 불러올 수 없습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  if (!doc) return jsonError('원본을 찾을 수 없습니다.', 404);
  const read = await readOriginalText(doc.storage_path!, doc.file_name);
  if (!read.ok) return jsonError(read.message, read.status);
  return NextResponse.json({ ok: true, data: { fileName: doc.file_name, text: read.text, truncated: read.truncated } }, { headers: { 'Cache-Control': 'private, no-store' } });
}
