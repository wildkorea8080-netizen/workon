import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getActorScope } from '@/lib/actor-scope';
import type { ActorScope } from '@/lib/agent-permissions';
import { loadAgentAccess } from '@/lib/agent-store';
import { prepareLikeChat } from '@/lib/capabilities/doc-search';
import { logSystem } from '@/lib/logger';
import { parseRagEvalSet, summarizeRagEval } from '@/lib/rag-eval';
import { RAG_EVAL_ANSWER_MAX_QUESTIONS, summarizeAnswers } from '@/lib/rag-eval-answer';
import { applyHumanLabel, isJudgeGrade } from '@/lib/rag-eval-judge';
import type { RagEvalResult } from '@/lib/rag-eval';
import { runRagEval } from '@/lib/rag-eval-run';
import { complete } from '@/lib/llm';
import { getAllowedModelIds, resolveModel } from '@/lib/model-policy';
import { checkTokenLimit, limitMessage } from '@/lib/usage-limit';
import { buildUsageDetails, writeUsageLog } from '@/lib/assistant/persist';

// 질문 50개 × NODA /context(한 번 8초·재시도 창 10초)를 3개씩 — 플랫폼이 먼저 끊지 않게. 답변까지 평가하면 질문 20개 × 답 한 번
export const maxDuration = 300;

