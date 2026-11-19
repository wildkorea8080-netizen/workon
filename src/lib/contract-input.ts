import { PLANS, type PlanKey } from './plans';

/**
 * 새 계약 입력 검사(2026-11-19) — `POST /api/super/contracts`.
 * 예전에는 요금제가 표 밖이면 조용히 체험(trial) 한도로 저장했고(계약에는 그 글이 남음), 월 이용료·날짜는 꼴을 보지 않았다.
 * 이 검사는 **기존 계약을 끝내기 전에** 한다 — 틀린 요청 하나로 지금 계약이 끝나지 않게.
 */
export interface ContractInput {
  orgId: string;
  planType: PlanKey;
  monthlyFee: number;
  startDate: string | null;
  endDate: string | null;
  notes: string | null;
  billingType: 'pay_as_you_go' | 'annual_fixed';
  annualBudgetKrw: number | null;
  budgetAlertPercent: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
export const MAX_MONTHLY_FEE = 1_000_000_000;
const MAX_NOTES = 1000;

/** 'YYYY-MM-DD'이고 실제로 있는 날이면 그대로, 아니면 null. */
export function validDay(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = DAY.exec(value);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? value : null;
}

const empty = (v: unknown) => v === undefined || v === null || v === '';

export function parseContractInput(body: unknown): { ok: true; value: ContractInput } | { ok: false; message: string } {
  if (!body || typeof body !== 'object') return { ok: false, message: '요청 형식이 올바르지 않습니다.' };
  const b = body as Record<string, unknown>;

  if (typeof b.orgId !== 'string' || !UUID.test(b.orgId)) return { ok: false, message: '기관을 고르세요.' };
  if (typeof b.planType !== 'string' || !Object.prototype.hasOwnProperty.call(PLANS, b.planType))
    return { ok: false, message: '요금제 값이 올바르지 않습니다.' };
  const planType = b.planType as PlanKey;

  let monthlyFee: number = PLANS[planType].monthlyFee;
  if (!empty(b.monthlyFee)) {
    const fee = Number(b.monthlyFee);
    if (!Number.isInteger(fee) || fee < 0 || fee > MAX_MONTHLY_FEE)
      return { ok: false, message: '월 이용료는 0 이상의 정수(원)로 적어 주세요.' };
    monthlyFee = fee;
  }

  const startDate = empty(b.startDate) ? null : validDay(b.startDate);
  if (!empty(b.startDate) && !startDate) return { ok: false, message: '시작일이 올바른 날짜가 아닙니다.' };
  const endDate = empty(b.endDate) ? null : validDay(b.endDate);
  if (!empty(b.endDate) && !endDate) return { ok: false, message: '종료일이 올바른 날짜가 아닙니다.' };
  if (startDate && endDate && endDate < startDate) return { ok: false, message: '종료일이 시작일보다 앞섭니다.' };

  if (!empty(b.notes) && (typeof b.notes !== 'string' || b.notes.length > MAX_NOTES))
    return { ok: false, message: `메모는 ${MAX_NOTES}자 안의 글로 적어 주세요.` };
  const notes = empty(b.notes) ? null : (b.notes as string);

  const billingType = b.billingType === 'annual_fixed' ? 'annual_fixed' : 'pay_as_you_go';
  // 연간 예산은 예전처럼 0·빈 값이면 없음(null)으로 둔다 — 값이 있으면 정수여야 한다
  let annualBudgetKrw: number | null = null;
  if (billingType === 'annual_fixed' && !empty(b.annualBudgetKrw) && Number(b.annualBudgetKrw) !== 0) {
    const budget = Number(b.annualBudgetKrw);
    if (!Number.isInteger(budget) || budget < 0) return { ok: false, message: '연간 예산(원)은 0 이상의 정수로 적어 주세요.' };
    annualBudgetKrw = budget;
  }
  const alert = Number(b.budgetAlertPercent);
  const budgetAlertPercent = alert > 0 && alert <= 100 ? alert : 80;

  return { ok: true, value: { orgId: b.orgId, planType, monthlyFee, startDate, endDate, notes, billingType, annualBudgetKrw, budgetAlertPercent } };
}
