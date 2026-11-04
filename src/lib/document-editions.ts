// src/lib/document-editions.ts
// 비서 문서의 판(개정본) 관리(0055) — 공통 자료실(common-documents.ts)과 같은 규칙.
//
// - 새 문서를 올릴 때 같은 비서의 현재 판 하나를 '바꿀 옛 판'으로 고른다(`checkReplaceTarget`).
// - **새 판이 `ready`가 된 순간** 옛 판의 NODA 사본을 지우고 `retired`·`retired_at`으로 둔다(`retireReplacedDocument`) —
//   읽기 상태 기계의 `afterReady` 갈고리(읽기 라우트·목록 맞추기·웹훅 세 곳)가 부른다. 새 판이 읽기에 실패하면 옛 판이 계속 근거다.
// - 옛 판의 행·원본은 감사용으로 남는다. NODA를 못 지우면 옛 판을 `deleting`으로 두고(문서 화면에서 지울 수 있음) 경고를 남긴다.
// - 갈고리가 던져 판 바꾸기가 남았으면 문서 목록이 열릴 때 다시 건다(`pendingRetirements`). 그 사이에도 문서 찾기는
//   `ready` 새 판이 대신하는 옛 판을 근거로 치지 않는다(doc-search.ts `sourcesToChunks`).
// - 운영 기록에는 파일 이름을 남기지 않는다(문서 id만).

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSystem } from '@/lib/logger';
import { noda, nodaErrorFields, nodaTenant, type NodaClient } from '@/lib/noda';

export interface EditionRow {
  id: string;
  agent_id: string | null;
  noda_status: string | null;
  noda_filename: string | null;
  replaces_id: string | null;
  retired_at: string | null;
}

export interface EditionStore {
  getRow(id: string): Promise<EditionRow | null>;
  /** 현재 판(`retired_at` NULL)이고 `deleting`이 아닐 때만 `retired`로. 바뀌었으면 true */
  retire(id: string, nowIso: string): Promise<boolean>;
  markDeleting(id: string): Promise<boolean>;
}

export interface EditionDeps {
  store: EditionStore;
  noda: Pick<NodaClient, 'deleteDocument'>;
  now: () => number;
  log: (p: Parameters<typeof logSystem>[0]) => Promise<void>;
}

const COLUMNS = 'id, agent_id, noda_status, noda_filename, replaces_id, retired_at';

function defaultStore(): EditionStore {
  return {
    async getRow(id) {
      const { data, error } = await supabaseAdmin.from('documents').select(COLUMNS).eq('id', id).maybeSingle();
      if (error) throw new Error(`문서 조회 실패: ${error.message}`);
      return (data as EditionRow | null) ?? null;
    },
    async retire(id, nowIso) {
      const { data, error } = await supabaseAdmin
        .from('documents')
        .update({ noda_status: 'retired', retired_at: nowIso, updated_at: nowIso })
        .eq('id', id)
        .is('retired_at', null)
        .neq('noda_status', 'deleting')
        .select('id');
      if (error) throw new Error(`문서 지난 판 표시 실패: ${error.message}`);
      return (data?.length ?? 0) > 0;
    },
    async markDeleting(id) {
      const { error } = await supabaseAdmin.from('documents').update({ noda_status: 'deleting' }).eq('id', id).is('retired_at', null);
      return !error;
    },
  };
}

export function defaultEditionDeps(): EditionDeps {
  return { store: defaultStore(), noda, now: () => Date.now(), log: logSystem };
}

/**
 * 새 판(`newId`)이 `ready`가 된 뒤 옛 판을 내린다. 새 판 행을 **다시 읽어** `ready`이고 `replaces_id`가 있을 때만 움직이고,
 * 옛 판이 **같은 비서**의 현재 판(`retired_at` NULL, `retired`·`deleting` 아님)일 때만 건드린다. 여러 번 불러도 안전하다
 */
