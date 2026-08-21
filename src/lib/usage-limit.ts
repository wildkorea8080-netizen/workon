import { supabaseAdmin } from '@/lib/supabaseAdmin';

export interface TokenLimitStatus {
  /** false면 요청을 차단해야 한다 */
  allowed: boolean;
  usedTokens: number;
  limitTokens: number;
  organizationName?: string;
  /** 차단 사유 (allowed=false일 때만) */
  reason?:
    | 'org_suspended'
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
  };
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
  billing_type: string;
  annual_budget_krw: number | null;
  budget_alert_percent: number;
  started_at: string;
  expires_at: string | null;
}

/** 기관의 현재 유효한 계약. 여러 건이면 가장 최근 시작 건. */
async function getActiveContract(organizationId: string): Promise<ActiveContract | null> {
  const { data } = await supabaseAdmin
    .from('contracts')
    .select('billing_type, annual_budget_krw, budget_alert_percent, started_at, expires_at')
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

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
  contract: ActiveContract
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
    return null;
  }

  const usedKrw = Number(data ?? 0);
  const percent = Math.round((usedKrw / totalKrw) * 100);
  const budget = {
    totalKrw,
    usedKrw,
    percent,
    warning: percent >= (contract.budget_alert_percent ?? 80),
    contractEndsAt: contract.expires_at,
  };

  if (usedKrw >= totalKrw) {
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
export function limitMessage(status: TokenLimitStatus): string {
  if (status.reason === 'org_suspended') {
    return '기관 이용이 정지되었습니다. 관리자에게 문의하세요.';
  }
  if (status.reason === 'budget_exhausted') {
    const used = Math.round(status.budget?.usedKrw ?? 0).toLocaleString();
    const total = Math.round(status.budget?.totalKrw ?? 0).toLocaleString();
    return `연간 계약 금액을 모두 사용했습니다. (${used}원 / ${total}원) 계약 담당자에게 문의하세요.`;
  }
  if (status.reason === 'department_budget_exhausted') {
    const used = Math.round(status.monthly?.usedKrw ?? 0).toLocaleString();
    const total = Math.round(status.monthly?.limitKrw ?? 0).toLocaleString();
    return `부서의 이번 달 사용 한도를 모두 사용했습니다. (${used}원 / ${total}원) 부서 관리자에게 문의하세요.`;
  }
  if (status.reason === 'user_budget_exhausted') {
    const used = Math.round(status.monthly?.usedKrw ?? 0).toLocaleString();
    const total = Math.round(status.monthly?.limitKrw ?? 0).toLocaleString();
    return `이번 달 개인 사용 한도를 모두 사용했습니다. (${used}원 / ${total}원) 관리자에게 한도 조정을 요청하세요.`;
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
  organizationName: string
): Promise<TokenLimitStatus | null> {
  const { data: dept } = await supabaseAdmin
    .from('departments')
    .select('monthly_budget_krw, user_monthly_budget_krw')
    .eq('id', departmentId)
    .maybeSingle();

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
    } else {
      const usedKrw = Number(data ?? 0);
      if (usedKrw >= deptLimit) {
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
          },
        };
      }
    }
  }

  // ── 개인 한도 ──
  // users.monthly_budget_krw가 있으면 그 값을, 없으면 부서 기본값을 쓴다.
  if (!userId) return null;

  const { data: user } = await supabaseAdmin
    .from('users')
    .select('monthly_budget_krw')
    .eq('id', userId)
    .maybeSingle();

  const userLimit = Number(user?.monthly_budget_krw ?? dept.user_monthly_budget_krw ?? 0);
  if (userLimit <= 0) return null;

  const { data, error } = await supabaseAdmin.rpc('user_spend_krw', {
    p_user_id: userId,
    p_from: from,
    p_to: to,
  });

  if (error) {
    console.warn('[usage-limit] user_spend_krw 실패, 허용으로 진행:', error.message);
    return null;
  }

  const usedKrw = Number(data ?? 0);
  if (usedKrw >= userLimit) {
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
      },
    };
  }

  return null;
}

export async function checkTokenLimit(
  departmentId: string,
  userId?: string
): Promise<TokenLimitStatus> {
  try {
    const { data: dept } = await supabaseAdmin
      .from('departments')
      .select('organization_id')
      .eq('id', departmentId)
      .maybeSingle();

    const organizationId = dept?.organization_id;
    if (!organizationId) return ALLOWED;

    const { data: org } = await supabaseAdmin
      .from('organizations')
      .select('name, status, monthly_token_limit')
      .eq('id', organizationId)
      .maybeSingle();

    if (!org) return ALLOWED;

    if (org.status === 'suspended') {
      return {
        allowed: false,
        usedTokens: 0,
        limitTokens: org.monthly_token_limit ?? 0,
        organizationName: org.name,
        reason: 'org_suspended',
      };
    }

    // ── 부서·개인 월 한도 (0024) ──
    // 기관보다 좁은 층이라 먼저 본다. 기관 예산이 남아 있어도 부서나 개인이
    // 소진했으면 거기서 끊긴다.
    const monthly = await checkMonthlyBudget(departmentId, userId, org.name);
    if (monthly) return monthly;

    // ── 연간 정액 계약이면 금액 기준으로 판정 ──
    const contract = await getActiveContract(organizationId);
    if (contract?.billing_type === 'annual_fixed') {
      const budgetStatus = await checkAnnualBudget(organizationId, org.name, contract);
      if (budgetStatus) {
        // 기관 예산이 남아 있으면 부서·개인 사용액도 함께 실어 보낸다.
        // 화면이 두 값을 한 번에 보여줄 수 있다.
        return budgetStatus;
      }
    }

    // ── 종량제: 이번 달 토큰 합산 ──
    const limitTokens = org.monthly_token_limit ?? 0;
    if (limitTokens <= 0) return ALLOWED; // 0 = 무제한

    const { data: logs, error } = await supabaseAdmin
      .from('usage_logs')
      .select('details')
      .eq('organization_id', organizationId)
      .eq('action', 'chat_message')
      .gte('created_at', monthStartISO());

    if (error) return ALLOWED;

    const usedTokens = (logs ?? []).reduce((sum: number, log: { details: any }) => {
      const details = log.details ?? {};
      return sum + (details.input_tokens ?? 0) + (details.output_tokens ?? 0);
    }, 0);

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
  } catch {
    // 한도 확인 실패가 채팅을 막아서는 안 된다
    return ALLOWED;
  }
}
