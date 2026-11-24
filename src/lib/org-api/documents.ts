// src/lib/org-api/documents.ts
// 기관 통계 API의 문서함 목록(0099, 2026-11-23) — `GET /api/v1/documents`(범위 documents).
//
// 기관의 문서관리시스템(EDMS)이 WORKON 문서함과 맞대 볼 수 있게: 어떤 문서가 읽혔는지·읽지 못했는지(까닭)·지난 판인지·
// 새 판이 대신하는지·지금 대화에서 근거로 쓰는지(대화와 같은 판 규칙 `notCitableEditionIds`)·태그.
// **본문·요약·원본·저장소 경로·NODA 파일 이름·올린 사람은 싣지 않는다.** 나만의 비서의 문서(직원의 개인 자료)와
// 지운 비서의 문서(치우는 중)는 내지 않는다. 범위는 키를 만든 기관 전체 관리자의 관리 범위(= 기관 전체) 부서의 문서.
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { decodeHistoryCursor, encodeHistoryCursor } from '@/lib/apps/history';
import { kstToday, notCitableEditionIds } from '@/lib/edition-dates';
import { docStatusOf, parseDocListQuery, type OrgApiDocument } from './spec';
import type { OrgApiContext } from './keys';

type Out = { data: unknown } | { status: number; message: string };

type AgentEmbed = { id: string; name: string; tier: string | null; deleted_at: string | null };
export type OrgApiDocRow = {
  id: string; file_name: string; title: string | null; file_type: string | null; agent_id: string | null; department_id: string | null;
  noda_status: string | null; noda_reason: string | null; noda_read_at: string | null; replaces_id: string | null; retired_at: string | null;
  effective_from: string | null; tags: string[] | null; created_at: string;
  agent?: AgentEmbed | AgentEmbed[] | null;
};
type Successor = { id: string; noda_status: string | null; replaces_id: string | null; effective_from: string | null };

const DOC_COLUMNS = 'id, file_name, title, file_type, agent_id, department_id, noda_status, noda_reason, noda_read_at, replaces_id, retired_at, effective_from, tags, created_at, agent:agents(id, name, tier, deleted_at)';

const agentOf = (row: OrgApiDocRow): AgentEmbed | null => (Array.isArray(row.agent) ? row.agent[0] ?? null : row.agent ?? null);

/** 밖으로 내지 않는 문서 — 나만의 비서(직원의 개인 자료)·지운 비서(치우는 중) */
export function hiddenFromOrgApi(row: OrgApiDocRow): boolean {
  if (!row.agent_id) return false;
  const agent = agentOf(row);
  // 비서를 못 붙였으면(지워진 행) 내지 않는다 — 누구의 문서인지 모른 채 내보내지 않게
  return !agent || agent.tier === 'personal' || Boolean(agent.deleted_at);
}

/** 행 → 밖으로 내는 한 줄(순수 — 시험이 직접 부른다) */
export function toOrgApiDocument(row: OrgApiDocRow, ctx: { departmentNames: Map<string, string>; notCitable: Set<string>; successorOf: Map<string, string> }): OrgApiDocument {
  const agent = agentOf(row);
  const status = docStatusOf(row.noda_status);
  const id = row.id.toLowerCase();
  return {
    id: row.id,
    title: row.title?.trim() || row.file_name,
    fileName: row.file_name,
    fileType: row.file_type ?? null,
    agent: agent && row.agent_id ? { id: row.agent_id, name: agent.name } : null,
    departmentId: row.department_id,
    departmentName: row.department_id ? ctx.departmentNames.get(row.department_id) ?? null : null,
    status,
    reason: status === 'failed' || status === 'unreadable' ? row.noda_reason?.trim() || null : null,
    citable: status === 'ready' && !ctx.notCitable.has(id),
    tags: Array.isArray(row.tags) ? row.tags : [],
    edition: {
      replacesId: row.replaces_id ?? null,
      replacedById: ctx.successorOf.get(id) ?? null,
      effectiveFrom: row.effective_from ? row.effective_from.slice(0, 10) : null,
      retiredAt: row.retired_at ?? null,
    },
    createdAt: row.created_at,
    readAt: row.noda_read_at ?? null,
  };
}

