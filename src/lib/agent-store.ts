// src/lib/agent-store.ts
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  AGENT_ACCESS_COLUMNS,
  type AgentAccessInfo,
  type AgentVisibility,
} from '@/lib/agent-permissions';
import type { AgentSettingsPatch } from '@/lib/agent-patch';
import { removeStorageFileIfUnused } from '@/lib/document-files';

/**
 * 비서 저장소 — 판 무결성이 걸린 쓰기는 전부 여기를 거친다.
 *
 * 권한은 판정하지 않는다. 라우트가 agent-permissions로 먼저 판정하고
 * 여기를 부른다. 여기서는 DB 함수(save_agent · change_agent_tier)의
 * 결과를 라우트가 쓰기 좋은 꼴로 바꾼다.
 */

export async function loadAgentAccess(agentId: string): Promise<AgentAccessInfo | null> {
  const { data, error } = await supabaseAdmin
    .from('agents')
    .select(AGENT_ACCESS_COLUMNS)
    .eq('id', agentId)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as AgentAccessInfo;
}

export type SaveResult =
  | { ok: true; version: number }
  | { ok: false; reason: 'conflict'; currentVersion: number }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'template_limit' }
  | { ok: false; reason: 'duplicate_name' }
  | { ok: false; reason: 'error'; message: string };

export async function saveAgentSettings(
  agentId: string,
  baseVersion: number,
  patch: AgentSettingsPatch,
  actorId: string | null,
  kind: 'settings' | 'revert' | 'preset_update',
  detail: Record<string, unknown> = {}
): Promise<SaveResult> {
  const { data, error } = await supabaseAdmin.rpc('save_agent', {
    p_agent_id: agentId,
    p_base_version: baseVersion,
    p_patch: patch,
    p_actor: actorId,
    p_kind: kind,
    p_detail: detail,
  });

  if (error) {
    if (error.code === '23514') return { ok: false, reason: 'template_limit' };
    if (error.code === '23505') return { ok: false, reason: 'duplicate_name' };
    console.error('[agent-store] save_agent 실패', error);
    return { ok: false, reason: 'error', message: error.message };
  }

  const result = data as { ok: boolean; version?: number; reason?: string; current_version?: number };
  if (result.ok && typeof result.version === 'number') return { ok: true, version: result.version };
  if (result.reason === 'conflict') {
    return { ok: false, reason: 'conflict', currentVersion: result.current_version ?? -1 };
  }
  return { ok: false, reason: 'not_found' };
}

/** 저장 실패를 라우트 응답으로. 메시지를 라우트마다 따로 쓰지 않는다. */
export function saveFailureResponse(result: Exclude<SaveResult, { ok: true }>): {
  status: number;
  message: string;
  details?: Record<string, unknown>;
} {
  switch (result.reason) {
    case 'conflict':
      return {
        status: 409,
        message: '다른 분이 먼저 고쳤습니다. 최신 내용을 확인한 뒤 다시 저장해 주세요.',
        details: { reason: 'conflict', currentVersion: result.currentVersion },
      };
    case 'not_found':
      return { status: 404, message: '비서를 찾을 수 없습니다.' };
    case 'template_limit':
      return { status: 400, message: '양식은 비서당 10개까지입니다.' };
    case 'duplicate_name':
      return { status: 409, message: '같은 이름의 비서가 이미 있습니다.' };
    case 'error':
      return { status: 500, message: '비서 저장 중 오류가 발생했습니다.' };
  }
}

export async function changeAgentTier(args: {
  agentId: string;
  tier: 'department' | 'official';
  actorId: string;
  departmentId: string | null;
  visibility: AgentVisibility;
}): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'duplicate_name' | 'error'; message?: string }> {
  const { data, error } = await supabaseAdmin.rpc('change_agent_tier', {
    p_agent_id: args.agentId,
    p_tier: args.tier,
    p_actor: args.actorId,
    p_department_id: args.departmentId,
    p_visibility: args.visibility,
  });
  if (error) {
    if (error.code === '23505') return { ok: false, reason: 'duplicate_name' };
    console.error('[agent-store] change_agent_tier 실패', error);
    return { ok: false, reason: 'error', message: error.message };
  }
  return (data as { ok: boolean }).ok ? { ok: true } : { ok: false, reason: 'not_found' };
}

/** 판 번호가 없는 기록(문서 올림·지움, 지움). 실패해도 본 작업은 되돌리지 않는다. */
export async function recordAgentEvent(
  agentId: string,
  kind: 'document_added' | 'document_removed' | 'deleted',
  actorId: string | null,
  detail: Record<string, unknown> = {}
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('agent_history')
    .insert({ agent_id: agentId, kind, changed_by: actorId, detail });
  if (error) console.error('[agent-store] 기록 실패', kind, agentId, error.message);
}

