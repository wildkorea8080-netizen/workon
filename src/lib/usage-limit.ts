import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSystem } from '@/lib/logger';
import { isStoppedOrgStatus } from '@/lib/org-status';

/** 읽지 못해 확인하지 못한 단계 — 그 단계는 '허용'으로 열어 두었다(2026-11-18) */
export type LimitGap =
  | 'department' | 'organization' | 'monthly' | 'department_spend' | 'user' | 'user_spend'
  | 'contract' | 'annual_spend' | 'tokens' | 'exception'
  /** (0122) 앱 실행의 사용량 예약을 못 읽음 — 예약 없이 판정했다 */
  | 'reservations';

export interface TokenLimitStatus {
  /** false면 요청을 차단해야 한다 */
  allowed: boolean;
  /**
   * 읽기가 실패해 확인하지 못한 단계(2026-11-18). 있으면 `allowed: true`는 판정이 아니라 열어 둔 것이다 —
   * 대화는 막지 않지만(과금 집계 오류로 서비스가 멈추면 안 됨) 화면이 이 값을 '사용량'으로 보이면 안 된다
   */
  unverified?: LimitGap[];
  usedTokens: number;
  limitTokens: number;
  organizationName?: string;
  /** 차단 사유 (allowed=false일 때만) */
  reason?:
    | 'org_suspended'
    /** 슈퍼관리자가 '기관 종료'한 기관(2026-11-19 — 예전엔 종료한 기관의 직원도 대화를 계속했다) */
    | 'org_terminated'
    | 'token_limit_exceeded'
    | 'budget_exhausted'
    | 'department_budget_exhausted'
    | 'user_budget_exhausted';

  /** 부서·개인 월 한도(0024). 설정된 경우에만 채워진다 */
  monthly?: {
    scope: 'department' | 'user';
    usedKrw: number;
    limitKrw: number;
    percent: number;
    /** (0122) 실행 중인 앱이 예약해 둔 금액 — 판정은 쓴 금액 + 예약으로 한다(있을 때만) */
    reservedKrw?: number;
  };

  /** 연간 정액 계약일 때만 채워진다 */
  budget?: {
    /** 계약 금액(원) */
    totalKrw: number;
    /** 계약 기간 누적 사용액(원) */
    usedKrw: number;
    /** 소진율 0~100+ */
    percent: number;
    /** 경고 기준을 넘었는지 (차단은 아님) */
    warning: boolean;
    contractEndsAt: string | null;
    /** (0122) 실행 중인 앱이 예약해 둔 금액(있을 때만) */
    reservedKrw?: number;
  };
}

/** (0122) 살아 있는 사용량 예약의 합 — 범위마다. 자기 실행의 예약(`exclude`)은 뺀다 */
export interface ReservedSums { department: number; user: number; organization: number }
type ReservedLoader = () => Promise<ReservedSums>;
const NO_RESERVATIONS: ReservedSums = { department: 0, user: 0, organization: 0 };

/** 한 번만 읽는다(부서·개인·연간 판정이 함께 쓴다). 못 읽으면 0으로 보고 gaps에 적는다(열림 — 예전과 같은 판정) */
function reservationLoader(organizationId: string, departmentId: string, userId: string | undefined, exclude: string | undefined, gaps: LimitGap[]): ReservedLoader {
  let pending: Promise<ReservedSums> | null = null;
  return () => {
    pending ??= (async () => {
      const { data, error } = await supabaseAdmin.from('usage_reservations')
        .select('id, department_id, user_id, amount_krw')
        .eq('organization_id', organizationId).gt('expires_at', new Date().toISOString()).limit(1000);
      if (error) { gaps.push('reservations'); return NO_RESERVATIONS; }
      return sumReservations((data ?? []) as ReservationRow[], departmentId, userId, exclude);
    })();
    return pending;
  };
}

export type ReservationRow = { id: string; department_id: string | null; user_id: string | null; amount_krw: number | string | null };
export function sumReservations(rows: ReservationRow[], departmentId: string, userId: string | undefined, exclude?: string): ReservedSums {
  const sums = { department: 0, user: 0, organization: 0 };
  for (const row of rows) {
    if (exclude && row.id === exclude) continue;
    const amount = Number(row.amount_krw);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    sums.organization += amount;
    if (row.department_id === departmentId) sums.department += amount;
    if (userId && row.user_id === userId) sums.user += amount;
  }
  return sums;
}

const ALLOWED: TokenLimitStatus = { allowed: true, usedTokens: 0, limitTokens: 0 };

