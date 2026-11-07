import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

/** 기관 관리자 '기본 비서·앱 세트'(2026-11-07) — 아직 없는 기본 비서·앱을 골라 설치 */

const state = {
  admin: true,
  whole: true,
  orgType: '공공기관' as string | null,
  logs: [] as Array<Record<string, unknown>>,
};
vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => ({ user: { id: 'u1', role: 'ADMIN', departmentId: 'd-top' } }), isAdminSession: () => state.admin }));
vi.mock('@/lib/actor-scope', () => ({
  getActorScope: async () => ({ userId: 'u1', isAdmin: state.admin, departmentId: 'd-top', organizationId: 'o1', visibleDepartmentIds: ['d-top'], managedDepartmentIds: ['d-top'], managesWholeOrganization: state.whole }),
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === 'organizations') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { type: state.orgType }, error: null }) }) }) };
      if (table === 'security_logs') return { insert: async (row: Record<string, unknown>) => { state.logs.push(row); return { error: null }; } };
      throw new Error(`unexpected table ${table}`);
    },
  },
}));
const lib = vi.hoisted(() => ({ status: vi.fn(), install: vi.fn(), update: vi.fn() }));
vi.mock('@/lib/preset-install-admin', async (original) => ({ ...(await original<typeof import('@/lib/preset-install-admin')>()), presetStatus: lib.status, installChosenPresets: lib.install, updateChosenPresets: lib.update }));

import { GET, POST } from '@/app/api/admin/preset-agents/route';
const { installChosenPresets: realInstall, presetStatusItems, presetState, updateChosenPresets: realUpdate } = await vi.importActual<typeof import('@/lib/preset-install-admin')>('@/lib/preset-install-admin');
import type { PresetRow } from '@/lib/preset-install-admin';
import type { AgentPreset } from '@/lib/agent-presets';
import { presetSettingsPatch } from '@/lib/install-presets';
import { PUBLIC_SECTOR_FORM_PRESETS, PUBLIC_SECTOR_PRESETS } from '@/lib/agent-presets';
import PresetSetPanel, { installSummary, missingPresets, outdatedPresets, updateSummary } from '@/components/admin/PresetSetPanel';

const post = (body: unknown) => POST(new Request('http://x/api/admin/preset-agents', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  state.admin = true; state.whole = true; state.orgType = '공공기관'; state.logs = [];
  lib.status.mockReset(); lib.install.mockReset(); lib.update.mockReset();
});

describe('설치 판정(installChosenPresets)', () => {
  const app = PUBLIC_SECTOR_FORM_PRESETS[0].name;
  const chat = PUBLIC_SECTOR_PRESETS[0].name;

  it('세트에 없는 이름·빈 목록은 거절하고 설치 함수를 부르지 않는다', async () => {
    const install = vi.fn();
    for (const names of [[], ['없는 비서'], [app, '없는 비서']]) {
      expect(await realInstall({ organizationId: 'o1', organizationType: null, departmentId: 'd', names }, { existing: async () => new Set(), install })).toMatchObject({ ok: false });
    }
    expect(install).not.toHaveBeenCalled();
  });

  it('기관 전체에 이미 있는 이름은 건너뛰고 없는 것만 고른 것으로 설치한다 — 무엇이 깔렸는지는 다시 읽어 정한다', async () => {
    const calls: string[][] = [];
    const existing = vi.fn(async (_o: string, names: string[]) => { calls.push(names); return calls.length === 1 ? new Set([chat]) : new Set([app]); });
    const install = vi.fn(async () => ({ installed: 1, skipped: 1, categories: 0, updated: 0, preserved: [] }));
    const second = PUBLIC_SECTOR_FORM_PRESETS[1].name;
    const r = await realInstall({ organizationId: 'o1', organizationType: null, departmentId: 'd-top', names: [chat, app, second, app] }, { existing, install });
    expect(install).toHaveBeenCalledWith('o1', 'd-top', null, { only: [app, second] });
    expect(r).toEqual({ ok: true, installed: [app], failed: [second], skipped: [chat], result: expect.any(Object) });
  });

  it('모두 있으면 설치 함수를 부르지 않는다', async () => {
    const install = vi.fn();
    const r = await realInstall({ organizationId: 'o1', organizationType: null, departmentId: 'd', names: [chat] }, { existing: async () => new Set([chat]), install });
    expect(r).toEqual({ ok: true, installed: [], failed: [], skipped: [chat], result: null });
    expect(install).not.toHaveBeenCalled();
  });

  it('목록 한 줄 — 입력형 앱과 비서를 가르고 설치 여부·상태를 붙인다', () => {
    const items = presetStatusItems([PUBLIC_SECTOR_PRESETS[0], PUBLIC_SECTOR_FORM_PRESETS[0]], [installedRow(PUBLIC_SECTOR_PRESETS[0])]);
    expect(items.map((i) => [i.kind, i.installed, i.state])).toEqual([['chat', true, 'current'], ['form', false, 'missing']]);
    expect(Object.keys(items[0]).sort()).toEqual(['category', 'description', 'icon', 'installed', 'kind', 'name', 'state']);
  });
});

