import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import {
  compareDocumentEditions,
  COMPARE_DOCUMENT_COLUMNS,
  type CompareDocumentRow,
} from '@/lib/document-edition-compare';
import { buildEditionCompareWorkbook, compareXlsxHeaders } from '@/lib/edition-compare-xlsx';

export const dynamic = 'force-dynamic';
// 글자 층이 없는 PDF는 NODA /parse로 읽는다(한 번 60초) — 두 판을 함께 읽어도 넉넉하게
export const maxDuration = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 새 판과 그 판이 바꾼 옛 판의 신구 대비(문단 단위, 모델 없음).
 * 두 판 모두 요청자가 문서 목록에서 볼 수 있는 문서여야 한다. 운영 기록에는 파일 이름을 남기지 않는다.
 * `?format=xlsx`면 같은 대조를 신구대비표 엑셀로 돌려준다(바뀐 문단만 — 수백 KB라 서명 주소 없이 바로 보낸다).
 */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('로그인이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);
    if (!UUID.test(params.id)) return jsonError('문서를 찾을 수 없습니다.', 404);

    const outcome = await compareDocumentEditions(params.id, actor, {
      async loadRow(id, organizationId) {
        if (!UUID.test(id)) return null;
        const { data, error } = await supabaseAdmin
          .from('documents')
          .select(COMPARE_DOCUMENT_COLUMNS)
          .eq('id', id)
          .eq('organization_id', organizationId)
          .maybeSingle();
        if (error) throw new Error(`문서 조회 실패: ${error.message}`);
        return (data as unknown as CompareDocumentRow | null) ?? null;
      },
      async download(path) {
        const { data, error } = await supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET).download(path);
        if (error || !data) return null;
        return new Uint8Array(await data.arrayBuffer());
      },
    });
    if (!outcome.ok) return jsonError(outcome.message, outcome.status);

    if (request.nextUrl.searchParams.get('format') === 'xlsx') {
      const bytes = await buildEditionCompareWorkbook({ ...outcome.data, createdAt: new Date() });
      return new NextResponse(new Uint8Array(bytes), { status: 200, headers: compareXlsxHeaders(outcome.data.new.name) });
    }
    return NextResponse.json({ ok: true, data: outcome.data });
  } catch (error) {
    console.error('[documents compare]', params.id, error instanceof Error ? error.message : error);
    return jsonError('두 판을 비교하는 중 오류가 발생했습니다.', 500);
  }
}
