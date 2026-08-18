import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { connectorCatalog } from '@/lib/connectors';
import { getAccessScope, visibilityFilter } from '@/lib/department-scope';

/**
 * 직원이 자기 비서에 켤 수 있는 커넥터 범위.
 *
 * 커넥터를 켤지는 관리자가 정한다는 것이 이 제품의 설계다
 * (`agents.enabled_connectors`, 커넥터 단위로 켬). 그런데 직원이 만드는
 * '나만의 비서'에도 도구가 필요하다. 직원마다 아무 커넥터나 켤 수 있게 하면
 * 그 설계가 무너지고, 반대로 전면 금지하면 개인 비서가 반쪽이 된다.
 *
 * 그래서 **기관이 이미 쓰고 있는 커넥터**로 한정한다. 판정 근거는
 * "내가 볼 수 있는 공식 비서 중 하나라도 그 커넥터를 켜 두었는가"다.
 * 관리자가 그 커넥터를 이 기관에서 쓰기로 이미 판단했다는 뜻이기 때문이다.
 *
 * 별도의 기관 단위 허용 목록을 두지 않은 이유는, 관리자가 같은 결정을
 * 두 곳에서 반복하게 되고 둘이 어긋나면 어느 쪽이 맞는지 알 수 없어서다.
 */
export async function getPersonalConnectorIds(departmentId: string): Promise<string[]> {
  const configured = new Set(connectorCatalog().map((c) => c.id));
  if (configured.size === 0) return [];

  const scope = await getAccessScope(departmentId);

  const { data, error } = await supabaseAdmin
    .from('agents')
    .select('enabled_connectors')
    .or(visibilityFilter(scope))
    .eq('is_personal', false)
    .eq('is_active', true);

  if (error) {
    // 조회 실패가 권한을 넓히면 안 된다. 아무것도 못 켜는 쪽으로 닫는다.
    console.error('[connector-scope] 공식 비서 조회 실패', error);
    return [];
  }

  const allowed = new Set<string>();
  for (const row of (data ?? []) as { enabled_connectors: string[] | null }[]) {
    for (const id of row.enabled_connectors ?? []) {
      // 키가 빠져 목록에서 사라진 커넥터가 저장돼 있을 수 있다.
      if (configured.has(id)) allowed.add(id);
    }
  }

  return [...allowed];
}
