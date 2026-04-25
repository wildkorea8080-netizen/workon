export const PLANS = {
  trial: {
    name: 'Trial',
    maxUsers: 5,
    maxAgents: 3,
    maxTokensPerMonth: 100_000,
    monthlyFee: 0,
    color: '#6B7280',
  },
  basic: {
    name: 'Basic',
    maxUsers: 20,
    maxAgents: 10,
    maxTokensPerMonth: 1_000_000,
    monthlyFee: 100_000,
    color: '#3B82F6',
  },
  pro: {
    name: 'Pro',
    maxUsers: 50,
    maxAgents: 30,
    maxTokensPerMonth: 3_000_000,
    monthlyFee: 300_000,
    color: '#7C3AED',
  },
  enterprise: {
    name: 'Enterprise',
    maxUsers: 999_999,
    maxAgents: 999_999,
    maxTokensPerMonth: 999_999_999,
    monthlyFee: 0,
    color: '#F59E0B',
  },
} as const;

export type PlanKey = keyof typeof PLANS;

export function getPlan(key: string) {
  return PLANS[key as PlanKey] ?? PLANS.trial;
}