/**
 * 이번 달 1일 0시(KST)의 ISO 문자열.
 *
 * **서버 로컬 시간을 쓰면 안 된다.** Vercel은 UTC로 돌기 때문에, 한국 시간
 * 기준 매월 1일 0시~9시 사이에는 UTC로 아직 지난달이다. 그 아홉 시간 동안
 * 한도가 풀리지 않아 담당자는 "새 달인데 왜 막혀 있냐"를 겪는다.
 * 감사 자료를 KST로 내는 것과 같은 이유로 여기도 KST로 자른다.
 */
function monthStartISO() {
  const now = new Date();
  // UTC에 9시간을 더하면 그 시각의 '한국 달력'이 된다
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = kst.getUTCMonth();
  // 한국 1일 0시 = UTC 전날 15시
  return new Date(Date.UTC(y, m, 1, -9, 0, 0)).toISOString();
}

interface ActiveContract {
  id: string;
  billing_type: string;
  annual_budget_krw: number | null;
  budget_alert_percent: number;
  started_at: string;
  expires_at: string | null;
}

/** 기관의 현재 유효한 계약. 여러 건이면 가장 최근 시작 건. */
/** 읽기 실패: `gaps`를 주면 거기 적고 null(대화 판정 — 열어 둠), 없으면 던진다(알림 — 모르면 보내지 않음) */
async function getActiveContract(organizationId: string, gaps?: LimitGap[]): Promise<ActiveContract | null> {
  const { data, error } = await supabaseAdmin
    .from('contracts')
    .select('id, billing_type, annual_budget_krw, budget_alert_percent, started_at, expires_at')
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (!gaps) throw new Error(`contracts: ${error.code ?? error.message}`);
    gaps.push('contract');
    return null;
  }

  return (data as ActiveContract) ?? null;
}

/**
 * 연간 정액 계약의 예산 소진 판정.
 *
 * 공공기관은 확정 금액으로 예산을 편성하므로 토큰 수가 아니라 **금액**으로
 * 통제해야 합니다. 계약 기간 누적 사용액을 `organization_spend_krw` RPC로
 * 구해 계약 금액과 비교합니다.
 */
async function checkAnnualBudget(
  organizationId: string,
  organizationName: string,
  contract: ActiveContract,
  gaps: LimitGap[],
  reserved: ReservedLoader = async () => NO_RESERVATIONS,
): Promise<TokenLimitStatus | null> {
  const totalKrw = Number(contract.annual_budget_krw ?? 0);
  if (totalKrw <= 0) return null; // 금액 미설정이면 이 판정을 건너뛴다

  const from = contract.started_at;
  const to = contract.expires_at ?? new Date().toISOString();

  const { data, error } = await supabaseAdmin.rpc('organization_spend_krw', {
    p_organization_id: organizationId,
    p_from: from,
    p_to: to,
  });

  if (error) {
    console.warn('[usage-limit] organization_spend_krw 실패, 허용으로 진행:', error.message);
    gaps.push('annual_spend');
    return null;
  }

  const usedKrw = Number(data ?? 0);
  const percent = Math.round((usedKrw / totalKrw) * 100);
  const reservedKrw = (await reserved()).organization;
  const budget = {
    totalKrw,
    usedKrw,
    percent,
    warning: percent >= (contract.budget_alert_percent ?? 80),
    contractEndsAt: contract.expires_at,
    ...(reservedKrw > 0 ? { reservedKrw } : {}),
  };

  // 실행 중인 앱이 예약한 금액도 쓴 것으로 센다(0122) — 예약한 실행이 마칠 몫을 다른 대화가 먼저 쓰지 않게
  if (usedKrw + reservedKrw >= totalKrw) {
    return {
      allowed: false,
      usedTokens: 0,
      limitTokens: 0,
      organizationName,
      reason: 'budget_exhausted',
      budget,
    };
  }

  return { allowed: true, usedTokens: 0, limitTokens: 0, organizationName, budget };
}

/**
 * 부서가 속한 기관의 사용 한도를 확인합니다.
 *
 * 계약 형태에 따라 판정 기준이 다릅니다:
 *   annual_fixed  → 계약 기간 누적 **금액**이 계약 금액에 도달하면 차단
 *   pay_as_you_go → 이번 달 **토큰** 합산이 월 한도에 도달하면 차단 (기존 동작)
 *
 * 기관에 연결되지 않은 부서, 한도가 0(무제한)인 기관은 항상 허용합니다.
 * 집계 실패 시에도 허용합니다 — 과금 집계 오류로 서비스가 멈추면 안 됩니다.
 *
 * NOTE: 종량제 경로는 매 요청마다 이번 달 로그를 합산합니다. 기관당 월 수만
 *       건까지는 문제없지만, 그 이상 규모에서는 일별 집계 테이블로 옮겨야 합니다.
 */