/** 새 판 → 옛 판 id 사전(지우는 중인 새 판은 빼고, 읽힌 새 판을 먼저) */
export function successorMap(successors: Successor[]): Map<string, string> {
  const out = new Map<string, string>();
  const ordered = [...successors].filter((s) => s.noda_status !== 'deleting' && s.replaces_id)
    .sort((a, b) => Number(b.noda_status === 'ready') - Number(a.noda_status === 'ready'));
  for (const s of ordered) {
    const old = s.replaces_id!.toLowerCase();
    if (!out.has(old)) out.set(old, s.id);
  }
  return out;
}

export async function documentsReport(
  ctx: OrgApiContext,
  params: { status: string | null; agent: string | null; cursor: string | null; limit: string | null },
  nowMs = Date.now(),
): Promise<Out> {
  const parsed = parseDocListQuery(params);
  if (!parsed.ok) return { status: 400, message: parsed.message };
  const q = parsed.value;
  const cursor = q.cursor ? decodeHistoryCursor(q.cursor) : null;
  if (q.cursor && !cursor) return { status: 400, message: 'cursor가 올바르지 않습니다 — 앞 응답의 next를 그대로 넣어 주세요.' };

  // 오래된 것부터(만든 시각, id) — 새로 올린 문서는 끝에 붙어, 목록을 끝까지 따라가는 동안 쪽이 밀리지 않는다
  let query = supabaseAdmin.from('documents').select(DOC_COLUMNS)
    .eq('organization_id', ctx.organizationId)
    .in('department_id', ctx.departmentIds)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(q.limit + 1);
  if (q.status === 'legacy') query = query.is('noda_status', null);
  else if (q.status) query = query.eq('noda_status', q.status);
  if (q.agentId) query = query.eq('agent_id', q.agentId);
  if (cursor) query = query.or(`created_at.gt.${cursor.at},and(created_at.eq.${cursor.at},id.gt.${cursor.id})`);
  const { data, error } = await query;
  if (error) throw new Error(`documents: ${error.message}`);
  const scanned = ((data ?? []) as unknown as OrgApiDocRow[]);
  const page = scanned.slice(0, q.limit);
  const rows = page.filter((row) => !hiddenFromOrgApi(row));

  // 이 쪽 문서를 대신하는 새 판(근거로 쓰는지·replacedById) — 못 읽으면 판정을 꾸미지 않고 실패로
  const ids = rows.map((r) => r.id);
  let successors: Successor[] = [];
  if (ids.length) {
    const { data: next, error: nextError } = await supabaseAdmin.from('documents').select('id, noda_status, replaces_id, effective_from')
      .eq('organization_id', ctx.organizationId).in('replaces_id', ids);
    if (nextError) throw new Error(`documents(editions): ${nextError.message}`);
    successors = (next ?? []) as Successor[];
  }
  const deptIds = Array.from(new Set(rows.map((r) => r.department_id).filter((d): d is string => Boolean(d))));
  const departmentNames = new Map<string, string>();
  if (deptIds.length) {
    const { data: depts, error: deptError } = await supabaseAdmin.from('departments').select('id, name').in('id', deptIds);
    if (deptError) throw new Error(`departments: ${deptError.message}`);
    for (const d of (depts ?? []) as { id: string; name: string }[]) departmentNames.set(d.id, d.name);
  }
  const notCitable = notCitableEditionIds([...rows, ...successors], kstToday(nowMs));
  const successorOf = successorMap(successors);
  const documents = rows.map((row) => toOrgApiDocument(row, { departmentNames, notCitable, successorOf }));
  const last = page[page.length - 1];
  return {
    data: {
      documents,
      // 나만의 비서·지운 비서의 문서를 빼므로 한 쪽이 limit보다 적을 수 있다 — next가 있으면 끝까지 따라간다
      next: scanned.length > q.limit && last ? encodeHistoryCursor(last.created_at, last.id) : null,
    },
  };
}
