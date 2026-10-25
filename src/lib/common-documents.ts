// src/lib/common-documents.ts
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { logSystem } from '@/lib/logger';
import { noda, nodaErrorFields, type NodaClient } from '@/lib/noda';
import { commonTenant, isOrgType } from '@/lib/org-types';
import type { CommonDocument } from '@/lib/db';
import type { ReadingDeps, ReadingStore, StoredDocument } from '@/lib/document-reading';

/**
 * 공통 자료실(S5, 설계 6·7절)의 읽기 상태·판 바꾸기·삭제.
 *
 * - 읽기 상태 기계는 S4의 `document-reading.ts`를 그대로 쓴다 — 여기는 표(`common_documents`)와 보관함(`workon-c-{유형 열쇠}`)만 다르다
 * - **새 판이 `ready`가 된 뒤에야 옛 판을 내린다**(`retireReplacedEdition`). 새 판이 읽히는 동안(reading·failed)은 옛 판이 계속 근거가 된다
 * - 옛 판은 행·원본을 감사용으로 남기고 NODA 사본만 지운다(`retired`)
 * - 삭제 순서는 문서와 같다: NODA → 행 → 원본. 운영 기록에는 파일 이름을 남기지 않는다(문서 id·코드·상태만)
 */

const READ_COLUMNS =
  'id, org_type, storage_path, file_name, noda_status, noda_reason, noda_filename, noda_doc_id, ' +
  'noda_read_started_at, noda_last_attempt_at, noda_read_at, created_at';

function readingStore(): ReadingStore {
  return {
    async getRow(id) {
      const { data, error } = await supabaseAdmin.from('common_documents').select(READ_COLUMNS).eq('id', id).maybeSingle();
      if (error) throw new Error(`공통 문서 조회 실패: ${error.message}`);
      return (data as unknown as StoredDocument | null) ?? null;
    },
    async restart(id, fields) {
      const { data, error } = await supabaseAdmin
        .from('common_documents')
        .update({ ...fields, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('noda_status', 'failed')
        .select('id');
      if (error) throw new Error(`공통 문서 읽기 다시 시작 실패: ${error.message}`);
      return (data?.length ?? 0) > 0;
    },
    async claim(id, nowIso, cutoffIso) {
      const { data, error } = await supabaseAdmin
        .from('common_documents')
        .update({ noda_last_attempt_at: nowIso })
        .eq('id', id)
        .eq('noda_status', 'reading')
        .or(`noda_last_attempt_at.is.null,noda_last_attempt_at.lt.${cutoffIso}`)
        .select('id');
      if (error) throw new Error(`공통 문서 읽기 차지 실패: ${error.message}`);
      return (data?.length ?? 0) > 0;
    },
    async finish(id, patch) {
      const { data, error } = await supabaseAdmin
        .from('common_documents')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('noda_status', 'reading')
        .select('id');
      if (error) throw new Error(`공통 문서 읽기 결과 저장 실패: ${error.message}`);
      return (data?.length ?? 0) > 0;
    },
    async download(path) {
      try {
        const { data, error } = await supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET).download(path);
        if (error || !data) return null;
        return new Uint8Array(await data.arrayBuffer());
      } catch {
        return null;
      }
    },
  };
}

/** 공통 문서의 읽기 의존 — 보관함은 행의 유형 열쇠로 정하고, `ready`가 되면 옛 판을 내린다 */
export function commonReadingDeps(): ReadingDeps {
  return {
    store: readingStore(),
    noda,
    now: () => Date.now(),
    log: logSystem,
    tenantOf: (row) => (isOrgType(row.org_type) ? commonTenant(row.org_type) : null),
    afterReady: async (id) => {
      await retireReplacedEdition(id);
    },
  };
}

export interface CommonStore {
  getRow(id: string): Promise<CommonDocument | null>;
  /** 현재 판(`retired_at` NULL)이고 `deleting`이 아닐 때만 `noda_status='retired'`·`retired_at`을 쓴다. 바뀌었으면 true */
  retire(id: string, nowIso: string): Promise<boolean>;
  markDeleting(id: string): Promise<boolean>;
  deleteRow(id: string): Promise<boolean>;
  removeFile(path: string): Promise<void>;
}

export interface CommonDeps {
  store: CommonStore;
  noda: Pick<NodaClient, 'deleteDocument'>;
  now: () => number;
  log: (p: Parameters<typeof logSystem>[0]) => Promise<void>;
}

function defaultStore(): CommonStore {
  return {
    async getRow(id) {
      const { data, error } = await supabaseAdmin.from('common_documents').select('*').eq('id', id).maybeSingle();
      if (error) throw new Error(`공통 문서 조회 실패: ${error.message}`);
      return (data as CommonDocument | null) ?? null;
    },
    async retire(id, nowIso) {
      const { data, error } = await supabaseAdmin
        .from('common_documents')
        .update({ noda_status: 'retired', retired_at: nowIso, updated_at: nowIso })
        .eq('id', id)
        .is('retired_at', null)
        .neq('noda_status', 'deleting')
        .select('id');
      if (error) throw new Error(`공통 문서 지난 판 표시 실패: ${error.message}`);
      return (data?.length ?? 0) > 0;
    },
    async markDeleting(id) {
      const { error } = await supabaseAdmin
        .from('common_documents')
        .update({ noda_status: 'deleting', updated_at: new Date().toISOString() })
        .eq('id', id);
      return !error;
    },
    async deleteRow(id) {
      const { error } = await supabaseAdmin.from('common_documents').delete().eq('id', id);
      return !error;
    },
    async removeFile(path) {
      // 공통 문서의 원본은 행마다 따로라 '다른 행이 쓰는지' 볼 필요가 없다
      const { error } = await supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET).remove([path]);
      if (error) throw new Error(`공통 문서 원본 지우기 실패: ${error.message}`);
    },
  };
}