/**
 * 차단 사유를 담당자가 바로 이해할 말로 바꾼다.
 *
 * 공공기관 담당자에게 "토큰 소진"은 의미가 통하지 않는다. 문구를 라우트마다
 * 따로 쓰면 같은 상황을 다르게 설명하게 되므로 한 곳에 둔다.
 */
/** (0122) 실행 중인 앱이 예약해 둔 금액이 있으면 '쓴 금액'에 덧붙인다 — 실제로 쓴 금액만 보면 왜 막혔는지 모른다 */
function reservedNote(reservedKrw: number | undefined): string {
  return reservedKrw && reservedKrw > 0 ? ` + 실행 중인 앱이 예약한 ${Math.round(reservedKrw).toLocaleString()}원` : '';
}

export function limitMessage(status: TokenLimitStatus): string {
  if (status.reason === 'org_suspended') {
    return '기관 이용이 정지되었습니다. 관리자에게 문의하세요.';
  }
  if (status.reason === 'org_terminated') {
    return '기관 이용이 종료되었습니다. 관리자에게 문의하세요.';
  }
  if (status.reason === 'budget_exhausted') {
    const used = Math.round(status.budget?.usedKrw ?? 0).toLocaleString();
    const total = Math.round(status.budget?.totalKrw ?? 0).toLocaleString();
    return `연간 계약 금액을 모두 사용했습니다. (${used}원${reservedNote(status.budget?.reservedKrw)} / ${total}원) 계약 담당자에게 문의하세요.`;
  }
  if (status.reason === 'department_budget_exhausted') {
    const used = Math.round(status.monthly?.usedKrw ?? 0).toLocaleString();
    const total = Math.round(status.monthly?.limitKrw ?? 0).toLocaleString();
    return `부서의 이번 달 사용 한도를 모두 사용했습니다. (${used}원${reservedNote(status.monthly?.reservedKrw)} / ${total}원) 부서 관리자에게 문의하세요.`;
  }
  if (status.reason === 'user_budget_exhausted') {
    const used = Math.round(status.monthly?.usedKrw ?? 0).toLocaleString();
    const total = Math.round(status.monthly?.limitKrw ?? 0).toLocaleString();
    return `이번 달 개인 사용 한도를 모두 사용했습니다. (${used}원${reservedNote(status.monthly?.reservedKrw)} / ${total}원) 관리자에게 한도 조정을 요청하세요.`;
  }
  return `이번 달 사용 한도를 모두 사용했습니다. (${status.usedTokens.toLocaleString()} / ${status.limitTokens.toLocaleString()} 토큰) 관리자에게 문의하세요.`;
}

/**
 * 부서·개인 월 한도 판정 (0024).
 *
 * 기관 한도만 있으면 **한 사람이 한 달 치 예산을 혼자 태워도** 막을 수
 * 없었다. 공공기관은 부서별로 금액을 배정받으므로 그 단위로도 통제해야 한다.
 *
 * 부서를 먼저 본다. 부서가 이미 소진됐으면 그 안의 누가 얼마 남았든
 * 쓸 수 없기 때문이다.
 *
 * 합산은 DB 함수가 한다. 매 대화마다 로그를 앱으로 끌어오면 월 수천 건만
 * 되어도 무겁다.
 */
