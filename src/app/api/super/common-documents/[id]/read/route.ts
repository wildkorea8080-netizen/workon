import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { readDocument } from '@/lib/document-reading';
import { commonReadingDeps } from '@/lib/common-documents';

export const dynamic = 'force-dynamic';
// NODA 업로드는 읽기를 끝내고 응답한다 — 한 번에 최대 5분(300,000ms)
export const maxDuration = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 공통 문서 하나를 NODA로 읽힌다. 확인 직후 화면이 걸고, 목록이 `kick: true`로 알려 준 멈춘 행도 이 길로 다시 건다.
 * `retry: true`는 읽기에 실패한 문서(`failed`)를 다시 시작한다. 같은 문서가 동시에 걸려도 NODA 업로드는 한 번이다.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return jsonError('인증이 필요합니다.', 401);

  try {
    if (!UUID.test(params.id)) return jsonError('문서를 찾을 수 없습니다.', 404);

    let retry = false;
    try {
      const body = await request.json();
      retry = body?.retry === true;
    } catch {
      // 본문이 없으면 그냥 읽기다
    }

    const outcome = await readDocument(params.id, { retry }, commonReadingDeps());
    if (outcome.status === 'not_found') return jsonError('문서를 찾을 수 없습니다.', 404);
    return NextResponse.json({ ok: true, data: outcome });
  } catch (error) {
    console.error('[super common-documents read]', error);
    return jsonError('문서를 읽는 중 오류가 발생했습니다.', 500);
  }
}