/** 지금 세트 그대로 깔린 행(jsonb처럼 열쇠 순서를 뒤집어 둔다) */
function installedRow(preset: AgentPreset, over: Partial<PresetRow> = {}): PresetRow {
  const patch = presetSettingsPatch(preset, {}) as Record<string, unknown>;
  const flip = (v: unknown): unknown => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as object).reverse().map(([k, x]) => [k, flip(x)])) : Array.isArray(v) ? v.map(flip) : v);
  return {
    id: `id-${preset.name}`, name: preset.name, tier: 'official', version: 3, updated_by: null,
    description: preset.description, system_prompt: preset.systemPrompt, icon: preset.icon, color: preset.color, category: preset.category,
    capabilities: flip(patch.capabilities), app_definition: flip(preset.appDefinition ?? null), ...over,
  };
}

describe('갱신 판정·갱신(updateChosenPresets)', () => {
  const app = PUBLIC_SECTOR_FORM_PRESETS[0];
  const chat = PUBLIC_SECTOR_PRESETS[0];

  it('상태 — 없음·같음(열쇠 순서 무관)·내용이 다름·관리자가 고침·이름이 여럿·공식 아님', () => {
    expect(presetState(app, [])).toBe('missing');
    expect(presetState(app, [installedRow(app)])).toBe('current');
    expect(presetState(chat, [installedRow(chat)])).toBe('current');
    expect(presetState(app, [installedRow(app, { system_prompt: '옛 지시문' })])).toBe('outdated');
    expect(presetState(app, [installedRow(app, { app_definition: { ...app.appDefinition!, output: 'bullets' } })])).toBe('outdated');
    expect(presetState(chat, [installedRow(chat, { capabilities: {} })])).toBe('outdated');
    expect(presetState(app, [installedRow(app, { system_prompt: '기관에 맞춰 고침', updated_by: 'admin' })])).toBe('edited');
    expect(presetState(app, [installedRow(app, { updated_by: 'admin' })])).toBe('current');
    expect(presetState(app, [installedRow(app), installedRow(app, { id: 'other' })])).toBe('manual');
    expect(presetState(app, [installedRow(app, { tier: 'department', system_prompt: 'x' })])).toBe('manual');
  });

  it('outdated만 지금 세트 내용으로 판을 남겨 갱신하고, 나머지는 건너뛴다. 저장 실패는 실패로', async () => {
    const second = PUBLIC_SECTOR_FORM_PRESETS[1]; const third = PUBLIC_SECTOR_FORM_PRESETS[2];
    const rows = [installedRow(app, { system_prompt: '옛' }), installedRow(second, { system_prompt: '고침', updated_by: 'admin' }), installedRow(third, { description: '옛' }), installedRow(chat)];
    const save = vi.fn(async (id: string) => (id === `id-${third.name}` ? { ok: false as const, reason: 'conflict' as const, currentVersion: 4 } : { ok: true as const, version: 4 }));
    const r = await realUpdate({ organizationId: 'o1', organizationType: null, names: [app.name, second.name, third.name, chat.name] }, { rows: async () => rows, save });
    expect(r).toEqual({ ok: true, updated: [app.name], skipped: [second.name, chat.name], failed: [third.name] });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0]).toEqual([`id-${app.name}`, 3, presetSettingsPatch(app, rows[0].capabilities), null, 'preset_update']);
  });

  it('세트에 없는 이름·빈 목록은 거절하고 아무것도 저장하지 않는다', async () => {
    const save = vi.fn();
    for (const names of [[], ['없는 앱']]) expect(await realUpdate({ organizationId: 'o1', organizationType: null, names }, { rows: async () => [], save })).toMatchObject({ ok: false });
    expect(save).not.toHaveBeenCalled();
  });
});

