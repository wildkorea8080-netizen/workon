// src/lib/noda-vaults.ts
import { agentIdFromNodaTenant, type NodaTenantSummary } from '@/lib/noda';
import { orgTypeFromCommonTenant } from '@/lib/org-types';

/**
 * NODA 보관함 목록(`GET /tenants`)을 WORKON 장부와 맞댄다 — `npm run noda:purge-deleted`가 쓴다.
 *
 *   live     살아 있는 비서의 보관함
 *   deleted  지운(숨긴) 비서의 보관함 — 비워도 된다(비서를 지울 때 못 비운 것)
 *   orphan   DB에 비서 행이 아예 없는 보관함 — 비워도 된다(쓸 곳이 없다)
 *   common   공통 자료실(`workon-c-{열쇠}`) — 화면에서 관리한다, 스크립트는 건드리지 않는다
 *   other    `workon`(키 이름 그대로)·점검용 `workon-check`·모르는 이름 — 건드리지 않는다
 *
 * 순수 함수다(DB·NODA를 모른다). 비울 대상은 `deleted`·`orphan`뿐이다.
 */

export type VaultClass = 'live' | 'deleted' | 'orphan' | 'common' | 'other';

export interface VaultRow extends NodaTenantSummary {
  class: VaultClass;
  /** 비서 보관함이면 비서 id */
  agentId: string | null;
}

export function classifyVaults(
  tenants: NodaTenantSummary[],
  agents: { id: string; deleted_at: string | null }[],
): VaultRow[] {
  const byId = new Map(agents.map((a) => [a.id.toLowerCase(), a]));
  return tenants.map((t) => {
    const agentId = agentIdFromNodaTenant(t.tenant);
    if (agentId) {
      const agent = byId.get(agentId);
      const cls: VaultClass = !agent ? 'orphan' : agent.deleted_at ? 'deleted' : 'live';
      return { ...t, class: cls, agentId };
    }
    return { ...t, class: orgTypeFromCommonTenant(t.tenant) ? 'common' : 'other', agentId: null };
  });
}

/** 보관함 이름에서 비서 id를 뽑는다 — DB에서 그 비서들만 찾으려고 */
export function agentIdsOf(tenants: NodaTenantSummary[]): string[] {
  return Array.from(new Set(tenants.map((t) => agentIdFromNodaTenant(t.tenant)).filter((x): x is string => x !== null)));
}
