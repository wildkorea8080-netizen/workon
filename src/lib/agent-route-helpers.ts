// src/lib/agent-route-helpers.ts
import { NextResponse } from 'next/server';
import { connectorCatalog } from '@/lib/connectors';
import { enabledModels } from '@/lib/models';
import { getAllowedModelIds } from '@/lib/model-policy';
import { getCapabilityScope } from '@/lib/connector-scope';
import { scopeViolations, type CapabilitySettings } from '@/lib/capabilities/settings';
import type { AgentTier } from '@/lib/agent-permissions';

export function jsonError(message: string, status: number, details?: Record<string, unknown>) {
  return NextResponse.json(
    { ok: false, error: details ? { message, details } : { message } },
    { status }
  );
}

export function knownIds(): { knownConnectorIds: string[]; knownModelIds: string[] } {
  return {
    knownConnectorIds: connectorCatalog().map((c) => c.id),
    knownModelIds: enabledModels().map((m) => m.id),
  };
}

/**
 * 비서에 정할 모델이 기관 허용 범위 안인가. 문제가 없으면 null.
 * 대화할 때도 다시 건다(S1-b) — 기관이 나중에 허용 목록에서 빼는 경우가 있다.
 */
export async function validateModelForOrganization(
  modelId: string | null | undefined,
  organizationId: string | null
): Promise<string | null> {
  if (modelId === undefined || modelId === null) return null;
  const allowed = await getAllowedModelIds(organizationId);
  return allowed.includes(modelId) ? null : '이 기관에서 허용하지 않은 모델입니다.';
}

/** 나만의·부서 비서는 기관이 공식 비서에서 쓰는 연결만 켤 수 있다 (설계 3.4). */
export async function checkCapabilityScope(
  tier: AgentTier,
  caps: CapabilitySettings | undefined,
  departmentId: string
): Promise<string | null> {
  if (tier === 'official' || !caps) return null;
  const violations = scopeViolations(caps, await getCapabilityScope(departmentId));
  return violations.length > 0
    ? `기관에서 쓰지 않는 공공데이터 연결은 켤 수 없습니다: ${violations.join(', ')}`
    : null;
}
