import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_SIZE_LABEL } from '@/lib/file-types';
import { checkUploadFile } from '@/lib/document-upload';
import { startReadingFields, reconcileReading } from '@/lib/document-reading';
import { commonReadingDeps, retireReplacedEdition } from '@/lib/common-documents';
import { checkCommonConfirm, parseCommonStoragePath } from '@/lib/common-upload';
import { ORG_TYPES, commonNodaFilename, isOrgType } from '@/lib/org-types';
import { logSystem } from '@/lib/logger';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

function bucket() {
  return supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET);
}

/** 저장소가 아는 객체 크기. 객체가 없거나 알 수 없으면 null */
async function storedSize(path: string): Promise<number | null> {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash);
  const name = path.slice(slash + 1);
  try {
    const { data, error } = await bucket().list(dir, { search: name });
    if (error || !data) return null;
    const hit = data.find((o: { name: string }) => o.name === name) as { metadata?: { size?: unknown } } | undefined;
    const size = hit?.metadata?.size;
    return typeof size === 'number' ? size : null;
  } catch {
    return null;
  }
}

/** 지우지 못해도 확인 결과는 바꾸지 않는다 — 남은 객체는 저장 공간만 쓴다 */
async function discardObject(path: string): Promise<void> {
  try {
    const { error } = await bucket().remove([path]);
    if (error) console.error('[super common-documents confirm] 객체 삭제 실패', path, error.message);
  } catch (e) {
    console.error('[super common-documents confirm] 객체 삭제 실패', path, e);
  }
}

/** 화면으로 나가지 않는 칸 — 저장소 경로·NODA 파일 이름(`{id}__…`)·시각 칸·NODA 문서 id */
const PRIVATE_COLUMNS = [
  'storage_path',
  'noda_filename',
  'noda_read_started_at',
  'noda_last_attempt_at',
  'noda_doc_id',
] as const;

function toClientRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const col of PRIVATE_COLUMNS) delete out[col];
  return out;
}

const LIST_COLUMNS =
  'id, org_type, title, edition_year, usage_terms, file_name, file_type, size_bytes, replaces_id, retired_at, created_at, ' +
  'noda_status, noda_reason, noda_read_at, ' +
  PRIVATE_COLUMNS.join(', ');

type ListRow = {
  id: string;
  org_type: string;
  edition_year: number;
  retired_at: string | null;
  created_at: string;
  noda_status: 'reading' | 'ready' | 'failed' | 'unreadable' | 'deleting' | 'retired' | null;
  noda_filename: string | null;
  noda_read_started_at: string | null;
  noda_last_attempt_at: string | null;
} & Record<string, unknown>;

/** 유형(표 순서) → 현재 판 먼저 → 기준 연도 최신 → 올린 순서 최신 */
function compareRows(a: ListRow, b: ListRow): number {
  const ta = ORG_TYPES.findIndex((t) => t === a.org_type);
  const tb = ORG_TYPES.findIndex((t) => t === b.org_type);
  if (ta !== tb) return ta - tb;
  const ra = a.retired_at ? 1 : 0;
  const rb = b.retired_at ? 1 : 0;
  if (ra !== rb) return ra - rb;
  if (a.edition_year !== b.edition_year) return b.edition_year - a.edition_year;
  return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
}

/**
 * 옛 판 내리기 다시 걸기 — 새 판이 `ready`가 된 뒤 `retireReplacedEdition`이 실패하면(잠깐의 DB 오류 등)
 * 새 판은 더 이상 `reading`이 아니라 아무도 다시 부르지 않고, 두 판이 모두 현재 판으로 남는다.
 * 그래서 목록을 열 때마다 `ready` 현재 판이 대신하는 옛 판이 아직 현재 판이면 다시 부른다(여러 번 불러도 안전하다).
 * 실패는 기록만 하고 목록은 그대로 보낸다. 바뀐 옛 판 행은 다시 읽어 응답에 반영한다.
 * (`deleting`인 옛 판은 이미 NODA 삭제에 실패해 지우기 길을 기다리는 것이라 건너뛴다 — 다시 불러도 바뀌지 않는다)
 */
