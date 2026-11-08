import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/** 기관 전체 외부 연동(Webhook) 스위치(0068) — 기관 전체 관리자만 끄고 켜고, 바뀔 때만 보안 로그, 호출 앞 검사는 쓸 수 있는 토큰만 본다 */
type Result = { data?: unknown; error?: { message: string } | null };
const state = vi.hoisted(() => ({ results: {} as Record<string, Result[]>, calls: [] as unknown[][], logged: [] as unknown[][], session: 'admin' as 'admin' | 'user' | null }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const method of ['select', 'update', 'eq', 'is', 'not', 'gt']) {
        q[method] = (...args: unknown[]) => { state.calls.push([table, method, ...args]); return q; };
      }
      const next = () => Promise.resolve({ data: null, error: null, ...(state.results[table]?.shift() ?? {}) });
      q.maybeSingle = () => next();
      q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => next().then(resolve, reject);
      return q;
    },
  },
}));
vi.mock('@/lib/filter', () => ({ logSecurityEvent: async (...args: unknown[]) => { state.logged.push(args); } }));
vi.mock('@/lib/auth', () => ({
  getServerAuthSession: async () => (state.session ? { user: { id: 'me', role: state.session === 'admin' ? 'ADMIN' : 'USER', departmentId: 'top' } } : null),
  isAdminSession: (s: { user?: { role?: string } } | null) => s?.user?.role === 'ADMIN',
}));
vi.mock('@/lib/actor-scope', () => ({
  getActorScope: async () => ({ userId: 'me', isAdmin: true, organizationId: 'org', departmentId: 'top', visibleDepartmentIds: ['top'], managedDepartmentIds: ['top', 'sub'], managesWholeOrganization: true }),
}));

import { readWebhookSwitch, setWebhookSwitch, tokenOrgWebhooksDisabled, webhookSwitchView } from '@/lib/apps/webhook-switch';
import { webhookView } from '@/lib/apps/webhook-spec';
import { OrgWebhookSwitch } from '@/components/admin/AppAutomationAdmin';
import { PUT } from '@/app/api/admin/app-automations/webhook-switch/route';
import { NextRequest } from 'next/server';
import type { ActorScope } from '@/lib/agent-permissions';

const whole: ActorScope = { userId: 'me', isAdmin: true, organizationId: 'org', departmentId: 'top', visibleDepartmentIds: ['top'], managedDepartmentIds: ['top', 'sub'], managesWholeOrganization: true } as ActorScope;
const admin = (scope: Partial<ActorScope> = {}) => ({ scope: { ...whole, ...scope } as ActorScope, userId: 'me', impersonating: false });
const OFF = { app_webhooks_disabled_at: '2026-11-08T00:00:00Z', app_webhooks_disabled_reason: '보안 점검 중' };
const NOW = Date.parse('2026-11-08T01:00:00Z');

beforeEach(() => { state.results = {}; state.calls = []; state.logged = []; state.session = 'admin'; });

