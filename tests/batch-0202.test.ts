import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 정지·종료한 기관의 앱 외부 연동(Webhook) 호출은 차지 전에 403.
 * 예전 앞 검사는 기관 연동 스위치(0068)만 보아, 멈춘 기관의 호출도 차지(60초 간격·하루 100번·사용 횟수)를 쓴 뒤
 * 대화 준비의 429(기관 정지)로 거절됐고, 비동기 호출은 일괄 실행 묶음까지 만들었다. 스위치 문구('관리자가 꺼 두었습니다')와 가른다.
 */

const state = { org: null as Record<string, unknown> | null, selected: '' };
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = (cols: string) => { state.selected = cols; return b; };
      for (const n of ['eq', 'gt']) b[n] = () => b;
      b.maybeSingle = async () => ({ data: state.org ? { organization: state.org } : null, error: null });
      return b;
    },
  },
}));
vi.mock('@/lib/filter', () => ({ logSecurityEvent: vi.fn() }));

import { tokenOrgWebhooksDisabled } from '@/lib/apps/webhook-switch';
import { WEBHOOK_ORG_DISABLED, WEBHOOK_ORG_STOPPED, webhookOrgBlockMessage } from '@/lib/apps/webhook-spec';

beforeEach(() => { state.org = { app_webhooks_disabled_at: null, status: 'active' }; });

describe('tokenOrgWebhooksDisabled', () => {
  it('활성 기관·스위치 켜짐 → 쓸 수 있음', async () => {
    expect(await tokenOrgWebhooksDisabled('h', 0)).toBe(false);
    expect(state.selected).toBe('organization:organizations(app_webhooks_disabled_at, status)');
  });
  it('스위치 꺼짐 → true', async () => {
    state.org = { app_webhooks_disabled_at: '2026-11-19T00:00:00Z', status: 'active' };
    expect(await tokenOrgWebhooksDisabled('h', 0)).toBe(true);
  });
  it.each(['suspended', 'terminated'])('%s 기관 → stopped(스위치보다 먼저)', async (status) => {
    state.org = { app_webhooks_disabled_at: '2026-11-19T00:00:00Z', status };
    expect(await tokenOrgWebhooksDisabled('h', 0)).toBe('stopped');
  });
  it('쓸 수 없는 토큰은 기관을 알리지 않음', async () => {
    state.org = null;
    expect(await tokenOrgWebhooksDisabled('h', 0)).toBe(false);
  });
});

describe('문구', () => {
  it('정지·종료와 스위치를 가른다', () => {
    expect(webhookOrgBlockMessage('stopped')).toBe(WEBHOOK_ORG_STOPPED);
    expect(webhookOrgBlockMessage(true)).toBe(WEBHOOK_ORG_DISABLED);
  });
  it('호출·상태 묻기 두 곳이 차지 전에 같은 판정', () => {
    const hook = readFileSync('src/lib/apps/webhooks.ts', 'utf8');
    const at = hook.indexOf('const orgBlock = await deps.orgDisabled(');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(hook.indexOf('await deps.claim('));
    expect(readFileSync('src/lib/apps/webhook-status.ts', 'utf8')).toContain('if (orgBlock) return fail(403, webhookOrgBlockMessage(orgBlock));');
  });
});
