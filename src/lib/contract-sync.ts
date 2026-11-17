import { logSystem } from '@/lib/logger';

/**
 * 슈퍼관리자의 계약·기관 상태 맞추기(2026-11-17).
 *
 * 계약을 만들거나 해지하거나 기관을 정지·활성화하면 계약(`contracts`)과 기관(`organizations` — 요금제·한도·상태) 두 표를 함께 바꾼다.
 * 예전에는 둘째 쓰기가 돌려준 오류를 보지 않아, 실패하면 **계약과 기관 한도가 어긋난 채** 성공으로 보였다(옛 계약이 함께 active로 남음·
 * 해지했는데 기관은 계속 이용·플랜을 바꿨는데 한도는 그대로). 이제 실패는 화면에 경고로 돌려주고 `system_logs`(payment, critical)에 남긴다.
 *
 * 기관을 다시 '활성'으로 돌릴 때 예전에는 그 기관의 **해지된 계약을 모두** active로 되살렸다 — 오래전에 끝난 옛 계약까지 살아나
 * 매출 합계(활성 계약의 월 요금 합)가 부풀었다. 이제 active 계약이 없을 때만, 기한이 지나지 않은 가장 최근 계약 하나만 되살린다.
 */

export interface ContractLite { id: string; status: string; started_at: string | null; expires_at: string | null }

/** 되살릴 계약 하나 — active가 이미 있으면 없음, 기한이 지난 계약은 빼고 시작이 가장 늦은 해지 계약 */
export function contractToRestore(contracts: ContractLite[], nowMs = Date.now()): string | null {
  if (contracts.some((c) => c.status === 'active')) return null;
  const candidates = contracts
    .filter((c) => c.status === 'cancelled')
    .filter((c) => !c.expires_at || Date.parse(c.expires_at) > nowMs)
    .sort((a, b) => Date.parse(b.started_at ?? '') - Date.parse(a.started_at ?? '') || 0);
  return candidates[0]?.id ?? null;
}

export type ContractSyncStage =
  | 'cancel_previous_contract'
  | 'org_limits_after_contract'
  | 'org_suspend_after_cancel'
  | 'org_plan_after_contract_change'
  | 'contract_cancel_after_org_suspend'
  | 'contract_restore_after_org_active'
  | 'org_admin_invitation'
  | 'org_default_department';

export const SYNC_WARNINGS: Record<ContractSyncStage, string> = {
  cancel_previous_contract: '기존 계약을 끝내지 못했습니다.',
  org_limits_after_contract: '계약은 만들었지만 기관의 요금제·한도를 맞추지 못했습니다. 기관 화면에서 한도를 확인해 주세요.',
  org_suspend_after_cancel: '계약은 해지했지만 기관을 정지하지 못했습니다. 기관 화면에서 상태를 확인해 주세요.',
  org_plan_after_contract_change: '계약은 바꿨지만 기관의 요금제·한도를 맞추지 못했습니다. 기관 화면에서 한도를 확인해 주세요.',
  contract_cancel_after_org_suspend: '기관은 정지했지만 계약을 해지하지 못했습니다. 계약 화면에서 확인해 주세요.',
  contract_restore_after_org_active: '기관은 활성화했지만 계약을 되살리지 못했습니다. 계약 화면에서 확인해 주세요.',
  org_admin_invitation: '기관은 만들었지만 관리자 초대를 저장하지 못했습니다. 기관 상세의 초대에서 새로 만들어 주세요.',
  org_default_department: '기관은 만들었지만 기본 부서를 만들지 못해 기본 비서와 관리자 초대가 빠졌습니다. 기관 상세에서 부서와 초대를 만들어 주세요.',
};

/** 맞추기 실패를 운영 기록에 — 기관 id·단계·오류 코드만. 던지지 않는다 */
export async function reportContractSync(
  stage: ContractSyncStage,
  organizationId: string,
  code: string,
  log: (p: Parameters<typeof logSystem>[0]) => Promise<void> = logSystem,
): Promise<string> {
  await log({ level: 'critical', category: 'payment', message: '계약·기관 상태를 맞추지 못했습니다', details: { stage, code }, orgId: organizationId }).catch(() => {});
  return SYNC_WARNINGS[stage];
}
