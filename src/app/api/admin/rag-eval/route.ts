import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getActorScope } from '@/lib/actor-scope';
import type { ActorScope } from '@/lib/agent-permissions';
import { loadAgentAccess } from '@/lib/agent-store';
import { searchLikeChat } from '@/lib/capabilities/doc-search';
import { NodaError } from '@/lib/noda';
import { logSystem } from '@/lib/logger';
import { parseRagEvalSet, scoreRagEvalRow, summarizeRagEval, type RagEvalResult } from '@/lib/rag-eval';

// 질문 50개 × NODA /context(한 번 8초·재시도 창 10초)를 3개씩 — 플랫폼이 먼저 끊지 않게
export const maxDuration = 300;

/**
 * 배치 문서 찾기 평가(0054) — 기관 관리자만.
 *
 * - POST `{ agentId, set }`: 세트를 읽어 질문마다 **대화와 같은 찾기**(`searchLikeChat` — 비서 보관함 + 기관 유형의 공통 자료실, 2026-11-05)로 찾고, 판정·요약을 저장해 돌려준다.
 *   검색만 — AI 답변을 만들지 않는다. 한 질문의 NODA 실패는 그 질문만 '찾기 실패'로 두고, 모두 실패면 저장하지 않고 503.
 * - GET `?agentId=`: 그 비서의 지난 실행 20개(요약만). `?id=`: 실행 하나(결과 포함).
 * - 비서는 요청자 기관이고, 공식 비서이거나 요청자가 관리하는 부서의 비서여야 한다(아니면 없는 것처럼 404).
 */

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONCURRENCY = 3;
const BUDGET_MS = 240_000;

async function evaluableAgent(agentId: unknown, actor: ActorScope) {
  if (typeof agentId !== 'string' || !UUID.test(agentId)) return null;
  const agent = await loadAgentAccess(agentId);
  if (!agent || agent.deleted_at || agent.organization_id !== actor.organizationId) return null;
  if (agent.tier !== 'official' && !actor.managedDepartmentIds.includes(agent.department_id)) return null;
  return agent;
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
    const actor = await getActorScope(session!);
    if (!actor?.organizationId) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const body = (await request.json().catch(() => ({}))) as { agentId?: unknown; set?: unknown };
    const agent = await evaluableAgent(body.agentId, actor);
    if (!agent) return jsonError('비서를 찾을 수 없습니다.', 404);
    const parsed = parseRagEvalSet(typeof body.set === 'string' ? body.set : '');
    if (!parsed.ok) return NextResponse.json({ ok: false, error: { message: parsed.errors[0], details: { errors: parsed.errors } } }, { status: 400 });

    const orgId = actor.organizationId;
    const started = Date.now();
    const results: RagEvalResult[] = new Array(parsed.rows.length);
    let next = 0;
    let nodaFailures = 0;
    const worker = async () => {
      while (next < parsed.rows.length) {
        const index = next++;
        const row = parsed.rows[index];
        if (Date.now() - started > BUDGET_MS) { results[index] = scoreRagEvalRow(row, null); continue; }
        try {
          // 비서는 요청자 기관의 것이다(evaluableAgent) — 기관 유형으로 공통 자료실도 대화처럼 찾는다
          const chunks = await searchLikeChat({ agentId: agent.id, organizationId: orgId, query: row.question });
          if (chunks === null) nodaFailures += 1; // 대화라면 503으로 거절할 때(NODA를 못 부름)
          results[index] = scoreRagEvalRow(row, chunks);
        } catch (error) {
          if (error instanceof NodaError) nodaFailures += 1;
          else console.error('[rag-eval] 찾기 오류', error);
          results[index] = scoreRagEvalRow(row, null);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, parsed.rows.length) }, worker));

    const summary = summarizeRagEval(results, 'chat');
    if (summary.errors === results.length) {
      await logSystem({ level: 'warning', category: 'api', message: '문서 찾기 평가 — 모든 질문의 찾기가 실패했습니다', details: { agent_id: agent.id, questions: results.length, noda_failures: nodaFailures }, orgId: actor.organizationId });
      return jsonError('참고 문서를 지금 불러오지 못했습니다 — 잠시 뒤 다시 평가해 주세요.', 503);
    }
    const { data: run, error } = await supabaseAdmin
      .from('rag_eval_runs')
      .insert({
        organization_id: actor.organizationId, agent_id: agent.id, agent_version: agent.version, created_by: actor.userId,
        question_count: results.length, status: summary.errors ? 'partial' : 'done', summary, results,
      })
      .select('id, agent_id, agent_version, created_at, question_count, status, summary, results')
      .single();
    if (error) return jsonError('평가 결과를 저장하지 못했습니다.', 500);
    return NextResponse.json({ ok: true, data: run });
  } catch (error) {
    console.error('[rag-eval POST]', error);
    return jsonError('평가 중 오류가 발생했습니다.', 500);
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
    const actor = await getActorScope(session!);
    if (!actor?.organizationId) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const id = request.nextUrl.searchParams.get('id');
    if (id) {
      if (!UUID.test(id)) return jsonError('평가 기록을 찾을 수 없습니다.', 404);
      const { data: run } = await supabaseAdmin
        .from('rag_eval_runs')
        .select('id, agent_id, agent_version, created_at, question_count, status, summary, results')
        .eq('id', id)
        .eq('organization_id', actor.organizationId)
        .maybeSingle();
      // 기록의 비서도 지금 볼 수 있어야 한다(관리 범위가 바뀌었으면 보이지 않는다)
      if (!run || !(await evaluableAgent(run.agent_id, actor))) return jsonError('평가 기록을 찾을 수 없습니다.', 404);
      return NextResponse.json({ ok: true, data: run });
    }

    const agent = await evaluableAgent(request.nextUrl.searchParams.get('agentId'), actor);
    if (!agent) return jsonError('비서를 찾을 수 없습니다.', 404);
    const { data, error } = await supabaseAdmin
      .from('rag_eval_runs')
      .select('id, agent_id, agent_version, created_at, question_count, status, summary')
      .eq('organization_id', actor.organizationId)
      .eq('agent_id', agent.id)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) return jsonError('평가 기록을 불러오지 못했습니다.', 500);
    return NextResponse.json({ ok: true, data: data ?? [] });
  } catch (error) {
    console.error('[rag-eval GET]', error);
    return jsonError('평가 기록을 불러오지 못했습니다.', 500);
  }
}
