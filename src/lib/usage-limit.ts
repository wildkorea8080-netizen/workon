import { supabaseAdmin } from '@/lib/supabaseAdmin';

export interface TokenLimitStatus {
  /** false면 요청을 차단해야 한다 */
  allowed: boolean;
  usedTokens: number;
  limitTokens: number;
  organizationName?: string;
  /** 차단 사유 (allowed=false일 때만) */
  reason?: 'org_suspended' | 'token_limit_exceeded';
}

const ALLOWED: TokenLimitStatus = { allowed: true, usedTokens: 0, limitTokens: 0 };

function monthStartISO() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

/**
 * 부서가 속한 기관의 이번 달 토큰 사용량이 한도를 넘었는지 확인합니다.
 *
 * 기관에 연결되지 않은 부서, 한도가 0(무제한)인 기관은 항상 허용합니다.
 * 집계 실패 시에도 허용합니다 — 과금 집계 오류로 서비스가 멈추면 안 됩니다.
 *
 * NOTE: 현재는 매 요청마다 이번 달 로그를 합산합니다. 기관당 월 수만 건까지는
 *       문제없지만, 그 이상 규모에서는 일별 집계 테이블이나 RPC로 옮겨야 합니다.
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
