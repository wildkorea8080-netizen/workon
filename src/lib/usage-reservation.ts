// src/lib/usage-reservation.ts
// 입력형 앱 실행의 사용량 예약(2026-11-26, 0122). 앱 실행은 모델을 여러 번 부르는데, 예전엔 시작할 때 한도가 아직 남았는지만 보고
// 단계마다 다시 봐서 도중에 한도에 닿으면 멈췄다 — 그때까지 쓴 금액은 결과 없이 사라지고, 거의 동시에 시작한 실행·대화가 같은 여유를
// 함께 썼다. 이제 시작하기 전에 그 실행이 많으면 쓸 금액을 금액 한도(부서·개인 월 한도, 연간 정액 계약)에 예약하고, 남은 금액에서
// 다른 실행의 예약을 빼고도 모자라면 시작하지 않는다. 다른 대화·실행의 한도 판정(checkTokenLimit)은 살아 있는 예약을 쓴 것으로 센다.
// 실행이 끝나면 예약을 지우고, 끊긴 실행의 예약은 기한(10분)이 지나면 세지 않는다.
// 금액 한도가 없는 기관(종량제 토큰 한도만)은 예약하지 않는다 — 토큰 한도는 금액이 아니다.
// 예약을 못 하면(읽기·쓰기 실패) 예약 없이 실행한다 — 한도 확인과 같은 '열림' 규칙(과금 집계 오류로 서비스가 멈추지 않게), 운영 기록에 남긴다.
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSystem } from '@/lib/logger';
import { estimateCostKrw } from '@/lib/models';
import { APP_WEB_LOOKUP_MAX_USES } from '@/lib/apps/definition';
import { amountHeadroom, type HeadroomCheck } from '@/lib/usage-limit';

/** 예약 기한 — 앱 실행의 시간 예산(3분)·예약 실행기 마감보다 넉넉히. 끊긴 실행의 예약은 이때까지만 센다 */
export const RESERVATION_TTL_MS = 10 * 60 * 1000;
/** 한 번 예약의 상한(원) — DB CHECK와 같다 */
export const RESERVATION_MAX_KRW = 10_000_000;
/** 중간 단계 한 번의 출력 상한 — 실행기(pipeline.ts APP_INTERMEDIATE_TOKENS)와 같다(그 모듈을 부르지 않으려고 값을 둔다 — 시험이 맞댄다) */
export const RESERVATION_STEP_OUTPUT_TOKENS = 1400;
/** 마지막 단계의 출력 상한 — 대화 실행기(assistant/types.ts MAX_OUTPUT_TOKENS)와 같다 */
export const RESERVATION_FINAL_OUTPUT_TOKENS = 4096;

/**
 * 실행이 많으면 쓸 금액(원) — 넉넉히 잡는다. 글자 하나를 토큰 하나로(한글은 대개 이보다 적다), 단계마다 앞 단계 결과가 입력에 쌓이고
 * (출력 상한만큼), 중간 단계·분류는 중간 단계 출력 상한, 마지막 단계는 마지막 출력 상한으로 센다. 긴 첨부를 나눠 추리면 조각마다 한 번 더.
 * 조회 결과·되돌아가 다시 하는 단계의 늘어난 입력은 넣지 않는다 — 실제 사용은 실행이 끝난 뒤 사용 기록으로 센다
 */
export function estimateRunCostKrw(a: { modelId: string; calls: number; baseChars: number; digest?: { pieces: number; chars: number }; webSearches?: number }): number {
  const calls = Math.max(1, Math.floor(a.calls));
  const base = Math.max(0, Math.floor(a.baseChars));
  let input = 0; let output = 0;
  for (let i = 0; i < calls; i++) {
    input += base + i * RESERVATION_STEP_OUTPUT_TOKENS;
    output += i === calls - 1 ? RESERVATION_FINAL_OUTPUT_TOKENS : RESERVATION_STEP_OUTPUT_TOKENS;
  }
  if (a.digest && a.digest.pieces > 0) {
    input += Math.max(0, Math.floor(a.digest.chars)) + a.digest.pieces * Math.min(base, 20_000);
    output += a.digest.pieces * RESERVATION_STEP_OUTPUT_TOKENS;
  }
  // 웹 검색 조회(2026-11-26) — 호출마다 검색 요금(APP_WEB_LOOKUP_MAX_USES번)을 넉넉히. 토큰은 calls에 이미 들어 있다
  const searches = Math.max(0, Math.floor(a.webSearches ?? 0)) * APP_WEB_LOOKUP_MAX_USES;
  const krw = estimateCostKrw({ input_tokens: input, output_tokens: output, ...(searches ? { web_search_requests: searches } : {}) }, a.modelId);
  return Math.min(RESERVATION_MAX_KRW, Math.max(1, Math.ceil(krw)));
}

export type ReserveResult =
  | { ok: true; id: string | null }
  | { ok: false; scope: HeadroomCheck['scope']; amountKrw: number; leftKrw: number; reservedKrw: number };

export interface ReservationIo {
  headroom(departmentId: string, userId: string): Promise<{ organizationId: string | null; checks: HeadroomCheck[] }>;
  reserve(a: { organizationId: string; departmentId: string; userId: string; amountKrw: number; checks: HeadroomCheck[]; expiresAt: string }): Promise<
    { ok: true; id: string } | { ok: false; scope: HeadroomCheck['scope']; headroom: number; reserved: number }
  >;
  release(id: string): Promise<void>;
  report(stage: 'headroom' | 'reserve' | 'release', error: unknown, departmentId: string | null): Promise<void>;
  now(): number;
}