describe('setWebhookSwitch', () => {
  it('끄기: 켜져 있을 때만(조건부) 시각·사유를 쓰고 보안 로그(high)를 남긴다', async () => {
    state.results.organizations = [{ data: [{ id: 'org' }] }, { data: OFF }];
    const result = await setWebhookSwitch(admin(), false, '보안 점검 중', NOW);
    expect(result).toEqual({ ok: true, data: { disabled: true, disabledAt: OFF.app_webhooks_disabled_at, reason: '보안 점검 중', canChange: true } });
    expect(state.calls).toContainEqual(['organizations', 'update', { app_webhooks_disabled_at: new Date(NOW).toISOString(), app_webhooks_disabled_reason: '보안 점검 중' }]);
    expect(state.calls).toContainEqual(['organizations', 'eq', 'id', 'org']);
    expect(state.calls).toContainEqual(['organizations', 'is', 'app_webhooks_disabled_at', null]);
    expect(state.logged).toEqual([['top', 'me', 'app_webhooks_org_disabled', { organization_id: 'org', reason: '보안 점검 중', impersonating: false }, 'high']]);
  });
  it('켜기: 꺼져 있을 때만 두 칸을 비우고 기록한다. 이미 그 상태면 바꾸지 않고 기록도 없다', async () => {
    state.results.organizations = [{ data: [{ id: 'org' }] }, { data: { app_webhooks_disabled_at: null, app_webhooks_disabled_reason: null } }];
    expect(await setWebhookSwitch(admin(), true, '점검 끝남', NOW)).toMatchObject({ ok: true, data: { disabled: false, reason: null } });
    expect(state.calls).toContainEqual(['organizations', 'update', { app_webhooks_disabled_at: null, app_webhooks_disabled_reason: null }]);
    expect(state.calls).toContainEqual(['organizations', 'not', 'app_webhooks_disabled_at', 'is', null]);
    expect(state.logged.map((l) => l[2])).toEqual(['app_webhooks_org_enabled']);
    state.logged = []; state.results.organizations = [{ data: [] }, { data: null }];
    expect(await setWebhookSwitch(admin(), true, '점검 끝남', NOW)).toMatchObject({ ok: true, data: { disabled: false } });
    expect(state.logged).toEqual([]);
  });
  it('기관 전체를 관리하지 않는 관리자·관리자 아님·소속 없음은 403 — DB를 바꾸지 않는다. 쓰기 실패는 503', async () => {
    for (const scope of [{ managesWholeOrganization: false }, { isAdmin: false }, { organizationId: null }] as Partial<ActorScope>[]) {
      expect(await setWebhookSwitch(admin(scope), false, '보안 점검 중', NOW)).toMatchObject({ ok: false, status: 403 });
    }
    expect(state.calls.filter((c) => c[1] === 'update')).toEqual([]);
    state.results.organizations = [{ error: { message: 'x' } }];
    expect(await setWebhookSwitch(admin(), false, '보안 점검 중', NOW)).toMatchObject({ ok: false, status: 503 });
    expect(state.logged).toEqual([]);
  });
});

describe('읽기·호출 앞 검사', () => {
  it('readWebhookSwitch — 칸이 없으면(적용 전) 던지고, 끈 동안만 사유를 돌려준다', async () => {
    state.results.organizations = [{ data: OFF }, { data: { app_webhooks_disabled_at: null, app_webhooks_disabled_reason: '남은 글' } }, { error: { message: 'column does not exist' } }];
    expect(await readWebhookSwitch('org')).toEqual({ disabled: true, disabledAt: OFF.app_webhooks_disabled_at, reason: '보안 점검 중' });
    expect(await readWebhookSwitch('org')).toEqual({ disabled: false, disabledAt: null, reason: null });
    await expect(readWebhookSwitch('org')).rejects.toThrow('column does not exist');
  });
  it('tokenOrgWebhooksDisabled — 활성·안 만료 토큰만 기관을 보고(무효 토큰은 거짓), 읽지 못하면 던진다', async () => {
    state.results.app_webhooks = [{ data: { organization: { app_webhooks_disabled_at: OFF.app_webhooks_disabled_at } } }, { data: { organization: [{ app_webhooks_disabled_at: null }] } }, { data: null }, { error: { message: 'down' } }];
    expect(await tokenOrgWebhooksDisabled('h'.repeat(64), NOW)).toBe(true);
    expect(await tokenOrgWebhooksDisabled('h'.repeat(64), NOW)).toBe(false);
    expect(await tokenOrgWebhooksDisabled('h'.repeat(64), NOW)).toBe(false);
    await expect(tokenOrgWebhooksDisabled('h'.repeat(64), NOW)).rejects.toThrow('down');
    expect(state.calls).toContainEqual(['app_webhooks', 'eq', 'token_hash', 'h'.repeat(64)]);
    expect(state.calls).toContainEqual(['app_webhooks', 'eq', 'status', 'active']);
    expect(state.calls).toContainEqual(['app_webhooks', 'gt', 'expires_at', new Date(NOW).toISOString()]);
  });
  it('직원 보기 — 쓰는 중인 연동에만 blockedByOrg, 관리자 보기의 canChange는 기관 전체 관리자만', () => {
    const row = { id: 'w', agent_id: 'a', app_version: 1, name: 'n', token_prefix: 'wo_wh_abcdef', status: 'active', expires_at: '2099-01-01T00:00:00Z', revoked_at: null, last_used_at: null, use_count: 0, last_status: null, last_error: null, last_conversation_id: null, created_at: '2026-11-01T00:00:00Z' };
    expect(webhookView(row, '앱', NOW, true).blockedByOrg).toBe(true);
    expect(webhookView(row, '앱', NOW).blockedByOrg).toBe(false);
    expect(webhookView({ ...row, expires_at: '2026-01-01T00:00:00Z' }, '앱', NOW, true).blockedByOrg).toBe(false);
    expect(webhookSwitchView({ disabled: false, disabledAt: null, reason: null }, { ...whole, managesWholeOrganization: false } as ActorScope).canChange).toBe(false);
  });
});