async function checkMonthlyBudget(
  departmentId: string,
  userId: string | undefined,
  organizationName: string,
  gaps: LimitGap[],
  reserved: ReservedLoader = async () => NO_RESERVATIONS,
): Promise<TokenLimitStatus | null> {
  const { data: dept, error: deptError } = await supabaseAdmin
    .from('departments')
    .select('monthly_budget_krw, user_monthly_budget_krw')
    .eq('id', departmentId)
    .maybeSingle();
  if (deptError) { gaps.push('monthly'); return null; }

  if (!dept) return null;

  const from = monthStartISO();
  const to = new Date().toISOString();

  // ── 부서 한도 ──
  const deptLimit = Number(dept.monthly_budget_krw ?? 0);
  if (deptLimit > 0) {
    const { data, error } = await supabaseAdmin.rpc('department_spend_krw', {
      p_department_id: departmentId,
      p_from: from,
      p_to: to,
    });

    if (error) {
      // 집계 실패로 서비스를 멈추지 않는다 (기관 한도와 같은 규칙)
      console.warn('[usage-limit] department_spend_krw 실패, 허용으로 진행:', error.message);
      gaps.push('department_spend');
    } else {
      const usedKrw = Number(data ?? 0);
      const reservedKrw = (await reserved()).department;
      if (usedKrw + reservedKrw >= deptLimit) {
        return {
          allowed: false,
          usedTokens: 0,
          limitTokens: 0,
          organizationName,
          reason: 'department_budget_exhausted',
          monthly: {
            scope: 'department',
            usedKrw,
            limitKrw: deptLimit,
            percent: Math.round((usedKrw / deptLimit) * 100),
            ...(reservedKrw > 0 ? { reservedKrw } : {}),
          },
        };
      }
    }
  }

  // ── 개인 한도 ──
  // users.monthly_budget_krw가 있으면 그 값을, 없으면 부서 기본값을 쓴다.
  if (!userId) return null;

  const { data: user, error: userError } = await supabaseAdmin
    .from('users')
    .select('monthly_budget_krw')
    .eq('id', userId)
    .maybeSingle();
  // 개인 한도를 못 읽으면 부서 기본값으로 본다(확인하지 못한 것으로 적음)
  if (userError) gaps.push('user');

  const userLimit = Number(user?.monthly_budget_krw ?? dept.user_monthly_budget_krw ?? 0);
  if (userLimit <= 0) return null;

  const { data, error } = await supabaseAdmin.rpc('user_spend_krw', {
    p_user_id: userId,
    p_from: from,
    p_to: to,
  });

  if (error) {
    console.warn('[usage-limit] user_spend_krw 실패, 허용으로 진행:', error.message);
    gaps.push('user_spend');
    return null;
  }

  const usedKrw = Number(data ?? 0);
  const reservedKrw = (await reserved()).user;
  if (usedKrw + reservedKrw >= userLimit) {
    return {
      allowed: false,
      usedTokens: 0,
      limitTokens: 0,
      organizationName,
      reason: 'user_budget_exhausted',
      monthly: {
        scope: 'user',
        usedKrw,
        limitKrw: userLimit,
        percent: Math.round((usedKrw / userLimit) * 100),
        ...(reservedKrw > 0 ? { reservedKrw } : {}),
      },
    };
  }

  return null;
}

const GAP_REPORT_INTERVAL_MS = 10 * 60 * 1000;
const lastGapReport = new Map<string, number>();

/**
 * 한도를 확인하지 못해 열어 둔 것을 운영 기록에(2026-11-18). 예전엔 `console.warn` 한 줄이거나 아무것도 없어
 * DB가 잠깐 이상한 동안 한도·정지가 걸리지 않아도 운영자가 몰랐다. 대화마다 남기면 장애 중 기록이 쏟아지므로 부서마다 10분에 한 번
 */
export async function reportLimitGaps(
  departmentId: string,
  gaps: LimitGap[],
  log: (p: Parameters<typeof logSystem>[0]) => Promise<void> = logSystem,
  nowMs = Date.now(),
): Promise<boolean> {
  if (gaps.length === 0) return false;
  const last = lastGapReport.get(departmentId);
  if (last !== undefined && nowMs - last < GAP_REPORT_INTERVAL_MS) return false;
  if (lastGapReport.size > 1000) lastGapReport.clear();
  lastGapReport.set(departmentId, nowMs);
  await log({
    level: 'error',
    category: 'payment',
    message: '사용 한도를 확인하지 못해 허용했습니다(한도·정지가 걸리지 않았을 수 있음)',
    details: { department_id: departmentId, steps: Array.from(new Set(gaps)) },
  }).catch(() => {});
  return true;
}

/** 시험용 — 10분 기억을 비운다 */
export function resetLimitGapReports(): void {
  lastGapReport.clear();
}

export async function checkTokenLimit(
  departmentId: string,
  userId?: string,
  /** (0122) 실행 중인 앱이 자기 예약을 빼고 볼 때 — 단계마다의 다시 보기(guard) */
  opts: { excludeReservationId?: string } = {},
): Promise<TokenLimitStatus> {
  const gaps: LimitGap[] = [];
  let status: TokenLimitStatus;
  try {
    status = await evaluateTokenLimit(departmentId, userId, gaps, opts.excludeReservationId);
  } catch {
    // 한도 확인 실패가 채팅을 막아서는 안 된다
    gaps.push('exception');
    status = ALLOWED;
  }
  if (gaps.length === 0) return status;
  await reportLimitGaps(departmentId, gaps);
  return { ...status, unverified: Array.from(new Set(gaps)) };
}

