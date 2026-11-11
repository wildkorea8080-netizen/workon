import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { isOrgType } from '@/lib/org-types';
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
 * 기관 관리자용 공통 기준 문서 신구 대비(2026-11-12) — 슈퍼관리자 화면의 '두 판 비교'와 같은 대조(`compareCommonEditions`, 문단 단위·모델 없음).
 * **이 기관 유형의 공통 문서만** 읽는다 — 다른 유형의 행은 없는 것처럼 404(공통 문서 원본 열기와 같은 경계). 읽기만.
 * `?format=xlsx`·`?format=hwpx`면 같은 대조를 신구대비표 엑셀·한글 파일로 돌려준다
 */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
  try {
    const actor = await getActorScope(session!);
    if (!actor?.organizationId) return jsonError('소속 기관을 찾을 수 없습니다.', 403);
    if (!UUID.test(params.id)) return jsonError('문서를 찾을 수 없습니다.', 404);
    const org = await supabaseAdmin.from('organizations').select('type').eq('id', actor.organizationId).maybeSingle();
    if (org.error) return jsonError('공통 기준 문서를 지금 불러올 수 없습니다. 잠시 뒤 다시 시도해 주세요.', 503);
    const orgType = (org.data as { type?: unknown } | null)?.type;
    if (!isOrgType(orgType)) return jsonError('문서를 찾을 수 없습니다.', 404);

    const outcome = await compareCommonEditions(params.id, {
      async loadRow(id) {
        if (!UUID.test(id)) return null;
        const { data, error } = await supabaseAdmin.from('common_documents').select(COMMON_COMPARE_COLUMNS).eq('id', id).eq('org_type', orgType).maybeSingle();
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

    const format = request.nextUrl.searchParams.get('format');
    if (format === 'hwpx') {
      const file = await editionCompareHwpxFile({ ...outcome.data, createdAt: new Date() });
      if (!file.ok) return jsonError(file.message, file.status);
      return new NextResponse(new Uint8Array(file.bytes), { status: 200, headers: compareHwpxHeaders(outcome.data.new.name) });
    }
    if (format === 'xlsx') {
      const bytes = await buildEditionCompareWorkbook({ ...outcome.data, createdAt: new Date() });
      return new NextResponse(new Uint8Array(bytes), { status: 200, headers: compareXlsxHeaders(outcome.data.new.name) });
    }
    return NextResponse.json({ ok: true, data: outcome.data });
  } catch (error) {
    console.error('[admin common-documents compare]', params.id, error instanceof Error ? error.message : error);
    return jsonError('두 판을 비교하는 중 오류가 발생했습니다.', 500);
  }
}
