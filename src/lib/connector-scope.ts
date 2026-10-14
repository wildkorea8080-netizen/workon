import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { connectorCatalog } from '@/lib/connectors';
import { getAccessScope, visibilityFilter } from '@/lib/department-scope';
import { deriveCapabilityScope, type CapabilityScope } from '@/lib/capabilities/settings';

/**
 * 나만의·부서 비서가 켤 수 있는 능력 범위.
 *
 * 판정 근거는 "내가 볼 수 있는 공식 비서 중 하나라도 그것을 켜 두었는가"다.
 * 관리자가 그 연결을 이 기관에서 쓰기로 이미 판단했다는 뜻이기 때문이다.
 * 계산은 capabilities/settings.ts의 순수 함수가 한다.
 */
export async function getCapabilityScope(departmentId: string): Promise<CapabilityScope> {
  const known = connectorCatalog().map((c) => c.id);
  if (known.length === 0) return { publicDataConnectors: new Set() };

  const scope = await getAccessScope(departmentId);

  const { data, error } = await supabaseAdmin
    .from('agents')
    .select('capabilities')
    .or(visibilityFilter(scope))
    .eq('tier', 'official')
    .eq('is_active', true)
    .is('deleted_at', null);

  if (error) {
    // 조회 실패가 권한을 넓히면 안 된다. 아무것도 못 켜는 쪽으로 닫는다.
    console.error('[connector-scope] 공식 비서 조회 실패', error);
    return { publicDataConnectors: new Set() };
  }

  return deriveCapabilityScope((data ?? []) as { capabilities: unknown }[], known);
}

/** 화면의 커넥터 선택지(/api/connectors). */
export async function getPersonalConnectorIds(departmentId: string): Promise<string[]> {
  const scope = await getCapabilityScope(departmentId);
  return [...scope.publicDataConnectors];
}