describe('라우트', () => {
  it('관리자가 아니면 GET·POST 모두 403', async () => {
    state.admin = false;
    expect((await GET()).status).toBe(403);
    expect((await post({ names: ['a'] })).status).toBe(403);
    expect(lib.install).not.toHaveBeenCalled();
  });

  it('GET은 목록과 설치 가능 여부(기관 전체 관리자인가)', async () => {
    lib.status.mockResolvedValue([{ name: 'a', installed: false }]);
    state.whole = false;
    const body = await (await GET()).json();
    expect(body).toEqual({ ok: true, data: { items: [{ name: 'a', installed: false }], canInstall: false } });
    expect(lib.status).toHaveBeenCalledWith('o1', '공공기관');
  });

  it('POST는 기관 전체 관리자만, 이름 목록 꼴을 보고, 설치하면 보안 기록을 남긴다', async () => {
    state.whole = false;
    expect((await post({ names: ['a'] })).status).toBe(403);
    state.whole = true;
    for (const bad of [null, {}, { names: 'a' }, { names: [1] }, { names: Array.from({ length: 51 }, () => 'a') }]) expect((await post(bad)).status).toBe(400);
    expect(lib.install).not.toHaveBeenCalled();

    lib.install.mockResolvedValue({ ok: true, installed: ['사업 위험 검토'], failed: [], skipped: ['안내 메일 초안'], result: {} });
    const body = await (await post({ names: ['사업 위험 검토', '안내 메일 초안'] })).json();
    expect(lib.install).toHaveBeenCalledWith({ organizationId: 'o1', organizationType: '공공기관', departmentId: 'd-top', names: ['사업 위험 검토', '안내 메일 초안'] });
    expect(body).toEqual({ ok: true, data: { installed: ['사업 위험 검토'], skipped: ['안내 메일 초안'], failed: [] } });
    expect(state.logs).toEqual([{ department_id: 'd-top', user_id: 'u1', event_type: 'preset_agents_installed', severity: 'low', details: { names: ['사업 위험 검토'], failed: [] } }]);
  });

  it('mode=update는 갱신 함수로, 갱신한 것이 있으면 보안 기록(preset_agents_updated) — 모르는 mode는 400', async () => {
    expect((await post({ names: ['a'], mode: 'delete' })).status).toBe(400);
    lib.update.mockResolvedValue({ ok: true, updated: ['사업 위험 검토'], skipped: [], failed: ['안내 메일 초안'] });
    const body = await (await post({ names: ['사업 위험 검토', '안내 메일 초안'], mode: 'update' })).json();
    expect(lib.update).toHaveBeenCalledWith({ organizationId: 'o1', organizationType: '공공기관', names: ['사업 위험 검토', '안내 메일 초안'] });
    expect(lib.install).not.toHaveBeenCalled();
    expect(body).toEqual({ ok: true, data: { updated: ['사업 위험 검토'], skipped: [], failed: ['안내 메일 초안'] } });
    expect(state.logs).toEqual([{ department_id: 'd-top', user_id: 'u1', event_type: 'preset_agents_updated', severity: 'low', details: { names: ['사업 위험 검토'], failed: ['안내 메일 초안'] } }]);
    state.whole = false;
    expect((await post({ names: ['a'], mode: 'update' })).status).toBe(403);
  });

  it('세트 밖 이름은 400, 설치한 것이 없으면 기록을 남기지 않는다', async () => {
    lib.install.mockResolvedValue({ ok: false, message: '기본 세트에 있는 비서·앱만 고를 수 있습니다.' });
    expect((await post({ names: ['x'] })).status).toBe(400);
    lib.install.mockResolvedValue({ ok: true, installed: [], failed: [], skipped: ['a'], result: null });
    expect((await post({ names: ['a'] })).status).toBe(200);
    expect(state.logs).toEqual([]);
  });
});

describe('화면', () => {
  it('없는 것만 고를 수 있고, 결과 문구는 설치·건너뜀·실패를 나눠 말한다', () => {
    expect(missingPresets([{ name: 'a', installed: true }, { name: 'b', installed: false }] as never).map((i) => i.name)).toEqual(['b']);
    expect(installSummary({ installed: ['a', 'b'], skipped: ['c'], failed: ['d'] })).toBe('2개를 설치했습니다 · 이미 있는 1개는 건너뛰었습니다 · 설치하지 못함: d');
    expect(installSummary({ installed: [], skipped: [], failed: [] })).toBe('0개를 설치했습니다');
  });

  it('갱신할 수 있는 것은 outdated만, 결과 문구는 바꿈·건너뜀·실패를 나눠 말한다', () => {
    expect(outdatedPresets([{ name: 'a', state: 'outdated' }, { name: 'b', state: 'edited' }, { name: 'c', state: 'current' }] as never).map((i) => i.name)).toEqual(['a']);
    expect(updateSummary({ updated: ['a'], skipped: ['b'], failed: ['c'] })).toBe('1개를 새 내용으로 바꿨습니다 · 바꿀 필요가 없거나 바꾸지 않는 1개는 건너뛰었습니다 · 바꾸지 못함: c — 그 사이 다른 분이 고쳤을 수 있습니다');
  });

  it('처음 그릴 때는 목록을 받기 전이라 아무것도 그리지 않는다', () => {
    expect(renderToStaticMarkup(createElement(PresetSetPanel))).toBe('');
  });

  it('관리 화면에 패널이 들어간다', async () => {
    const { readFileSync } = await import('fs');
    expect(readFileSync('src/app/admin/agents/page.tsx', 'utf8')).toContain('<PresetSetPanel />');
  });
});