async function retryPendingRetirements(rows: ListRow[]): Promise<ListRow[]> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pending = rows.filter((r) => {
    if (r.retired_at || r.noda_status !== 'ready' || typeof r.replaces_id !== 'string') return false;
    const target = byId.get(r.replaces_id);
    return Boolean(target) && !target!.retired_at && target!.noda_status !== 'deleting';
  });
  if (pending.length === 0) return rows;

  for (const row of pending) {
    try {
      await retireReplacedEdition(row.id);
    } catch (retireError) {
      await logSystem({
        level: 'warning',
        category: 'database',
        message: '공통 문서 옛 판 내리기 다시 걸기 실패 — 다음 목록 때 다시 건다',
        details: {
          document_id: row.id,
          error: retireError instanceof Error ? retireError.message : String(retireError),
        },
      });
    }
  }

  const targetIds = pending.map((r) => r.replaces_id as string);
  try {
    const { data, error } = await supabaseAdmin.from('common_documents').select(LIST_COLUMNS).in('id', targetIds);
    if (error || !data) return rows;
    const fresh = new Map(((data ?? []) as unknown as ListRow[]).map((r) => [r.id, r]));
    return rows.map((r) => fresh.get(r.id) ?? r).sort(compareRows);
  } catch {
    return rows;
  }
}

/**
 * 공통 문서 목록(운영자). `?org_type=`으로 유형을 좁힌다(없으면 전부).
 * 읽는 중인 행만 NODA와 맞춘다 — 실패해도 목록은 맞추기 전 값 그대로 보낸다.
 * 그 뒤 실패해 남은 옛 판 내리기를 다시 건다(`retryPendingRetirements`).
 */
