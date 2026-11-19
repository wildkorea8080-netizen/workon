import { PLANS, type PlanKey } from './plans';
import { isOrgType, type OrgType } from './org-types';
import { normalizeOrgSlug } from './org-slug';
import { MAX_MONTHLY_FEE, validDay } from './contract-input';

/**
 * 슈퍼관리자 '새 기관 등록'(`POST /api/super/organizations`) 입력 검사(2026-11-19).
 *
 * 예전에는 요금제·유형·한도·이용료·날짜·이메일을 꼴을 보지 않고 DB에 보냈다 —
 *  - 틀린 날짜는 기관을 **만든 뒤** 계약을 넣다가 `toISOString`이 던져 500(기관만 남고 계약·부서·초대가 없는 반쪽 기관),
 *  - 1억 원 넘는 이용료는 계약 넣기를 DB가 거절했는데 `console.warn` 한 줄뿐이라 계약 없는 기관이 '등록됨'으로 보였고,
 *  - 표 밖 요금제·유형(공통 자료실 보관함을 정한다)도 그대로 저장했다.
 * 이 검사는 **아무것도 만들기 전에** 한다.
 */
export interface OrgCreateInput {
  name: string;
  slug: string;
  type: OrgType;
  plan: PlanKey;
  contractStart: string | null;
  contractEnd: string | null;
  maxUsers: number;
  maxAgents: number;
  maxTokensPerMonth: number;
  monthlyFee: number;
  adminEmail: string;
  notes: string | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_ORG_NAME = 100;
const MAX_NOTES = 1000;
const MAX_SEATS = 999_999;
const MAX_TOKENS = 1_000_000_000_000;

const empty = (v: unknown) => v === undefined || v === null || v === '';

/** 비었으면 기본값, 아니면 lo~hi 정수만 */
function intOr(v: unknown, fallback: number, lo: number, hi: number): number | null {
  if (empty(v)) return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
}

export function parseOrgCreateInput(body: unknown): { ok: true; value: OrgCreateInput } | { ok: false; message: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, message: '요청 형식이 올바르지 않습니다.' };
  const b = body as Record<string, unknown>;

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || typeof b.adminEmail !== 'string' || !b.adminEmail.trim() || empty(b.slug))
    return { ok: false, message: '기관명, Slug, 관리자 이메일은 필수입니다.' };
  if (name.length > MAX_ORG_NAME) return { ok: false, message: `기관명은 ${MAX_ORG_NAME}자까지 적을 수 있습니다.` };

  const slug = normalizeOrgSlug(b.slug);
  if (!slug.ok) return { ok: false, message: slug.message };

  const adminEmail = b.adminEmail.trim().toLowerCase();
  if (!EMAIL.test(adminEmail) || adminEmail.length > 254) return { ok: false, message: '관리자 이메일 형식이 올바르지 않습니다.' };

  // 유형은 공통 자료실 보관함을 정한다 — 표 밖이면 거절(비면 예전처럼 '공공기관')
  if (!empty(b.type) && !isOrgType(b.type)) return { ok: false, message: '기관 유형 값이 올바르지 않습니다.' };
  const type: OrgType = empty(b.type) ? '공공기관' : (b.type as OrgType);

  if (!empty(b.plan) && !(typeof b.plan === 'string' && Object.prototype.hasOwnProperty.call(PLANS, b.plan)))
    return { ok: false, message: '요금제 값이 올바르지 않습니다.' };
  const plan: PlanKey = empty(b.plan) ? 'basic' : (b.plan as PlanKey);

  const contractStart = empty(b.contractStart) ? null : validDay(b.contractStart);
  if (!empty(b.contractStart) && !contractStart) return { ok: false, message: '계약 시작일이 올바른 날짜가 아닙니다.' };
  const contractEnd = empty(b.contractEnd) ? null : validDay(b.contractEnd);
  if (!empty(b.contractEnd) && !contractEnd) return { ok: false, message: '계약 종료일이 올바른 날짜가 아닙니다.' };
  if (contractStart && contractEnd && contractEnd < contractStart) return { ok: false, message: '계약 종료일이 시작일보다 앞섭니다.' };

  // 기본값은 예전 그대로(20명·비서 10·월 200만 토큰·이용료 0)
  const maxUsers = intOr(b.maxUsers, 20, 1, MAX_SEATS);
  if (maxUsers === null) return { ok: false, message: `최대 사용자는 1~${MAX_SEATS.toLocaleString()} 사이의 정수로 적어 주세요.` };
  const maxAgents = intOr(b.maxAgents, 10, 1, MAX_SEATS);
  if (maxAgents === null) return { ok: false, message: `최대 비서는 1~${MAX_SEATS.toLocaleString()} 사이의 정수로 적어 주세요.` };
  const maxTokensPerMonth = intOr(b.maxTokensPerMonth, 2_000_000, 0, MAX_TOKENS);
  if (maxTokensPerMonth === null) return { ok: false, message: '월 토큰 한도는 0(무제한) 이상의 정수로 적어 주세요.' };
  // `contracts.price_per_month`는 numeric(10,2) — 넘으면 계약 넣기가 거절됐다
  const monthlyFee = intOr(b.monthlyFee, 0, 0, MAX_MONTHLY_FEE);
  if (monthlyFee === null) return { ok: false, message: '월 이용료는 0 이상의 정수(원)로 적어 주세요(1억 원 미만).' };

  if (!empty(b.notes) && (typeof b.notes !== 'string' || b.notes.length > MAX_NOTES))
    return { ok: false, message: `메모는 ${MAX_NOTES}자 안의 글로 적어 주세요.` };
  const notes = typeof b.notes === 'string' && b.notes.trim() ? b.notes : null;

  return {
    ok: true,
    value: { name, slug: slug.slug, type, plan, contractStart, contractEnd, maxUsers, maxAgents, maxTokensPerMonth, monthlyFee, adminEmail, notes },
  };
}
