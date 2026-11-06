import { NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { ADMIN_COMMON_COLUMNS, adminCommonList, type CommonLibraryRow } from '@/lib/common-library-admin';
import { isOrgType } from '@/lib/org-types';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 기관 관리자용 공통 자료실 목록(2026-11-06) — 이 기관 유형에서 문서 찾기 비서가 지금 근거로 쓰는 정부 기준 문서.
 * 읽기만(공통 자료실은 운영자가 관리). 기관 유형으로만 고르고, 저장소 경로·NODA 칸은 내보내지 않는다
 */
export async function GET() {
  const session = await getServerAuthSession();
  if (!isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
  const actor = await getActorScope(session!);
  if (!actor?.organizationId) return jsonError('소속 기관을 찾을 수 없습니다.', 403);

  const org = await supabaseAdmin.from('organizations').select('type').eq('id', actor.organizationId).maybeSingle();
  if (org.error) return jsonError('공통 자료실을 지금 불러올 수 없습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  const orgType = (org.data as { type?: unknown } | null)?.type;
  if (!isOrgType(orgType)) return NextResponse.json({ ok: true, data: adminCommonList(null, []) });

  const docs = await supabaseAdmin.from('common_documents').select(ADMIN_COMMON_COLUMNS).eq('org_type', orgType).is('retired_at', null);
  if (docs.error) return jsonError('공통 자료실을 지금 불러올 수 없습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  return NextResponse.json({ ok: true, data: adminCommonList(orgType, (docs.data ?? []) as unknown as CommonLibraryRow[]) });
}