export function defaultCommonDeps(): CommonDeps {
  return { store: defaultStore(), noda, now: () => Date.now(), log: logSystem };
}

/** NODA 사본이 있을 수 있는 행인가 — 옛 행(NULL)·지난 판(retired)·파일 이름 없는 행은 NODA를 부르지 않는다 */
function hasNodaCopy(row: Pick<CommonDocument, 'noda_status' | 'noda_filename'>): boolean {
  return Boolean(row.noda_status) && row.noda_status !== 'retired' && Boolean(row.noda_filename);
}

/**
 * 새 판(`newId`)이 `ready`가 된 뒤 옛 판을 내린다 — 옛 판의 NODA 사본을 지우고(404 = 지움) `retired`로.
 * 새 판 행을 **다시 읽어** `ready`이고 `replaces_id`가 있을 때만 움직인다(읽는 중·실패면 옛 판이 계속 현재 판이다).
 * 옛 판이 같은 유형의 현재 판(`retired_at` NULL, `deleting` 아님)이 아니면 건드리지 않는다.
 * NODA를 못 지우면 옛 판을 `deleting`으로 남긴다(지우기 길로 다시 치울 수 있다).
 */
export async function retireReplacedEdition(
  newId: string,
  deps: CommonDeps = defaultCommonDeps(),
): Promise<'retired' | 'none' | 'kept_deleting'> {
  const fresh = await deps.store.getRow(newId);
  if (!fresh || fresh.noda_status !== 'ready' || !fresh.replaces_id) return 'none';

  const old = await deps.store.getRow(fresh.replaces_id);
  if (!old || old.org_type !== fresh.org_type) return 'none';
  if (old.retired_at || old.noda_status === 'retired' || old.noda_status === 'deleting') return 'none';

  if (hasNodaCopy(old)) {
    try {
      await deps.noda.deleteDocument(commonTenant(old.org_type), old.noda_filename as string);
    } catch (err) {
      await deps.store.markDeleting(old.id);
      await deps.log({
        level: 'warning',
        category: 'api',
        message: '공통 문서 옛 판의 NODA 사본을 지우지 못함 — 지우기로 다시 치워 주세요',
        details: { document_id: old.id, ...nodaErrorFields(err) },
      });
      return 'kept_deleting';
    }
  }

  if (!(await deps.store.retire(old.id, new Date(deps.now()).toISOString()))) return 'none';
  await deps.log({
    level: 'info',
    category: 'api',
    message: '공통 문서 지난 판으로 바꿈',
    details: { document_id: old.id, replaced_by: newId },
  });
  return 'retired';
}

/**
 * 공통 문서 하나를 지운다 — 순서 NODA → 행 → 원본. NODA를 못 지우면 행을 `deleting`으로 남기고 502
 * (사본을 남긴 채 행을 지우면 찾을 수 없는 고아가 된다). `deleting` 행은 다시 지울 수 있다.
 */
export async function deleteCommonDocument(
  id: string,
  deps: CommonDeps = defaultCommonDeps(),
): Promise<{ ok: true } | { ok: false; status: 404 | 502 }> {
  const row = await deps.store.getRow(id);
  if (!row) return { ok: false, status: 404 };

  if (hasNodaCopy(row)) {
    try {
      await deps.noda.deleteDocument(commonTenant(row.org_type), row.noda_filename as string);
    } catch (err) {
      const marked = await deps.store.markDeleting(id);
      await deps.log({
        level: 'error',
        category: 'api',
        message: marked
          ? '공통 문서 NODA 삭제 실패 — 행을 deleting으로 남김'
          : '공통 문서 NODA 삭제 실패 — 행을 deleting으로 표시하지 못함',
        details: { document_id: id, ...nodaErrorFields(err) },
      });
      return { ok: false, status: 502 };
    }
  }

  // NODA 삭제가 끝난 뒤 행 삭제가 실패해도 다시 지워도 안전하다 — NODA는 이미 없는 사본에 404를 주고 그건 지운 것으로 센다
  if (!(await deps.store.deleteRow(id))) return { ok: false, status: 502 };

  try {
    await deps.store.removeFile(row.storage_path);
  } catch {
    await deps.log({
      level: 'warning',
      category: 'api',
      message: '공통 문서 원본 파일을 지우지 못함 — 행은 지웠음',
      details: { document_id: id },
    });
  }
  return { ok: true };
}
