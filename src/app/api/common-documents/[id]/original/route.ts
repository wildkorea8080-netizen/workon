import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { COMMON_ORIGINAL_COLUMNS, canOpenCommonOriginal, originalUrl, parsePage, signOriginal, type CommonOriginalDoc } from '@/lib/source-original';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = '원본을 찾을 수 없습니다.';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 대화 근거 창의 '원본 열기' — 공통 자료실 문서(정부 기준 문서)의 원본을 60초 서명 주소로 307.
 * 요청자 기관의 유형과 문서의 유형이 같을 때만(다른 유형·없는 것은 똑같이 404). 지난 판도 연다 — 옛 답변의 근거였다.
 */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);
  if (!UUID.test(params.id)) return jsonError(NOT_FOUND, 404);
  const actor = await getActorScope(session);
  if (!actor?.organizationId) return jsonError(NOT_FOUND, 404);

  const [org, doc] = await Promise.all([
    supabaseAdmin.from('organizations').select('type').eq('id', actor.organizationId).maybeSingle(),
    supabaseAdmin.from('common_documents').select(COMMON_ORIGINAL_COLUMNS).eq('id', params.id.toLowerCase()).maybeSingle(),
  ]);
  if (org.error || doc.error) return jsonError('원본을 지금 불러올 수 없습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  const row = (doc.data ?? null) as CommonOriginalDoc | null;
  if (!row || !canOpenCommonOriginal(row, (org.data as { type?: unknown } | null)?.type)) return jsonError(NOT_FOUND, 404);

  const signed = await signOriginal(row.storage_path!);
  if (!signed) return jsonError('원본을 지금 열 수 없습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  const url = originalUrl(signed, row.file_name, row.file_type, parsePage(request.nextUrl.searchParams.get('page')));
  return NextResponse.redirect(url, { status: 307, headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } });
}