describe('라우트·화면·마이그레이션', () => {
  const put = (body: unknown) => PUT(new NextRequest('http://localhost/api/admin/app-automations/webhook-switch', { method: 'PUT', body: JSON.stringify(body) }));
  it('PUT — 인증 401·관리자 아님 403·꼴 400(사유 5자 미만 포함), 맞으면 스위치를 바꾼다', async () => {
    state.session = null; expect((await put({ enabled: false, reason: '보안 점검 중' })).status).toBe(401);
    state.session = 'user'; expect((await put({ enabled: false, reason: '보안 점검 중' })).status).toBe(403);
    state.session = 'admin';
    expect((await put({ enabled: 'no', reason: '보안 점검 중' })).status).toBe(400);
    expect((await put({ enabled: false, reason: '짧음' })).status).toBe(400);
    expect(state.calls).toEqual([]);
    state.results.organizations = [{ data: [{ id: 'org' }] }, { data: OFF }];
    const res = await put({ enabled: false, reason: '  보안 점검 중  ' });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ disabled: true, canChange: true });
    expect(state.logged[0][3]).toMatchObject({ reason: '보안 점검 중' });
  });
  it('관리자 화면 — 꺼짐이면 끈 때·사유와 다시 켜기, 켜짐이면 끄기, 바꿀 수 없는 관리자에게는 단추 없이 안내', () => {
    const render = (view: Parameters<typeof OrgWebhookSwitch>[0]['view']) => renderToStaticMarkup(createElement(OrgWebhookSwitch, { view, busy: false, onToggle: () => {} }));
    const off = render({ disabled: true, disabledAt: OFF.app_webhooks_disabled_at, reason: '보안 점검 중', canChange: true });
    expect(off).toContain('기관 전체 외부 연동이 꺼져 있습니다'); expect(off).toContain('2026-11-08 09:00에 껐습니다 — 보안 점검 중'); expect(off).toContain('다시 켜기');
    const on = render({ disabled: false, disabledAt: null, reason: null, canChange: true });
    expect(on).toContain('기관 전체 끄기');
    const viewer = render({ disabled: false, disabledAt: null, reason: null, canChange: false });
    expect(viewer).not.toContain('<button'); expect(viewer).toContain('최상위 부서 소속');
  });
  it('0068 — 칸 둘 추가만·짝 CHECK·사유 길이, 감사 화면에 한국어 이름', () => {
    const sql = readFileSync('supabase/migrations/0068_org_webhook_switch.sql', 'utf8');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS app_webhooks_disabled_at timestamptz');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS app_webhooks_disabled_reason text');
    expect(sql).toContain('(app_webhooks_disabled_at IS NULL) = (app_webhooks_disabled_reason IS NULL)');
    expect(sql).not.toMatch(/DROP|DELETE/);
    const audit = readFileSync('src/app/api/admin/audit-logs/route.ts', 'utf8');
    expect(audit).toContain("app_webhooks_org_disabled: '기관 외부 연동 끄기(관리자)'");
    expect(audit).toContain("app_webhooks_org_enabled: '기관 외부 연동 켜기(관리자)'");
  });
});
