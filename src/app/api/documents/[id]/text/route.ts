import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { loadAgentAccess } from '@/lib/agent-store';
import { findAgentOriginal, readOriginalText } from '@/lib/source-original';

export const dynamic = 'force-dynamic';
// 큰 한글·엑셀을 읽는 데 시간이 든다(스캔 PDF는 NODA로 보내지 않는다)
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 대화 근거 창의 '원문에서 보기' — 비서 문서 원본을 글로 읽어 돌려준다(원본 열기와 같은 권한: 볼 수 있는 문서·쓸 수 있는 비서).
 * 근거 위치는 화면이 찾아 칠한다. 남의 것·없는 것은 똑같이 404
 */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);
  if (!UUID.test(params.id)) return jsonError('원본을 찾을 수 없습니다.', 404);
  const actor = await getActorScope(session);
  if (!actor?.organizationId) return jsonError('원본을 찾을 수 없습니다.', 404);
  const doc = await findAgentOriginal(params.id, actor, loadAgentAccess);
  if (doc === 'error') return jsonError('원본을 지금 불러올 수 없습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  if (!doc) return jsonError('원본을 찾을 수 없습니다.', 404);
  const read = await readOriginalText(doc.storage_path!, doc.file_name);
  if (!read.ok) return jsonError(read.message, read.status);
  return NextResponse.json({ ok: true, data: { fileName: doc.file_name, text: read.text, truncated: read.truncated } }, { headers: { 'Cache-Control': 'private, no-store' } });
}
