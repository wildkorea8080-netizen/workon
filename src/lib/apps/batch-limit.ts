// src/lib/apps/batch-limit.ts
// 기관의 일괄 실행 한 번 최대 줄 수(2026-11-10, 0084) — 기관 전체 관리자만 정하고(1~100, 비우면 기본 100), 일괄 실행을 만들 때 서버가 본다.
// 줄마다 AI 사용량이 들어 비용 통제용으로 낮춘다. 이미 만든 일괄 실행은 그대로 돈다. 바꾸면 보안 로그(high — 값·사유).
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSecurityEvent } from '@/lib/filter';
import type { ActorScope } from '@/lib/agent-permissions';
import { BATCH_MAX_ROWS } from './batch-spec';

export type BatchLimitView = { maxRows: number | null; effective: number; canChange: boolean };
type Fail = { ok: false; status: number; message: string };

/** 기관이 정한 상한(없으면 null). 읽지 못하면 던진다 — 만들기는 닫힌다 */
export async function readBatchLimit(organizationId: string): Promise<number | null> {
  const { data, error } = await supabaseAdmin.from('organizations').select('app_batch_max_rows').eq('id', organizationId).maybeSingle();
  if (error) throw new Error(error.message);
  const v = (data as { app_batch_max_rows?: unknown } | null)?.app_batch_max_rows;
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= BATCH_MAX_ROWS ? v : null;
}

export const batchLimitView = (maxRows: number | null, actor: ActorScope): BatchLimitView => ({
  maxRows, effective: maxRows ?? BATCH_MAX_ROWS, canChange: Boolean(actor.isAdmin && actor.managesWholeOrganization),
});

/** 요청 값 — null(기본으로) 또는 1~100 정수. 그 밖은 null이 아니라 실패 */
export function parseBatchLimit(raw: unknown): { ok: true; value: number | null } | { ok: false; message: string } {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= BATCH_MAX_ROWS) return { ok: true, value: raw };
  return { ok: false, message: `한 번에 실행할 최대 줄 수는 1~${BATCH_MAX_ROWS} 사이 정수로 정해 주세요(비우면 기본 ${BATCH_MAX_ROWS}줄).` };
}

export async function setBatchLimit(
  admin: { scope: ActorScope; userId: string; impersonating: boolean }, value: number | null, reason: string,
): Promise<{ ok: true; data: BatchLimitView } | Fail> {
  const actor = admin.scope;
  if (!actor.organizationId) return { ok: false, status: 403, message: '기관 소속을 확인할 수 없습니다.' };
  if (!actor.isAdmin || !actor.managesWholeOrganization) return { ok: false, status: 403, message: '일괄 실행 상한은 기관 전체를 관리하는 관리자(최상위 부서 소속)만 정할 수 있습니다.' };
  let before: number | null;
  try { before = await readBatchLimit(actor.organizationId); } catch { return { ok: false, status: 503, message: '일괄 실행 상한을 읽지 못했습니다.' }; }
  if (before !== value) {
    const { error } = await supabaseAdmin.from('organizations').update({ app_batch_max_rows: value }).eq('id', actor.organizationId);
    if (error) return { ok: false, status: 503, message: '일괄 실행 상한을 바꾸지 못했습니다.' };
    await logSecurityEvent(actor.departmentId, admin.userId, 'app_batch_limit_changed',
      { organization_id: actor.organizationId, before, after: value, reason, impersonating: admin.impersonating }, 'high');
  }
  return { ok: true, data: batchLimitView(value, actor) };
}