/**
 * 지우기 = 숨김. 행을 지우면 대화(conversations.agent_id)가 막고,
 * 판 기록과 messages.agent_version이 가리킬 대상도 사라진다.
 */
export async function softDeleteAgent(agentId: string, actorId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('agents')
    .update({ deleted_at: new Date().toISOString(), is_active: false, updated_by: actorId })
    .eq('id', agentId)
    .is('deleted_at', null)
    .select('id');
  if (error) {
    console.error('[agent-store] 지우기 실패', agentId, error.message);
    return false;
  }
  // 일치하는 행이 없으면(이미 지움·동시 지움·없는 id) 성공으로 보고하지 않고 기록도 남기지 않는다.
  if (!data || data.length === 0) return false;
  let documentsRemoved = 0;
  try {
    documentsRemoved = await removeAgentDocuments(agentId);
  } catch (err) {
    console.error('[agent-store] 지운 비서의 문서 정리 실패', agentId, err);
  }
  await recordAgentEvent(agentId, 'deleted', actorId, { documents_removed: documentsRemoved });
  return true;
}

/**
 * 지운 비서의 참고 문서를 치운다. 비서는 숨김이라 행이 남지만 문서는 다르다 —
 * documents 행은 visibilityFilter로 문서 목록과 Q&A 검색(search_document_chunks)에
 * 그대로 잡혀, 지운 비서에 올렸던 자료가 계속 보인다.
 *
 * 실패해도 비서 지우기는 되돌리지 않는다(이미 숨겼다). 로그만 남긴다.
 * 돌려주는 값은 실제로 지운 행 수다.
 */
async function removeAgentDocuments(agentId: string): Promise<number> {
  const { data: docs, error } = await supabaseAdmin
    .from('documents')
    .select('id, storage_path')
    .eq('agent_id', agentId);
  if (error) {
    console.error('[agent-store] 지운 비서의 문서 조회 실패', agentId, error.message);
    return 0;
  }
  const rows = (docs ?? []) as { id: string; storage_path: string | null }[];
  if (rows.length === 0) return 0;

  const { error: deleteError } = await supabaseAdmin
    .from('documents')
    .delete()
    .in('id', rows.map((d) => d.id));
  if (deleteError) {
    console.error('[agent-store] 지운 비서의 문서 삭제 실패', agentId, deleteError.message);
    return 0;
  }

  // 같은 파일을 다른 비서의 문서가 함께 쓰고 있으면 도우미가 남겨 둔다
  const paths = [...new Set(rows.map((d) => d.storage_path).filter((p): p is string => Boolean(p)))];
  for (const path of paths) {
    try {
      await removeStorageFileIfUnused(path);
    } catch (err) {
      console.error('[agent-store] 지운 비서의 문서 파일 정리 실패', agentId, path, err);
    }
  }
  return rows.length;
}

export async function enableAgentCapability(
  agentId: string,
  capability: 'doc_search',
  actorId: string | null
): Promise<void> {
  const { error } = await supabaseAdmin.rpc('enable_agent_capability', {
    p_agent_id: agentId,
    p_capability: capability,
    p_actor: actorId,
  });
  if (error) console.error('[agent-store] 능력 켜기 실패', agentId, capability, error.message);
}

export interface AgentHistoryRow {
  id: string;
  kind: string;
  version: number | null;
  snapshot: Record<string, unknown> | null;
  changed_by: string | null;
  changed_by_name: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

export async function getAgentHistory(agentId: string, limit = 100): Promise<AgentHistoryRow[]> {
  const { data, error } = await supabaseAdmin
    .from('agent_history')
    .select('id, kind, version, snapshot, changed_by, detail, created_at, changer:users!changed_by(full_name, email)')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('[agent-store] 기록 조회 실패', agentId, error.message);
    return [];
  }
  return (data ?? []).map(
    (row: {
      id: string; kind: string; version: number | null; snapshot: Record<string, unknown> | null;
      changed_by: string | null; detail: Record<string, unknown>; created_at: string;
      changer: { full_name: string | null; email: string | null } | null;
    }) => ({
      id: row.id,
      kind: row.kind,
      version: row.version,
      snapshot: row.snapshot,
      changed_by: row.changed_by,
      changed_by_name: row.changer?.full_name ?? row.changer?.email ?? null,
      detail: row.detail ?? {},
      created_at: row.created_at,
    })
  );
}

export async function getVersionSnapshot(agentId: string, version: number): Promise<Record<string, unknown> | null> {
  const { data } = await supabaseAdmin
    .from('agent_history')
    .select('snapshot')
    .eq('agent_id', agentId)
    .eq('version', version)
    .maybeSingle();
  return (data?.snapshot as Record<string, unknown> | undefined) ?? null;
}
