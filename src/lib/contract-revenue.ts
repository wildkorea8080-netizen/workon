/**
 * 계약 매출을 한 규칙으로(2026-11-17) — 잎 파일(아무것도 import하지 않음).
 *
 * 예전엔
 *  - 슈퍼관리자 대시보드 '이번달 매출'이 **이번 달에 시작한** 계약만 더해, 4월부터 이어지는 계약(월 1,090,000원)이 있어도 0원이었다.
 *  - 계약 '매출 현황'은 그해에 시작한 계약만 봐 전해에 시작해 이어지는 계약이 빠지고, 달 경계가 UTC였으며,
 *    해지된 계약(새 계약을 만들면 옛 계약이 해지로 바뀜)도 끝날 날이 없으면 해지 뒤에도 매달 더해 새 계약과 겹쳐 셌다.
 * 규칙: 계약은 시작한 때부터 '끝나는 날'과 (해지됐으면) 해지한 때(`updated_at`) 중 이른 때까지 유효하고, 한 달(한국 시간)에
 * 하루라도 유효했으면 그달 매출에 월 이용료를 더한다. 해지·만료 전에 시작했어야 한다.
 */

export interface RevenueContract {
  status: string | null;
  price_per_month: number | string | null;
  started_at: string | null;
  expires_at: string | null;
  updated_at?: string | null;
}

const KST_MS = 9 * 60 * 60 * 1000;

/** 한국 시간 그해 그달의 [시작, 다음 달 시작) — 밀리초 */
export function kstMonthRange(year: number, month: number): [number, number] {
  return [Date.UTC(year, month - 1, 1) - KST_MS, Date.UTC(year, month, 1) - KST_MS];
}

/** 지금의 한국 연·월 */
export function kstYearMonth(nowMs = Date.now()): { year: number; month: number } {
  const d = new Date(nowMs + KST_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

const ms = (s: string | null | undefined) => {
  if (!s) return NaN;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
};

/** 계약이 끝나는 때 — 끝날 날이 없고 해지도 안 됐으면 Infinity */
export function contractEndMs(c: RevenueContract): number {
  let end = Number.isFinite(ms(c.expires_at)) ? ms(c.expires_at) : Infinity;
  if (c.status === 'cancelled') {
    const cut = ms(c.updated_at);
    // 해지한 때를 모르면 매출로 세지 않는다(부풀리지 않게)
    end = Number.isFinite(cut) ? Math.min(end, cut) : -Infinity;
  }
  return end;
}

/** [start, endEx)에 하루라도 유효했는가 */
export function contractInForce(c: RevenueContract, startMs: number, endExMs: number): boolean {
  if (c.status !== 'active' && c.status !== 'cancelled') return false;
  const s = ms(c.started_at);
  if (!Number.isFinite(s) || s >= endExMs) return false;
  return contractEndMs(c) > startMs;
}

const price = (v: RevenueContract['price_per_month']) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** 그 기간에 유효했던 계약의 월 이용료 합·수 */
export function revenueIn(contracts: RevenueContract[], startMs: number, endExMs: number): { revenue: number; count: number } {
  let revenue = 0;
  let count = 0;
  for (const c of contracts) {
    if (!contractInForce(c, startMs, endExMs)) continue;
    revenue += price(c.price_per_month);
    count += 1;
  }
  return { revenue, count };
}