export async function GET(request: NextRequest) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return jsonError('인증이 필요합니다.', 401);

  try {
    const orgType = new URL(request.url).searchParams.get('org_type');
    if (orgType !== null && !isOrgType(orgType)) return jsonError('기관 유형이 올바르지 않습니다.', 400);

    let query = supabaseAdmin.from('common_documents').select(LIST_COLUMNS);
    if (orgType) query = query.eq('org_type', orgType);
    const { data, error } = await query;
    if (error) {
      console.error('[super common-documents list]', error.message);
      return jsonError('문서 목록을 불러오지 못했습니다.', 500);
    }

    let rows = ((data ?? []) as unknown as ListRow[]).slice().sort(compareRows);
    try {
      rows = await reconcileReading(rows, commonReadingDeps());
    } catch (reconcileError) {
      await logSystem({
        level: 'warning',
        category: 'database',
        message: '공통 문서 읽기 상태 맞추기 실패 — 맞추기 전 목록을 그대로 보냄',
        details: { error: reconcileError instanceof Error ? reconcileError.message : String(reconcileError) },
      });
    }

    rows = await retryPendingRetirements(rows);

    return NextResponse.json({ ok: true, data: rows.map(toClientRow) });
  } catch (error) {
    console.error('[super common-documents list]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}

/**
 * ② 공통 문서 확인(운영자). 올린 원본이 이 유형의 것이고 발급 10분 안이며 크기·형식이 맞는지 보고 `reading` 행을 만든다.
 * 읽기는 화면이 이어서 /api/super/common-documents/{id}/read로 건다.
 */
export async function POST(request: NextRequest) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return jsonError('인증이 필요합니다.', 401);

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError('요청 형식이 올바르지 않습니다.', 400);
    }

    const now = Date.now();
    const checked = checkCommonConfirm(body, now);
    const rawPath =
      body && typeof body === 'object' && typeof (body as { storage_path?: unknown }).storage_path === 'string'
        ? (body as { storage_path: string }).storage_path
        : '';

    // ── 이미 확인한 경로: 객체를 지우면 안 된다(그 행이 쓰는 원본이다) — 시간·크기 판정보다 먼저 본다 ──
    if (parseCommonStoragePath(rawPath)) {
      const { data: existing, error: existingError } = await supabaseAdmin
        .from('common_documents')
        .select('id')
        .eq('storage_path', rawPath)
        .limit(1);
      if (existingError) {
        console.error('[super common-documents confirm] 기존 행 조회 실패:', existingError.message);
        return jsonError('잠시 뒤 다시 시도해 주세요.', 500);
      }
      if ((existing ?? []).length > 0) return jsonError('이미 등록된 파일입니다.', 409);
    }

    if (!checked.ok) {
      // 서명 주소는 2시간 살아 있다 — 확인 시간이 지난 객체는 지운다. 입력 실수(400)는 남겨 고쳐서 다시 확인할 수 있게 한다
      if (checked.status === 410) await discardObject(rawPath);
      return jsonError(checked.message, checked.status);
    }
    const input = checked.value;
    const path = input.storage_path;
    const parsed = parseCommonStoragePath(path);
    if (!parsed) return jsonError('올린 파일의 경로가 올바르지 않습니다. 다시 올려 주세요.', 400);

    // ── 서명 주소는 크기를 강제하지 않는다. 저장소가 아는 실제 크기로 거른다 ──
    const size = await storedSize(path);
    if (size === null) {
      await discardObject(path);
      return jsonError('올린 파일의 크기를 확인하지 못했습니다. 다시 올려 주세요.', 413);
    }
    if (size > MAX_UPLOAD_BYTES) {
      await discardObject(path);
      return jsonError(`파일 크기가 너무 큽니다. 최대 ${MAX_UPLOAD_SIZE_LABEL}까지 업로드할 수 있습니다.`, 413);
    }

    // ── 파일 이름·형식 다시 검사 — NODA 파일 이름의 확장자가 여기서 온다 ──
    const file = checkUploadFile({ fileName: input.file_name, size, mimeType: input.file_type ?? '' });
    if (!file.ok) {
      await discardObject(path);
      return jsonError(file.message, file.status);
    }
    // 발급 때 정한 확장자와 다른 이름으로 확인하면 형식 검사를 우회할 수 있다
    if (file.ext !== parsed.ext) {
      await discardObject(path);
      return jsonError('올린 파일과 파일 이름의 형식이 다릅니다. 다시 올려 주세요.', 400);
    }

    // ── 같은 유형·같은 이름의 현재 판이 있으면 '바꿀 옛 판'으로만 올릴 수 있다 ──
    const { data: sameTitle, error: sameTitleError } = await supabaseAdmin
      .from('common_documents')
      .select('id')
      .eq('org_type', input.org_type)
      .eq('title', input.title)
      .is('retired_at', null)
      .neq('noda_status', 'deleting');
    if (sameTitleError) {
      console.error('[super common-documents confirm] 같은 이름 조회 실패:', sameTitleError.message);
      return jsonError('잠시 뒤 다시 시도해 주세요.', 500);
    }
    if ((sameTitle ?? []).some((r: { id: string }) => r.id !== input.replaces_id)) {
      return jsonError("같은 이름의 문서가 이미 있습니다 — '바꿀 옛 판'으로 고르세요", 409);
    }

    // ── 바꿀 옛 판: 같은 유형의 현재 판이어야 한다 ──
    if (input.replaces_id) {
      const { data: old, error: oldError } = await supabaseAdmin
        .from('common_documents')
        .select('id, org_type, retired_at, noda_status')
        .eq('id', input.replaces_id)
        .maybeSingle();
      if (oldError) {
        console.error('[super common-documents confirm] 옛 판 조회 실패:', oldError.message);
        return jsonError('잠시 뒤 다시 시도해 주세요.', 500);
      }
      if (
        !old ||
        old.org_type !== input.org_type ||
        old.retired_at ||
        old.noda_status === 'deleting' ||
        old.noda_status === 'retired'
      ) {
        return jsonError('바꿀 옛 판은 같은 유형의 현재 문서여야 합니다.', 400);
      }
    }

    const id = randomUUID();
    const { error: insertError } = await supabaseAdmin.from('common_documents').insert({
      id,
      org_type: input.org_type,
      title: input.title,
      edition_year: input.edition_year,
      usage_terms: input.usage_terms,
      file_name: input.file_name,
      file_type: input.file_type,
      size_bytes: size,
      storage_path: path,
      noda_filename: commonNodaFilename({
        id,
        title: input.title,
        editionYear: input.edition_year,
        fileName: input.file_name,
      }),
      replaces_id: input.replaces_id,
      uploaded_by: admin.sub,
      ...startReadingFields(new Date(now)),
    });
    if (insertError) {
      console.error('[super common-documents confirm] insert error:', insertError);
      return jsonError('문서를 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 500);
    }

    await supabaseAdmin.from('super_admin_logs').insert({
      admin_user_id: admin.sub,
      action: 'common_document_uploaded',
      target_type: 'common_document',
      target_id: id,
      after_data: {
        title: input.title,
        org_type: input.org_type,
        edition_year: input.edition_year,
        usage_terms: input.usage_terms,
        replaces_id: input.replaces_id,
      },
    });

    return NextResponse.json({ ok: true, data: { id } }, { status: 201 });
  } catch (error) {
    console.error('[super common-documents confirm]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