async function evaluateTokenLimit(
  departmentId: string,
  userId: string | undefined,
  gaps: LimitGap[],
  excludeReservationId?: string,
): Promise<TokenLimitStatus> {
  {
    const { data: dept, error: deptError } = await supabaseAdmin
      .from('departments')
      .select('organization_id')
      .eq('id', departmentId)
      .maybeSingle();
    if (deptError) { gaps.push('department'); return ALLOWED; }

    const organizationId = dept?.organization_id;
    if (!organizationId) return ALLOWED;

    const { data: org, error: orgError } = await supabaseAdmin
      .from('organizations')
      .select('name, status, monthly_token_limit')
      .eq('id', organizationId)
      .maybeSingle();
    if (orgError) { gaps.push('organization'); return ALLOWED; }

    if (!org) return ALLOWED;

    // 정지·종료한 기관은 막는다(2026-11-19 — 예전엔 'suspended'만 보아 '기관 종료'한 기관의 직원이 계속 대화했다)
    if (isStoppedOrgStatus(org.status)) {
      return {
        allowed: false,
        usedTokens: 0,
        limitTokens: org.monthly_token_limit ?? 0,
        organizationName: org.name,
        reason: org.status === 'terminated' ? 'org_terminated' : 'org_suspended',
      };
    }

    // ── 부서·개인 월 한도 (0024) ──
    // 기관보다 좁은 층이라 먼저 본다. 기관 예산이 남아 있어도 부서나 개인이
    // 소진했으면 거기서 끊긴다.
    // 실행 중인 앱의 사용량 예약(0122) — 금액 한도가 있을 때만 한 번 읽는다
    const reserved = reservationLoader(organizationId, departmentId, userId, excludeReservationId, gaps);
    const monthly = await checkMonthlyBudget(departmentId, userId, org.name, gaps, reserved);
    if (monthly) return monthly;

    // ── 연간 정액 계약이면 금액 기준으로 판정 ──
    const contract = await getActiveContract(organizationId, gaps);
    if (contract?.billing_type === 'annual_fixed') {
      const budgetStatus = await checkAnnualBudget(organizationId, org.name, contract, gaps, reserved);
      if (budgetStatus) {
        // 기관 예산이 남아 있으면 부서·개인 사용액도 함께 실어 보낸다.
        // 화면이 두 값을 한 번에 보여줄 수 있다.
        return budgetStatus;
      }
    }

    // ── 종량제: 이번 달 토큰 합산 ──
    const limitTokens = org.monthly_token_limit ?? 0;
    if (limitTokens <= 0) return ALLOWED; // 0 = 무제한

    // 합은 DB가 난다(0057) — 앱으로 읽으면 API가 1,000행까지만 돌려줘 한도가 걸리지 않았다
    const { data: tokens, error } = await supabaseAdmin.rpc('organization_chat_tokens', {
      p_organization_id: organizationId,
      p_from: monthStartISO(),
    });

    if (error) { gaps.push('tokens'); return ALLOWED; }

    const usedTokens = Number(tokens ?? 0);

    if (usedTokens >= limitTokens) {
      return {
        allowed: false,
        usedTokens,
        limitTokens,
        organizationName: org.name,
        reason: 'token_limit_exceeded',
      };
    }

    return { allowed: true, usedTokens, limitTokens, organizationName: org.name };
  }
}

/** 기관 단위 사용률 — 예산 알림 메일(budget-alerts.ts)이 쓴다. 판정 기준은 위 `checkTokenLimit`과 같다 */
export interface OrganizationBudgetStatus {
  kind: 'annual_budget' | 'monthly_tokens';
  /** 같은 기간 안에서만 같은 알림을 한 번 보낸다 — 연간 계약은 계약 id, 종량제는 KST 달 */
  periodKey: string;
  used: number;
  limit: number;
  percent: number;
  /** 첫 경고 기준(%) — 연간 계약의 `budget_alert_percent`, 종량제는 80 */
  alertPercent: number;
  periodEndsAt: string | null;
}

/**
 * 기관의 이번 기간 사용률. 한도가 없거나(무제한·금액 미설정) 정지된 기관·집계 실패는 null —
 * 알림은 차단 판정과 달리 **모르면 보내지 않는다**(거짓 경보보다 하루 늦은 경보가 낫다).
 */