export async function retireReplacedDocument(newId: string, deps: EditionDeps = defaultEditionDeps()): Promise<'retired' | 'none' | 'kept_deleting'> {
  const fresh = await deps.store.getRow(newId);
  if (!fresh || fresh.noda_status !== 'ready' || !fresh.replaces_id || !fresh.agent_id) return 'none';
  const old = await deps.store.getRow(fresh.replaces_id);
  if (!old || old.agent_id !== fresh.agent_id) return 'none';
  if (old.retired_at || old.noda_status === 'retired' || old.noda_status === 'deleting') return 'none';

  // NODA에 간 적 없는 옛 행(NULL)·파일 이름 없는 행은 사본이 없다
  if (old.noda_status && old.noda_filename) {
    try {
      await deps.noda.deleteDocument(nodaTenant(old.agent_id), old.noda_filename);
    } catch (err) {
      await deps.store.markDeleting(old.id);
      await deps.log({
        level: 'warning',
        category: 'api',
        message: '문서 옛 판의 NODA 사본을 지우지 못함 — 문서 화면에서 지워 주세요',
        details: { document_id: old.id, replaced_by: newId, ...nodaErrorFields(err) },
      });
      return 'kept_deleting';
    }
  }
  if (!(await deps.store.retire(old.id, new Date(deps.now()).toISOString()))) return 'none';
  await deps.log({ level: 'info', category: 'api', message: '문서 지난 판으로 바꿈', details: { document_id: old.id, replaced_by: newId } });
  return 'retired';
}

/** 목록 행 중 판 바꾸기가 남은 새 판 id — `ready` 새 판이 가리키는 옛 판이 목록에서 아직 현재 판(`deleting` 아님)인 것 */
export function pendingRetirements(rows: Array<Pick<EditionRow, 'id' | 'agent_id' | 'noda_status' | 'replaces_id' | 'retired_at'>>): string[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return rows
    .filter((r) => r.noda_status === 'ready' && r.replaces_id)
    .filter((r) => {
      const old = byId.get(r.replaces_id as string);
      return Boolean(old && old.agent_id === r.agent_id && !old.retired_at && old.noda_status !== 'retired' && old.noda_status !== 'deleting');
    })
    .map((r) => r.id);
}

/** 시행일 칸 — 비우면 null, 'YYYY-MM-DD'(실제 날짜, 2000~2100년)만. 그 밖은 undefined(거절) */
export function parseEffectiveFrom(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const t = Date.parse(`${raw}T00:00:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== raw) return undefined;
  const year = Number(raw.slice(0, 4));
  return year >= 2000 && year <= 2100 ? raw : undefined;
}

/**
 * '바꿀 옛 판' 검사(확인 라우트) — 비서 하나에 올릴 때만, 같은 비서의 현재 판(지난 판·지우는 중 아님)이고,
 * 이미 다른 새 판(읽는 중·읽음)이 그 판을 바꾸려 하지 않을 때만. 맞으면 null, 아니면 직원에게 보일 글
 */
export function replaceTargetError(input: {
  agentIds: string[];
  target: Pick<EditionRow, 'id' | 'agent_id' | 'noda_status' | 'retired_at'> | null;
  competing: number;
}): string | null {
  if (input.agentIds.length !== 1) return '바꿀 옛 판은 비서 하나에 올릴 때만 고를 수 있습니다.';
  const t = input.target;
  if (!t || t.agent_id !== input.agentIds[0]) return '바꿀 옛 판을 찾을 수 없습니다. 문서 목록을 새로 고쳐 주세요.';
  if (t.retired_at || t.noda_status === 'retired') return '이미 지난 판인 문서입니다.';
  if (t.noda_status === 'deleting') return '지우는 중인 문서는 바꿀 옛 판으로 고를 수 없습니다.';
  if (input.competing > 0) return '이 문서를 바꾸는 새 판이 이미 올라가 있습니다. 그 판이 읽힌 뒤 다시 확인해 주세요.';
  return null;
}
