import { describe, expect, it } from 'vitest';
import { agentIdsOf, classifyVaults } from '@/lib/noda-vaults';
import { nodaTenant, type NodaTenantSummary } from '@/lib/noda';

/** NODA 보관함 목록을 비서 장부와 맞대기 — 비울 대상은 지운 비서·DB에 없는 비서뿐이다 */

const LIVE = '11111111-2222-4333-8444-555555555555';
const GONE = '21111111-2222-4333-8444-555555555555';
const GHOST = '31111111-2222-4333-8444-555555555555';

const vault = (tenant: string, over: Partial<NodaTenantSummary> = {}): NodaTenantSummary => ({
  tenant, files: 1, bytes: 10, updated: null, receiving: 0, failed: 0, access: 'public', ...over,
});

describe('classifyVaults', () => {
  const tenants = [
    vault(nodaTenant(LIVE)),
    vault(nodaTenant(GONE)),
    vault(nodaTenant(GHOST)),
    vault('workon-c-local'),
    vault('workon'),
    vault('workon-check'),
    vault('workon-zzz'),
  ];
  const agents = [
    { id: LIVE, deleted_at: null },
    { id: GONE.toUpperCase(), deleted_at: '2026-10-20T00:00:00Z' },
  ];

  it('살아 있는 비서·지운 비서·DB에 없는 비서·공통 자료실·그 밖으로 가른다', () => {
    const rows = classifyVaults(tenants, agents);
    expect(rows.map((r) => [r.tenant === 'workon' ? 'workon' : r.class, r.agentId])).toEqual([
      ['live', LIVE],
      ['deleted', GONE],
      ['orphan', GHOST],
      ['common', null],
      ['workon', null],
      ['other', null],
      ['other', null],
    ]);
    expect(rows[4].class).toBe('other');
  });

  it('보관함의 숫자·권한 상태는 그대로 실린다', () => {
    const [row] = classifyVaults([vault(nodaTenant(LIVE), { receiving: 2, failed: 1, access: 'broken' })], agents);
    expect(row).toMatchObject({ receiving: 2, failed: 1, access: 'broken', class: 'live' });
  });

  it('agentIdsOf — 비서 보관함 이름에서만 비서 id를 뽑고 겹치면 하나로', () => {
    expect(agentIdsOf([...tenants, vault(nodaTenant(LIVE))])).toEqual([LIVE, GONE, GHOST]);
  });
});
