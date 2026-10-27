// src/lib/work/server.ts
import { NextResponse } from 'next/server';
import type { Session } from 'next-auth';
import { getActorScope } from '@/lib/actor-scope';
import { resolveModelForDepartment } from '@/lib/model-policy';
import { checkTokenLimit, limitMessage } from '@/lib/usage-limit';
import { logSystem } from '@/lib/logger';
import { WORK_GENERATOR } from '@/lib/config';
import { createSupabaseWorkStore } from './store/supabase';
import { createSupabaseWorkFiles } from './files';
import { llmGenerator, mockGenerator } from './generation/compose';
import { getRenderer } from './documents/renderer';
import { defaultRegulationProviders } from './workflows/regulations/providers';
import { llmRegulationModel, mockRegulationModel } from './workflows/regulations/model';
import { llmItemsModel, mockItemsModel } from './workflows/items/model';
import type { WorkContext } from './context';
import { WorkError, type WorkActor } from './types';

/**
 * 업무 라우트·작업자 엔드포인트가 쓰는 운영 의존성과 공통 처리.
 * 응답 규약은 기존 그대로: { ok: true, data } / { ok: false, error: { code, message, details } }.
 */
export function defaultWorkContext(): WorkContext {
  return {
    store: createSupabaseWorkStore(),
    files: createSupabaseWorkFiles(),
    generator: WORK_GENERATOR === 'mock' ? mockGenerator : llmGenerator,
    generatorMode: WORK_GENERATOR,
    renderer: getRenderer(),
    regulations: { providers: defaultRegulationProviders, model: WORK_GENERATOR === 'mock' ? mockRegulationModel : llmRegulationModel },
    items: { model: WORK_GENERATOR === 'mock' ? mockItemsModel : llmItemsModel },
    resolveModel: (departmentId) => resolveModelForDepartment(departmentId),
    async checkLimit(departmentId, userId) {
      const s = await checkTokenLimit(departmentId, userId);
      return s.allowed ? { allowed: true } : { allowed: false, message: limitMessage(s) };
    },
    log: (p) => logSystem({ ...p, category: p.category === 'work' ? 'api' : (p.category as 'api') }),
    now: () => new Date(),
  };
}

/**
 * 세션 → 업무 요청자. 소속을 모르거나(추측해서 배정하지 않는다) 비활성 사용자면 null.
 * 대리 접근 세션은 업무 작업을 쓰지 못한다 — 남의 작업 원문을 운영자가 열지 않는다(개편 03 문서 '관리자 확장').
 */
export async function getWorkActor(session: Session | null, ctx: WorkContext): Promise<WorkActor | null> {
  if (!session?.user?.id) return null;
  if ((session.user as { isImpersonating?: boolean }).isImpersonating) return null;
  const scope = await getActorScope(session);
  if (!scope?.organizationId) return null;
  if (!(await ctx.store.isUserActive(scope.userId))) return null;
  return {
    userId: scope.userId,
    organizationId: scope.organizationId,
    departmentId: scope.departmentId,
    isAdmin: scope.isAdmin,
    managedDepartmentIds: scope.managedDepartmentIds,
  };
}

export function ok<T>(data: T, status = 200) {
  return NextResponse.json({ ok: true, data }, { status });
}

export function fail(code: string, message: string, status: number, details?: unknown) {
  return NextResponse.json({ ok: false, error: { code, message, ...(details !== undefined ? { details } : {}) } }, { status });
}

/** 업무 오류는 그 상태·문구로, 그 밖의 예외는 원문 없이 500 */
export async function handleWork(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof WorkError) return fail(e.code, e.message, e.status, e.details);
    console.error('[work] 처리 실패', e instanceof Error ? e.message : e);
    return fail('INTERNAL', '서버 오류가 발생했습니다. 잠시 뒤 다시 시도해 주세요.', 500);
  }
}

export const UNAUTHORIZED = () => fail('UNAUTHORIZED', '인증이 필요합니다.', 401);
export const NO_ACTOR = () => fail('FORBIDDEN', '소속을 확인할 수 없어 업무 작업을 쓸 수 없습니다.', 403);

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new WorkError('INVALID_INPUT', '요청 본문이 올바르지 않습니다.');
  }
}
