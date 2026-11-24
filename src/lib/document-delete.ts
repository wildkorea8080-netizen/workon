// src/lib/document-delete.ts
// 비서 문서 하나 지우기 — 관리자 문서 화면(DELETE /api/documents)과 기관 API(DELETE /api/v1/documents/[id], 0104)가 함께 쓴다.
// 권한 판정은 부르는 쪽이 한다. 여기서는 지우는 순서만 한 곳에 둔다.
//
// 순서: NODA → DB 행 → 저장소 원본. NODA 사본을 남긴 채 행을 지우면 찾을 수 없는 고아가 남고,
// 그 조각이 근거로 오는 턴은 근거 없이 답하게 된다(문서 찾기가 고아를 알아보고 버린 뒤 지운다 — 판정 H).
// 그래서 NODA가 먼저 성공해야 행을 지운다.
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { recordAgentEvent } from '@/lib/agent-store';
import { removeStorageFileIfUnused } from '@/lib/document-files';
import { noda, nodaTenant } from '@/lib/noda';
import { logSystem } from '@/lib/logger';

export const NODA_DELETE_FAILED_MESSAGE = '문서 보관소에서 지우지 못했습니다. 잠시 뒤 다시 지워 주세요.';
export const DOCUMENT_DELETE_FAILED_MESSAGE = '문서를 지우지 못했습니다. 잠시 뒤 다시 시도해 주세요.';

/** 지울 문서 행 — 부르는 쪽이 이 칸들을 읽어 넘긴다 */
export interface DeletableDocument {
  id: string;
  storage_path: string | null;
  agent_id: string | null;
  file_name: string;
  noda_filename: string | null;
  noda_status: string | null;
}

/**
 * 지운다. NODA 실패면 행을 `deleting`으로 남기고 502(다시 지우면 같은 길을 다시 탄다), 행 삭제 실패는 500.
 * `via`는 비서 타임라인(`document_removed`)에 남길 길(기관 API면 'org_api')
 */
export async function deleteAgentDocument(
  doc: DeletableDocument,
  actorUserId: string,
  via?: string,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  // NODA에 간 적 없는 옛 행(noda_status NULL)·지난 판(사본을 이미 지움)은 건너뛴다. 이미 없는 사본(404)은 지운 것과 같다.
  if (doc.agent_id && doc.noda_filename && doc.noda_status && doc.noda_status !== 'retired') {
    let nodaFailed = false;
    let nodaError: unknown = null;
    try {
      await noda.deleteDocument(nodaTenant(doc.agent_id), doc.noda_filename);
    } catch (e) {
      nodaFailed = true;
      nodaError = e;
    }
    if (nodaFailed) {
      // 지우는 중임을 남긴다 — 읽기 라우트가 이 행을 되살리지 않고, 다시 지우면 같은 길을 다시 탄다.
      const { error: markError } = await supabaseAdmin
        .from('documents')
        .update({ noda_status: 'deleting' })
        .eq('id', doc.id);
      await logSystem({
        level: 'error',
        category: 'api',
        message: markError
          ? 'NODA 문서 삭제 실패 — 행을 deleting으로 표시하지 못함'
          : 'NODA 문서 삭제 실패 — 행을 deleting으로 남김',
        details: {
          document_id: doc.id,
          error: nodaError instanceof Error ? nodaError.message : String(nodaError),
          ...(via ? { via } : {}),
          ...(markError ? { mark_failed: true, mark_error: markError.message } : {}),
        },
      });
      return { ok: false, status: 502, message: NODA_DELETE_FAILED_MESSAGE };
    }
  }

  // NODA 삭제가 끝난 뒤 이 DB 삭제가 실패하면 다시 지워도 안전하다 — NODA는 이미 없는 사본에 404를 주고, 그건 성공으로 센다.
  const { error } = await supabaseAdmin.from('documents').delete().eq('id', doc.id);
  if (error) return { ok: false, status: 500, message: DOCUMENT_DELETE_FAILED_MESSAGE };

  // 여러 비서에 한 번에 올린 문서는 저장소 파일 하나를 함께 쓴다.
  // 다른 행이 남아 있거나 세지 못하면 파일을 지우지 않는다.
  if (doc.storage_path) await removeStorageFileIfUnused(doc.storage_path);

  if (doc.agent_id) {
    await recordAgentEvent(doc.agent_id, 'document_removed', actorUserId, { file_name: doc.file_name, ...(via ? { via } : {}) });
  }
  return { ok: true };
}
