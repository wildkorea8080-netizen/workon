import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { connectorCatalog } from '@/lib/connectors';
import { getAccessScope, visibilityFilter } from '@/lib/department-scope';
import { isAccessScopeReadError } from '@/lib/access-scope-error';
import { deriveCapabilityScope, type CapabilityScope } from '@/lib/capabilities/settings';

/**
 * 나만의·부서 비서가 켤 수 있는 능력 범위.
 *
 * 판정 근거는 "내가 볼 수 있는 공식 비서 중 하나라도 그것을 켜 두었는가"다.
 * 관리자가 그 연결을 이 기관에서 쓰기로 이미 판단했다는 뜻이기 때문이다.
 * 계산은 capabilities/settings.ts의 순수 함수가 한다.
 */
export async function getCapabilityScope(departmentId: string): Promise<CapabilityScope> {
  // 조회 실패가 권한을 넓히면 안 된다. 아무것도 못 켜는 쪽으로 닫는다.
  return (await readCapabilityScope(departmentId)) ?? { publicDataConnectors: new Set() };
}

/**
 * 능력 범위 — 공식 비서를 못 읽으면 null(2026-11-20). 판정(저장·대화)은 `getCapabilityScope`로 닫고,
 * 화면에 선택지를 보일 때는 이것을 쓴다 — 닫은 값(빈 범위)을 보이면 이미 켠 연결이 '범위 밖'으로 보인다.
 */
export async function readCapabilityScope(departmentId: string): Promise<CapabilityScope | null> {
  const known = connectorCatalog().map((c) => c.id);
  if (known.length === 0) return { publicDataConnectors: new Set() };

  // 공개 범위를 못 읽은 것도 '못 읽음'(null) — 판정용 `getCapabilityScope`는 빈 범위로 닫는다
  const scope = await getAccessScope(departmentId).catch((err) => {
    if (isAccessScopeReadError(err)) return null;
    throw err;
  });
  if (!scope) return null;

  const { data, error } = await supabaseAdmin
    .from('agents')
    .select('capabilities')
    .or(visibilityFilter(scope))
    .eq('tier', 'official')
    .eq('is_active', true)
    .is('deleted_at', null);

  if (error) {
    console.error('[connector-scope] 공식 비서 조회 실패', error);
    return null;
  }

  return deriveCapabilityScope((data ?? []) as { capabilities: unknown }[], known);
}

/** 화면의 커넥터 선택지(/api/connectors). */
export async function getPersonalConnectorIds(departmentId: string): Promise<string[]> {
  const scope = await getCapabilityScope(departmentId);
  return [...scope.publicDataConnectors];
}

/** 화면의 커넥터 선택지 — 못 읽으면 null(`/api/connectors`가 503으로 답한다) */
export async function readPersonalConnectorIds(departmentId: string): Promise<string[] | null> {
  const scope = await readCapabilityScope(departmentId);
  return scope ? [...scope.publicDataConnectors] : null;
}