export async function organizationBudgetStatus(organizationId: string): Promise<OrganizationBudgetStatus | null> {
  const contract = await getActiveContract(organizationId);
  if (contract?.billing_type === 'annual_fixed') {
    const totalKrw = Number(contract.annual_budget_krw ?? 0);
    if (totalKrw <= 0) return null;
    const { data, error } = await supabaseAdmin.rpc('organization_spend_krw', {
      p_organization_id: organizationId,
      p_from: contract.started_at,
      p_to: contract.expires_at ?? new Date().toISOString(),
    });
    if (error) throw new Error(`organization_spend_krw: ${error.message}`);
    const usedKrw = Number(data ?? 0);
    return {
      kind: 'annual_budget',
      periodKey: `contract:${contract.id}`,
      used: usedKrw,
      limit: totalKrw,
      percent: Math.floor((usedKrw / totalKrw) * 100),
      alertPercent: contract.budget_alert_percent ?? 80,
      periodEndsAt: contract.expires_at,
    };
  }

  const { data: org, error: orgError } = await supabaseAdmin
    .from('organizations')
    .select('monthly_token_limit')
    .eq('id', organizationId)
    .maybeSingle();
  if (orgError) throw new Error(`organizations: ${orgError.message}`);
  const limitTokens = Number(org?.monthly_token_limit ?? 0);
  if (limitTokens <= 0) return null;

  const from = monthStartISO();
  // 한도 판정과 같은 DB 합(0057) — 1,000행 상한에서 덜 세지 않게
  const { data: tokens, error } = await supabaseAdmin.rpc('organization_chat_tokens', { p_organization_id: organizationId, p_from: from });
  if (error) throw new Error(`organization_chat_tokens: ${error.message}`);
  const usedTokens = Number(tokens ?? 0);
  return {
    kind: 'monthly_tokens',
    periodKey: monthPeriodKey(from),
    used: usedTokens,
    limit: limitTokens,
    percent: Math.floor((usedTokens / limitTokens) * 100),
    alertPercent: 80,
    periodEndsAt: null,
  };
}

