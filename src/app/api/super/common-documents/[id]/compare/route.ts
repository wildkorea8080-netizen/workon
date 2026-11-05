import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { compareCommonEditions, COMMON_COMPARE_COLUMNS, type CommonCompareRow } from '@/lib/common-edition-compare';
import { buildEditionCompareWorkbook, compareXlsxHeaders } from '@/lib/edition-compare-xlsx';
import { compareHwpxHeaders, editionCompareHwpxFile } from '@/lib/edition-compare-hwpx';

export const dynamic = 'force-dynamic';
// 글자 층이 없는 PDF는 NODA /parse로 읽는다(한 번 60초) — 두 판을 함께 읽어도 넉넉하게
export const maxDuration = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 공통 문서 새 판과 그 판이 바꾼 옛 판의 신구 대비(문단 단위, 모델 없음). 슈퍼관리자만.
 * `?format=xlsx`면 같은 대조를 신구대비표 엑셀로 돌려준다.
 */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return jsonError('인증이 필요합니다.', 401);

  try {
    if (!UUID.test(params.id)) return jsonError('문서를 찾을 수 없습니다.', 404);

    const outcome = await compareCommonEditions(params.id, {
      async loadRow(id) {
        if (!UUID.test(id)) return null;
        const { data, error } = await supabaseAdmin.from('common_documents').select(COMMON_COMPARE_COLUMNS).eq('id', id).maybeSingle();
        if (error) throw new Error(`공통 문서 조회 실패: ${error.message}`);
        return (data as unknown as CommonCompareRow | null) ?? null;
      },
      async download(path) {
        const { data, error } = await supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET).download(path);
        if (error || !data) return null;
        return new Uint8Array(await data.arrayBuffer());
      },
    });
    if (!outcome.ok) return jsonError(outcome.message, outcome.status);

    if (request.nextUrl.searchParams.get('format') === 'hwpx') {
      const file = await editionCompareHwpxFile({ ...outcome.data, createdAt: new Date() });
      if (!file.ok) return jsonError(file.message, file.status);
      return new NextResponse(new Uint8Array(file.bytes), { status: 200, headers: compareHwpxHeaders(outcome.data.new.name) });
    }
    if (request.nextUrl.searchParams.get('format') === 'xlsx') {
      const bytes = await buildEditionCompareWorkbook({ ...outcome.data, createdAt: new Date() });
      return new NextResponse(new Uint8Array(bytes), { status: 200, headers: compareXlsxHeaders(outcome.data.new.name) });
    }
    return NextResponse.json({ ok: true, data: outcome.data });
  } catch (error) {
    console.error('[common-documents compare]', params.id, error instanceof Error ? error.message : error);
    return jsonError('두 판을 비교하는 중 오류가 발생했습니다.', 500);
  }
}