/** 시작 전 예약 — 금액 한도가 없으면 `id: null`(예약 없음), 모자라면 `ok: false` */
export async function reserveRunUsage(io: ReservationIo, a: { departmentId: string; userId: string; amountKrw: number }): Promise<ReserveResult> {
  let headroom: Awaited<ReturnType<ReservationIo['headroom']>>;
  try {
    headroom = await io.headroom(a.departmentId, a.userId);
  } catch (error) {
    await io.report('headroom', error, a.departmentId);
    return { ok: true, id: null };
  }
  if (!headroom.organizationId || !headroom.checks.length) return { ok: true, id: null };
  const amountKrw = Math.min(RESERVATION_MAX_KRW, Math.max(1, Math.ceil(a.amountKrw)));
  try {
    const got = await io.reserve({
      organizationId: headroom.organizationId, departmentId: a.departmentId, userId: a.userId, amountKrw,
      checks: headroom.checks, expiresAt: new Date(io.now() + RESERVATION_TTL_MS).toISOString(),
    });
    if (got.ok) return { ok: true, id: got.id };
    return { ok: false, scope: got.scope, amountKrw, leftKrw: Math.max(0, got.headroom - got.reserved), reservedKrw: got.reserved };
  } catch (error) {
    await io.report('reserve', error, a.departmentId);
    return { ok: true, id: null };
  }
}

/** 실행을 마치면 예약을 지운다 — 못 지워도 기한이 지나면 세지 않는다 */
export async function releaseRunUsage(io: ReservationIo, id: string | null | undefined, departmentId: string | null): Promise<void> {
  if (!id) return;
  try {
    await io.release(id);
  } catch (error) {
    await io.report('release', error, departmentId);
  }
}

/**
 * 기다리면 될 거절인가(2026-11-26) — 다른 실행이 쥔 예약을 빼서 모자랐고, 그 예약이 풀리면 남은 금액이 이번 금액을 덮는다.
 * 일괄 실행은 이런 줄을 멈추지 않고 다음 차례에 다시 돌린다(같은 묶음의 다른 줄이 예약을 쥐고 있을 때가 많다)
 */
export function reservationWaitable(r: Extract<ReserveResult, { ok: false }>): boolean {
  return r.reservedKrw > 0 && r.amountKrw <= r.leftKrw + r.reservedKrw;
}

const SCOPE_LABEL: Record<HeadroomCheck['scope'], string> = {
  department: '부서의 이번 달 남은 한도',
  user: '이번 달 개인 남은 한도',
  organization: '연간 계약의 남은 금액',
};

export function reservationRejectMessage(r: Extract<ReserveResult, { ok: false }>): string {
  const won = (n: number) => `${Math.round(n).toLocaleString()}원`;
  const others = r.reservedKrw > 0 ? `(실행 중인 다른 앱이 예약한 ${won(r.reservedKrw)}을 빼고)` : '';
  return `이 앱 실행은 많으면 약 ${won(r.amountKrw)}이 들 수 있는데 ${SCOPE_LABEL[r.scope]}가 ${won(r.leftKrw)}${others}이라 도중에 멈추지 않도록 시작하지 않았습니다. `
    + (r.reservedKrw > 0 ? '실행 중인 다른 앱이 끝난 뒤 다시 실행하거나 ' : '')
    + '관리자에게 한도 조정을 요청하세요.';
}

export function defaultReservationIo(): ReservationIo {
  return {
    headroom: (departmentId, userId) => amountHeadroom(departmentId, userId),
    async reserve({ organizationId, departmentId, userId, amountKrw, checks, expiresAt }) {
      const { data, error } = await supabaseAdmin.rpc('usage_reserve', {
        p_organization_id: organizationId, p_department_id: departmentId, p_user_id: userId, p_amount: amountKrw,
        p_checks: checks.map((c) => ({ scope: c.scope, headroom: c.headroom })), p_expires_at: expiresAt,
      });
      if (error) throw new Error(`usage_reserve ${error.code ?? ''}`.trim());
      const got = (data ?? {}) as { ok?: unknown; id?: unknown; scope?: unknown; headroom?: unknown; reserved?: unknown };
      if (got.ok === true && typeof got.id === 'string') return { ok: true, id: got.id };
      if (got.ok === false && (got.scope === 'department' || got.scope === 'user' || got.scope === 'organization')) {
        return { ok: false, scope: got.scope, headroom: Number(got.headroom) || 0, reserved: Number(got.reserved) || 0 };
      }
      throw new Error('usage_reserve: unexpected result');
    },
    async release(id) {
      const { error } = await supabaseAdmin.from('usage_reservations').delete().eq('id', id);
      if (error) throw new Error(`usage_reservations delete ${error.code ?? ''}`.trim());
    },
    async report(stage, error, departmentId) {
      await logSystem({
        level: 'warning',
        category: 'payment',
        message: stage === 'release' ? '앱 실행의 사용량 예약을 풀지 못했습니다(기한이 지나면 세지 않음)' : '앱 실행의 사용량을 예약하지 못해 예약 없이 실행했습니다',
        details: { stage, department_id: departmentId, error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) },
      });
    },
    now: () => Date.now(),
  };
}