/** 'month:YYYY-MM' — monthStartISO(KST 1일 0시 = UTC 전날 15시)의 한국 달력 달 */
function monthPeriodKey(fromIso: string): string {
  const kst = new Date(new Date(fromIso).getTime() + 9 * 60 * 60 * 1000);
  return `month:${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 부서 월 한도(0024) 사용률 — 예산 알림 메일이 쓴다. 판정 기준은 위 `checkMonthlyBudget`과 같다 */
export interface DepartmentBudgetStatus {
  departmentId: string;
  departmentName: string;
  periodKey: string;
  used: number;
  limit: number;
  percent: number;
}

/**
 * 기관 안에서 월 한도를 둔 부서들의 이번 달(KST) 사용률. 부서 목록을 못 읽으면 던지고,
 * 한 부서의 집계가 실패하면 그 부서만 빼고 `failed`로 센다(모르면 보내지 않는다).
 */
export async function departmentBudgetStatuses(
  organizationId: string
): Promise<{ statuses: DepartmentBudgetStatus[]; failed: number }> {
  const { data, error } = await supabaseAdmin
    .from('departments')
    .select('id, name, monthly_budget_krw')
    .eq('organization_id', organizationId)
    .gt('monthly_budget_krw', 0);
  if (error) throw new Error(`departments: ${error.message}`);
  const from = monthStartISO();
  const to = new Date().toISOString();
  const statuses: DepartmentBudgetStatus[] = [];
  let failed = 0;
  for (const dept of (data ?? []) as Array<{ id: string; name: string; monthly_budget_krw: number | string | null }>) {
    const limit = Number(dept.monthly_budget_krw ?? 0);
    if (!(limit > 0)) continue;
    const { data: spent, error: spendError } = await supabaseAdmin.rpc('department_spend_krw', {
      p_department_id: dept.id,
      p_from: from,
      p_to: to,
    });
    if (spendError) { failed += 1; continue; }
    const used = Number(spent ?? 0);
    statuses.push({
      departmentId: dept.id,
      departmentName: dept.name,
      periodKey: monthPeriodKey(from),
      used,
      limit,
      percent: Math.floor((used / limit) * 100),
    });
  }
  return { statuses, failed };
}

/** Personal monthly limit (0024) usage, for the budget alert mail. Same rule as `checkMonthlyBudget`'s personal part. */
export interface MyBudgetStatus {
  usedKrw: number;
  limitKrw: number;
  /** 내림 — 99.6%를 100%로 보이면 아직 안 막혔는데 막힌 것처럼 보인다 */
  percent: number;
  /** 한도에 닿아 다음 달 1일까지 이용이 멈춘 상태(판정과 같은 `>=`) */
  exhausted: boolean;
}

/**
 * 내 사용현황에 보일 **개인 월 한도**(2026-11-18). 개인 한도 알림 메일이 '내 사용현황 보기'로 보내는데 그 화면에 한도·사용액이 없었다.
 * 규칙은 판정(`checkMonthlyBudget`)과 같다 — 개인 값(`users.monthly_budget_krw`) 우선, 없으면 부서 기본값, 사용액은 `user_spend_krw`(한국 시간 이번 달).
 * 한도가 없으면 null. **못 읽으면 던진다** — 화면이 0원으로 꾸미지 않게(부른 쪽이 '확인하지 못함'으로 보인다)
 */
export async function myMonthlyBudget(userId: string): Promise<MyBudgetStatus | null> {
  const { data: user, error: userError } = await supabaseAdmin
    .from('users')
    .select('department_id, monthly_budget_krw')
    .eq('id', userId)
    .maybeSingle();
  if (userError) throw userError;
  if (!user?.department_id) return null;

  const { data: dept, error: deptError } = await supabaseAdmin
    .from('departments')
    .select('user_monthly_budget_krw')
    .eq('id', user.department_id)
    .maybeSingle();
  if (deptError) throw deptError;

  const limitKrw = Number(user.monthly_budget_krw ?? dept?.user_monthly_budget_krw ?? 0);
  if (!(limitKrw > 0)) return null;

  const { data, error } = await supabaseAdmin.rpc('user_spend_krw', {
    p_user_id: userId,
    p_from: monthStartISO(),
    p_to: new Date().toISOString(),
  });
  if (error) throw error;
  const usedKrw = Number(data ?? 0);
  if (!Number.isFinite(usedKrw)) throw new Error('user_spend_krw: not a number');
  return { usedKrw, limitKrw, percent: Math.floor((usedKrw / limitKrw) * 100), exhausted: usedKrw >= limitKrw };
}

/**
 * 내 사용현황에 보일 **부서 월 한도**(2026-11-18). 부서 한도는 판정에서 가장 먼저 보고, 닿으면 그 부서 직원 전체가 멈춘다 —
 * 그런데 막힌 직원이 볼 수 있는 곳이 없었다(안내 문구에 한 번 나올 뿐, 닿기 전에는 얼마나 남았는지 알 길이 없음).
 * 규칙은 판정(`checkMonthlyBudget`의 부서 부분)과 같다 — **내 부서**의 `monthly_budget_krw`와 `department_spend_krw`(한국 시간 이번 달).
 * 상위 부서의 한도는 보지 않는다(판정도 보지 않는다). 한도가 없으면 null. **못 읽으면 던진다**(0원으로 꾸미지 않게).
 * 부서 전체의 합계 금액만 낸다 — 누가 얼마를 썼는지는 내지 않는다.
 */
export async function myDepartmentBudget(userId: string): Promise<MyBudgetStatus | null> {
  const { data: user, error: userError } = await supabaseAdmin
    .from('users')
    .select('department_id')
    .eq('id', userId)
    .maybeSingle();
  if (userError) throw userError;
  if (!user?.department_id) return null;

  const { data: dept, error: deptError } = await supabaseAdmin
    .from('departments')
    .select('monthly_budget_krw')
    .eq('id', user.department_id)
    .maybeSingle();
  if (deptError) throw deptError;

  const limitKrw = Number(dept?.monthly_budget_krw ?? 0);
  if (!(limitKrw > 0)) return null;

  const { data, error } = await supabaseAdmin.rpc('department_spend_krw', {
    p_department_id: user.department_id,
    p_from: monthStartISO(),
    p_to: new Date().toISOString(),
  });
  if (error) throw error;
  const usedKrw = Number(data ?? 0);
  if (!Number.isFinite(usedKrw)) throw new Error('department_spend_krw: not a number');
  return { usedKrw, limitKrw, percent: Math.floor((usedKrw / limitKrw) * 100), exhausted: usedKrw >= limitKrw };
}

export interface UserBudgetStatus {
  userId: string;
  periodKey: string;
  used: number;
  limit: number;
  percent: number;
}

/**
 * This month's (KST) usage of every active employee in the organization who has a personal limit, in one DB call
 * (0052 `organization_user_budget_usage`). Throws if it cannot read — the caller then sends nothing (no false alarms).
 */
export async function userBudgetStatuses(organizationId: string): Promise<UserBudgetStatus[]> {
  const from = monthStartISO();
  const to = new Date().toISOString();
  const { data, error } = await supabaseAdmin.rpc('organization_user_budget_usage', {
    p_organization_id: organizationId,
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error(`organization_user_budget_usage: ${error.message}`);
  const periodKey = monthPeriodKey(from);
  const statuses: UserBudgetStatus[] = [];
  for (const row of (data ?? []) as Array<{ user_id: string; limit_krw: number | string | null; spent_krw: number | string | null }>) {
    const limit = Number(row.limit_krw ?? 0);
    const used = Number(row.spent_krw ?? 0);
    if (!(limit > 0) || !Number.isFinite(used) || typeof row.user_id !== 'string') continue;
    statuses.push({ userId: row.user_id, periodKey, used, limit, percent: Math.floor((used / limit) * 100) });
  }
  return statuses;
}

/** (0122) 금액 한도의 남은 금액 — 앱 실행의 사용량 예약(usage-reservation.ts)이 쓴다 */
export interface HeadroomCheck {
  scope: 'department' | 'user' | 'organization';
  /** 한도 − 쓴 금액(원). 다른 실행의 예약은 빼지 않았다 — 예약 함수(usage_reserve)가 잠금 안에서 뺀다 */
  headroom: number;
  limitKrw: number;
}

/**
 * 판정(`checkTokenLimit`)과 같은 규칙의 금액 한도별 남은 금액 — 부서 월 한도·개인 월 한도(개인 값, 없으면 부서 기본값)·
 * 연간 정액 계약 금액. 토큰 한도(종량제)는 금액이 아니라 예약하지 않는다. 기관이 없으면 빈 목록, 못 읽으면 던진다(예약하지 않음)
 */
export async function amountHeadroom(departmentId: string, userId: string | undefined): Promise<{ organizationId: string | null; checks: HeadroomCheck[] }> {
  const fail = (what: string, code?: string) => { throw new Error(`amountHeadroom: ${what}${code ? ` ${code}` : ''}`); };
  const { data: dept, error: deptError } = await supabaseAdmin
    .from('departments').select('organization_id, monthly_budget_krw, user_monthly_budget_krw').eq('id', departmentId).maybeSingle();
  if (deptError) fail('department', deptError.code);
  const organizationId = (dept?.organization_id as string | null | undefined) ?? null;
  if (!dept || !organizationId) return { organizationId: null, checks: [] };
  const checks: HeadroomCheck[] = [];
  const from = monthStartISO();
  const to = new Date().toISOString();
  const deptLimit = Number(dept.monthly_budget_krw ?? 0);
  if (deptLimit > 0) {
    const { data, error } = await supabaseAdmin.rpc('department_spend_krw', { p_department_id: departmentId, p_from: from, p_to: to });
    if (error) fail('department_spend', error.code);
    checks.push({ scope: 'department', headroom: deptLimit - Number(data ?? 0), limitKrw: deptLimit });
  }
  if (userId) {
    const { data: user, error: userError } = await supabaseAdmin.from('users').select('monthly_budget_krw').eq('id', userId).maybeSingle();
    if (userError) fail('user', userError.code);
    const userLimit = Number(user?.monthly_budget_krw ?? dept.user_monthly_budget_krw ?? 0);
    if (userLimit > 0) {
      const { data, error } = await supabaseAdmin.rpc('user_spend_krw', { p_user_id: userId, p_from: from, p_to: to });
      if (error) fail('user_spend', error.code);
      checks.push({ scope: 'user', headroom: userLimit - Number(data ?? 0), limitKrw: userLimit });
    }
  }
  const contract = await getActiveContract(organizationId);
  const totalKrw = Number(contract?.annual_budget_krw ?? 0);
  if (contract?.billing_type === 'annual_fixed' && totalKrw > 0) {
    const { data, error } = await supabaseAdmin.rpc('organization_spend_krw', {
      p_organization_id: organizationId, p_from: contract.started_at, p_to: contract.expires_at ?? new Date().toISOString(),
    });
    if (error) fail('annual_spend', error.code);
    checks.push({ scope: 'organization', headroom: totalKrw - Number(data ?? 0), limitKrw: totalKrw });
  }
  return { organizationId, checks };
}
