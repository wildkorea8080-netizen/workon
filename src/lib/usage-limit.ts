import { supabaseAdmin } from '@/lib/supabaseAdmin';

export interface TokenLimitStatus {
  /** false면 요청을 차단해야 한다 */
  allowed: boolean;
  usedTokens: number;
  limitTokens: number;
  organizationName?: string;
  /** 차단 사유 (allowed=false일 때만) */
  reason?: 'org_suspended' | 'token_limit_exceeded' | 'budget_exhausted';

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

function monthStartISO() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
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
export async function checkTokenLimit(departmentId: string): Promise<TokenLimitStatus> {
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

    // ── 연간 정액 계약이면 금액 기준으로 판정 ──
    const contract = await getActiveContract(organizationId);
    if (contract?.billing_type === 'annual_fixed') {
      const budgetStatus = await checkAnnualBudget(organizationId, org.name, contract);
      if (budgetStatus) return budgetStatus;
      // 금액이 설정되지 않았으면 아래 토큰 기준으로 폴백한다
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
