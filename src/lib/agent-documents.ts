// src/lib/agent-documents.ts
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSystem } from '@/lib/logger';
import { noda, nodaTenant, NodaError, type NodaClient } from '@/lib/noda';
import { removeStorageFileIfUnused } from '@/lib/document-files';

/**
 * 지운 비서의 참고 문서 치우기(`softDeleteAgent`가 부른다).
 *
 * 비서는 숨김이라 행이 남지만 문서는 다르다 — documents 행은 visibilityFilter로 문서 목록에 그대로 잡히고,
 * NODA 보관함(`workon-a…`)은 숨긴 비서를 다시 부르는 곳이 없어 사본이 영영 남는다.
 *
 * 순서는 문서 하나를 지울 때와 같다: **NODA 보관함 → DB 행 → 저장소 원본.**
 * - 보관함은 통째로 비운다(`DELETE /documents?all=1&confirm=<보관함>`) — 행이 없는 고아 사본까지 함께 사라진다
 * - NODA를 못 비우면 NODA에 간 적 있는 행은 지우지 않고 `deleting`으로 남긴다. 관리자가 문서 화면에서
 *   하나씩 다시 지울 수 있고(그 길은 파일 하나씩 지운다), 행을 먼저 지우면 사본을 찾을 길이 없어진다
 * - NODA에 간 적 없는 옛 행(`noda_status` NULL)은 기다릴 것이 없어 바로 지운다
 *
 * 비서 지우기는 이미 끝났으므로 여기서 던지지 않는다. 운영 기록에는 파일 이름을 남기지 않는다.
 */

export interface AgentDocumentRow {
  id: string;
  storage_path: string | null;
  noda_status: string | null;
}

export interface AgentDocumentsDeps {
  store: {
    /** 실패면 null */
    listRows(agentId: string): Promise<AgentDocumentRow[] | null>;
    deleteRows(ids: string[]): Promise<boolean>;
    markDeleting(ids: string[]): Promise<boolean>;
    removeFileIfUnused(path: string): Promise<void>;
  };
  noda: Pick<NodaClient, 'deleteTenant'>;
  log: (p: Parameters<typeof logSystem>[0]) => Promise<void>;
}

export interface AgentDocumentsResult {
  /** 실제로 지운 행 수 */
  removed: number;
  /** NODA를 못 비워 `deleting`으로 남긴 행 수 */
  kept: number;
  /** NODA 보관함을 비웠는가(보관함이 원래 없었던 것도 참) */
  nodaCleared: boolean;
}

function defaultStore(): AgentDocumentsDeps['store'] {
  return {
    async listRows(agentId) {
      const { data, error } = await supabaseAdmin
        .from('documents')
        .select('id, storage_path, noda_status')
        .eq('agent_id', agentId);
      if (error) {
        console.error('[agent-documents] 지운 비서의 문서 조회 실패', agentId, error.message);
        return null;
      }
      return (data ?? []) as AgentDocumentRow[];
    },
    async deleteRows(ids) {
      const { error } = await supabaseAdmin.from('documents').delete().in('id', ids);
      if (error) console.error('[agent-documents] 지운 비서의 문서 삭제 실패', error.message);
      return !error;
    },
    async markDeleting(ids) {
      const { error } = await supabaseAdmin.from('documents').update({ noda_status: 'deleting' }).in('id', ids);
      if (error) console.error('[agent-documents] 지운 비서의 문서를 deleting으로 남기지 못함', error.message);
      return !error;
    },
    removeFileIfUnused: removeStorageFileIfUnused,
  };
}

export function defaultAgentDocumentsDeps(): AgentDocumentsDeps {
  return { store: defaultStore(), noda, log: logSystem };
}

export async function removeAgentDocuments(
  agentId: string,
  deps: AgentDocumentsDeps = defaultAgentDocumentsDeps(),
): Promise<AgentDocumentsResult> {
  // 행을 못 읽어도 보관함은 비운다 — 숨긴 비서의 보관함은 쓸 곳이 없고, 남은 행은 문서 화면에서 지우면 NODA가 404(이미 없음)로 답한다
  const rows = await deps.store.listRows(agentId);

  let nodaError: unknown = null;
  try {
    await deps.noda.deleteTenant(nodaTenant(agentId));
  } catch (err) {
    nodaError = err ?? new Error('unknown');
  }
  const nodaCleared = nodaError === null;
  if (!rows) return { removed: 0, kept: 0, nodaCleared };

  const keptIds = nodaCleared ? [] : rows.filter((r) => r.noda_status).map((r) => r.id);
  if (!nodaCleared) {
    const code = nodaError instanceof NodaError ? nodaError.code : 'unknown';
    const status = nodaError instanceof NodaError ? nodaError.status : null;
    // 남긴 행이 없고 키도 없으면(NODA를 쓰지 않는 환경) 비울 것도 없다
    if (keptIds.length > 0 || code !== 'missing_key') {
      await deps.log({
        level: status === 401 || status === 403 ? 'critical' : 'warning',
        category: 'api',
        message: '지운 비서의 NODA 보관함을 비우지 못함 — 문서 화면에서 다시 지워 주세요',
        details: { agent_id: agentId, documents_kept: keptIds.length, code, status },
      });
    }
    if (keptIds.length > 0) await deps.store.markDeleting(keptIds);
  }

  const kept = new Set(keptIds);
  const toDelete = rows.filter((r) => !kept.has(r.id));
  if (toDelete.length === 0) return { removed: 0, kept: keptIds.length, nodaCleared };
  if (!(await deps.store.deleteRows(toDelete.map((r) => r.id)))) {
    return { removed: 0, kept: keptIds.length, nodaCleared };
  }

  // 같은 파일을 다른 비서의 문서가 함께 쓰고 있으면 도우미가 남겨 둔다
  const paths = [...new Set(toDelete.map((r) => r.storage_path).filter((p): p is string => Boolean(p)))];
  for (const path of paths) {
    try {
      await deps.store.removeFileIfUnused(path);
    } catch (err) {
      console.error('[agent-documents] 지운 비서의 문서 파일 정리 실패', agentId, path, err);
    }
  }
  return { removed: toDelete.length, kept: keptIds.length, nodaCleared };
}