/**
 * 배치 문서 찾기 평가(0054) — 기관 관리자만.
 *
 * - POST `{ agentId, set, answers? }`: 세트를 읽어 질문마다 **대화와 같은 찾기**(`prepareLikeChat` — 비서 보관함 + 기관 유형의 공통 자료실, 2026-11-05)로 찾고, 판정·요약을 저장해 돌려준다.
 *   기본은 검색만 — AI 답변을 만들지 않는다. `answers: true`(2026-11-08)면 질문마다 대화와 같은 시스템 프롬프트(비서 지시문 + 참고 자료·인용 규칙)·
 *   비서 모델(기관 정책)로 답을 한 번 만들어 프로그램이 판정한다(인용·숫자·기대 답 핵심어 — `rag-eval-answer.ts`). 질문 20개까지, 한도를 먼저 보고,
 *   답마다 사용 기록(`rag_eval_answer` — 모델·토큰·원가, 요청한 관리자 부서)을 남긴다. 도구(공공 데이터 등)·첨부·앱 단계는 쓰지 않는다.
 *   `judge: true`(2026-11-09, `answers`와 함께만)면 기대 문서가 있는 질문의 답마다 같은 모델로 AI 채점을 한 번 더(`rag-eval-judge.ts` — 참고,
 *   프로그램 판정은 그대로), 사용 기록 `rag_eval_judge`.
 *   한 질문의 NODA 실패는 그 질문만 '찾기 실패'로 두고, 모두 실패면 저장하지 않고 503.
 * - GET `?agentId=`: 그 비서의 지난 실행 20개(요약만). `?id=`: 실행 하나(결과 포함).
 * - PATCH `{ id, line, grade }`(2026-11-09): 실행 하나의 답 한 줄에 **사람 판정**(correct·partial·incorrect, null이면 지움)을 남기고
 *   요약의 맞대기(`summary.answers.agreement` — AI 채점 일치율·후하게/짜게 본 수)를 다시 센다. 답을 만든 질문만. 모델을 부르지 않는다.
 *   두 관리자가 동시에 매겨도 서로 지우지 않게 `summary.labelRevision`으로 조건부 저장(어긋나면 다시 읽어 최대 3번).
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

    const body = (await request.json().catch(() => ({}))) as { agentId?: unknown; set?: unknown; answers?: unknown; judge?: unknown };
    const agent = await evaluableAgent(body.agentId, actor);
    if (!agent) return jsonError('비서를 찾을 수 없습니다.', 404);
    const parsed = parseRagEvalSet(typeof body.set === 'string' ? body.set : '');
    if (!parsed.ok) return NextResponse.json({ ok: false, error: { message: parsed.errors[0], details: { errors: parsed.errors } } }, { status: 400 });
    const withAnswers = body.answers === true;
    if (body.judge === true && !withAnswers) return jsonError('AI 채점은 답변까지 평가할 때만 고를 수 있습니다.', 400);
    if (withAnswers && parsed.rows.length > RAG_EVAL_ANSWER_MAX_QUESTIONS) {
      return jsonError(`답변까지 평가할 때는 한 번에 ${RAG_EVAL_ANSWER_MAX_QUESTIONS}개까지 평가합니다(지금 ${parsed.rows.length}개).`, 400);
    }

    const orgId = actor.organizationId;
    let answers: { systemPrompt: string | null; model: string; judge?: boolean } | undefined;
    if (withAnswers) {
      // 모델을 부르므로 대화처럼 한도를 먼저 본다(요청한 관리자 기준)
      const limit = await checkTokenLimit(actor.departmentId, actor.userId);
      if (!limit.allowed) return jsonError(limitMessage(limit), 429);
      const { data: settings, error: settingsError } = await supabaseAdmin.from('agents').select('system_prompt, model_id').eq('id', agent.id).maybeSingle();
      if (settingsError || !settings) return jsonError('비서 설정을 불러오지 못했습니다.', 500);
      const { modelId } = resolveModel(settings.model_id as string | null, await getAllowedModelIds(orgId));
      // AI 채점도 답과 같은 모델 — 기관 허용 목록을 그대로 따른다
      answers = { systemPrompt: (settings.system_prompt as string | null) ?? null, model: modelId, ...(body.judge === true ? { judge: true } : {}) };
    }

    const { results, nodaFailures } = await runRagEval({ rows: parsed.rows, answers, concurrency: CONCURRENCY, budgetMs: BUDGET_MS }, {
      // 비서는 요청자 기관의 것이다(evaluableAgent) — 기관 유형으로 공통 자료실도 대화처럼 찾는다
      prepare: (query) => prepareLikeChat({ agentId: agent.id, organizationId: orgId, query }),
      complete,
      logUsage: (usage) => writeUsageLog({
        departmentId: actor.departmentId, userId: actor.userId, action: 'rag_eval_answer', resourceType: 'agent', resourceId: agent.id,
        details: buildUsageDetails(usage, { agent_id: agent.id }),
      }),
      logJudgeUsage: (usage) => writeUsageLog({
        departmentId: actor.departmentId, userId: actor.userId, action: 'rag_eval_judge', resourceType: 'agent', resourceId: agent.id,
        details: buildUsageDetails(usage, { agent_id: agent.id }),
      }),
      logFailure: (message, details) => logSystem({ level: 'warning', category: 'api', message, details: { agent_id: agent.id, ...details }, orgId }),
      now: () => Date.now(),
    });

    const summary = { ...summarizeRagEval(results, 'chat'), ...(withAnswers ? { answers: summarizeAnswers(results) } : {}) };
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

export async function PATCH(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
    const actor = await getActorScope(session!);
    if (!actor?.organizationId) return jsonError('소속 부서가 지정되지 않았습니다.', 403);
    const body = await request.json().catch(() => null) as { id?: unknown; line?: unknown; grade?: unknown } | null;
    if (!body || typeof body.id !== 'string' || !UUID.test(body.id) || typeof body.line !== 'number' || !Number.isInteger(body.line) || body.line < 1) return jsonError('고칠 평가 기록과 줄을 골라 주세요.', 400);
    if (body.grade !== null && !isJudgeGrade(body.grade)) return jsonError('사람 판정은 맞음·일부 맞음·틀림 중 하나여야 합니다.', 400);
    const grade = body.grade === null ? null : body.grade as Parameters<typeof applyHumanLabel>[2];

    for (let attempt = 0; attempt < 3; attempt++) {
      const { data: run } = await supabaseAdmin
        .from('rag_eval_runs')
        .select('id, agent_id, summary, results')
        .eq('id', body.id)
        .eq('organization_id', actor.organizationId)
        .maybeSingle();
      // 기록의 비서도 지금 볼 수 있어야 한다(GET과 같은 판단)
      if (!run || !(await evaluableAgent(run.agent_id, actor))) return jsonError('평가 기록을 찾을 수 없습니다.', 404);
      const results = (Array.isArray(run.results) ? run.results : []) as RagEvalResult[];
      const applied = applyHumanLabel(results, body.line, grade, new Date().toISOString());
      if (!applied.ok) return jsonError(applied.message, 400);
      const summary = (run.summary ?? {}) as Record<string, unknown>;
      const revision = typeof summary.labelRevision === 'number' ? summary.labelRevision : 0;
      const nextSummary = { ...summary, answers: summarizeAnswers(applied.results), labelRevision: revision + 1 };
      let update = supabaseAdmin.from('rag_eval_runs').update({ summary: nextSummary, results: applied.results }).eq('id', run.id).eq('organization_id', actor.organizationId);
      update = revision ? update.eq('summary->>labelRevision', String(revision)) : update.is('summary->labelRevision', null);
      const { data: saved, error } = await update.select('id, agent_id, agent_version, created_at, question_count, status, summary, results');
      if (error) return jsonError('사람 판정을 저장하지 못했습니다.', 500);
      if (saved && saved.length) return NextResponse.json({ ok: true, data: saved[0] });
      // 그 사이 다른 관리자가 매겼다 — 다시 읽어 그 판정 위에 얹는다
    }
    return jsonError('다른 관리자가 같은 기록을 고치는 중입니다. 잠시 뒤 다시 해 주세요.', 409);
  } catch (error) {
    console.error('[rag-eval PATCH]', error);
    return jsonError('사람 판정을 저장하지 못했습니다.', 500);
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
