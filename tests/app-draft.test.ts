import { readdirSync, readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/** 입력형 앱의 시험 판(0053) — 저장·배포·버리기 라우트와 순수 규칙. DB는 흉내 내고 조건(판·저장 시각)을 본다 */

const AGENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SAVED = '2026-11-04T12:00:00.000Z';
const form = { schemaVersion: 1, fields: [{ key: 'memo', label: '메모', type: 'text', required: true }], output: 'bullets' };

const state = vi.hoisted(() => ({
  canEdit: true,
  version: 3,
  tier: 'department',
  row: null as Record<string, unknown> | null,
  updated: [] as unknown[],
  updateRows: 1,
  filters: [] as unknown[][],
  saveResult: { ok: true, version: 4 } as Record<string, unknown>,
  saves: [] as unknown[][],
  scopeError: null as string | null,
}));

vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => ({ user: { id: 'u1' } }) }));
vi.mock('@/lib/actor-scope', () => ({ getActorScope: async () => ({ userId: 'u1', departmentId: 'd1', organizationId: 'o1' }) }));
vi.mock('@/lib/agent-permissions', () => ({ canEditAgent: () => state.canEdit }));
vi.mock('@/lib/agent-store', () => ({
  loadAgentAccess: async () => ({ id: AGENT, tier: state.tier, version: state.version, deleted_at: null }),
  saveAgentSettings: async (...args: unknown[]) => { state.saves.push(args); return state.saveResult; },
  saveFailureResponse: (r: { reason: string }) => ({ message: `저장 실패 ${r.reason}`, status: r.reason === 'conflict' ? 409 : 500 }),
}));
vi.mock('@/lib/agent-route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent-route-helpers')>();
  return { ...actual, knownIds: () => ({ knownConnectorIds: ['law'], knownModelIds: [] }), checkCapabilityScope: async () => state.scopeError };
});
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from() {
      let op = 'select';
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.update = (v: unknown) => { op = 'update'; state.updated.push(v); return q; };
      for (const m of ['eq', 'is']) q[m] = (...args: unknown[]) => { state.filters.push([m, ...args]); return q; };
      q.single = async () => ({ data: state.row, error: null });
      q.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(op === 'update' ? { data: Array.from({ length: state.updateRows }, () => ({ id: AGENT })), error: null } : { data: state.row, error: null }).then(resolve);
      return q;
    },
  },
}));

import { PUT, POST, DELETE } from '@/app/api/agents/[id]/app-draft/route';
import { draftPatch, readAppDraft, savesAsDraft, withDraftSettings, withoutAppDraft } from '@/lib/apps/draft';
import AppDraftPanel, { kstTime } from '@/components/apps/AppDraftPanel';

const params = { params: { id: AGENT } };
const request = (method: string, body?: unknown, query = '') => new (require('next/server').NextRequest)(`http://x/api/agents/${AGENT}/app-draft${query}`, { method, ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });
const settings = { name: '여비 점검', description: '설명', category: '총무', system_prompt: '지시문', app_definition: form, capabilities: {} };
const draft = (over: Record<string, unknown> = {}) => ({ settings: { ...settings, capabilities: {} }, base_version: 3, saved_by: 'u1', saved_at: SAVED, ...over });

beforeEach(() => {
  Object.assign(state, { canEdit: true, version: 3, tier: 'department', row: { agent_type: 'chat' }, updated: [], updateRows: 1, filters: [], saveResult: { ok: true, version: 4 }, saves: [], scopeError: null });
});

describe('순수 규칙', () => {
  it('저장된 시험 판은 꼴과 입력 설정을 다시 검사해 읽는다', () => {
    expect(readAppDraft(draft())).toMatchObject({ base_version: 3, saved_at: SAVED, settings: { name: '여비 점검', app_definition: { output: 'bullets' } } });
    for (const bad of [null, 'x', draft({ base_version: '3' }), draft({ saved_at: 'nope' }), draft({ settings: { ...settings, name: ' ' } }), draft({ settings: { ...settings, app_definition: { schemaVersion: 1, fields: [], output: 'bullets' } } })]) {
      expect(readAppDraft(bad)).toBeNull();
    }
  });
  it('부서·공식 앱만 시험 판으로, 실행 때는 지금 판 위에 덮고 목록에서는 뗀다', () => {
    expect([savesAsDraft('department'), savesAsDraft('official'), savesAsDraft('personal'), savesAsDraft(undefined)]).toEqual([true, true, false, false]);
    const d = readAppDraft(draft())!;
    expect(withDraftSettings({ id: AGENT, version: 3, name: '옛 이름', system_prompt: '옛 지시', model_id: 'm', tier: 'department' }, d)).toEqual({ id: AGENT, version: 3, name: '여비 점검', system_prompt: '지시문', model_id: 'm', tier: 'department', app_definition: d.settings.app_definition, capabilities: {} });
    expect(Object.keys(draftPatch(d)).sort()).toEqual(['app_definition', 'capabilities', 'category', 'description', 'name', 'system_prompt']);
    expect(withoutAppDraft({ id: AGENT, app_draft: draft(), name: 'a' })).toEqual({ id: AGENT, name: 'a' });
  });
});

describe('저장(PUT)', () => {
  it('검사한 설정을 지금 판·불러온 시험 판이 그대로일 때만 저장한다(판·시험 판 없음 조건)', async () => {
    const out = await json(await PUT(request('PUT', { ...settings, base_version: 3, draft_saved_at: null }), params));
    expect(out.status).toBe(200);
    expect(out.body.data.app_draft).toMatchObject({ base_version: 3, saved_by: 'u1', settings: { name: '여비 점검', system_prompt: '지시문', app_definition: { output: 'bullets' } } });
    expect(state.filters).toEqual(expect.arrayContaining([['eq', 'version', 3], ['is', 'app_draft', null]]));
    // 다시 저장하면 불러온 시험 판의 저장 시각으로 맞춘다
    state.filters = [];
    await PUT(request('PUT', { ...settings, base_version: 3, draft_saved_at: SAVED }), params);
    expect(state.filters).toContainEqual(['eq', 'app_draft->>saved_at', SAVED]);
  });
  it('모델·운영 값은 받지 않고, 입력 설정이 없거나 범위 밖 능력·낡은 판·다른 사람의 시험 판이면 거절한다', async () => {
    await PUT(request('PUT', { ...settings, model_id: 'x', is_published: true, base_version: 3, draft_saved_at: null }), params);
    expect(JSON.stringify(state.updated[0])).not.toContain('model_id');
    expect(JSON.stringify(state.updated[0])).not.toContain('is_published');
    state.updated = [];
    expect((await PUT(request('PUT', { ...settings, app_definition: null, base_version: 3, draft_saved_at: null }), params)).status).toBe(400);
    expect((await PUT(request('PUT', { ...settings, base_version: 3 }), params)).status).toBe(400);
    state.scopeError = '범위 밖';
    expect((await PUT(request('PUT', { ...settings, base_version: 3, draft_saved_at: null }), params)).status).toBe(403);
    state.scopeError = null;
    expect((await PUT(request('PUT', { ...settings, base_version: 2, draft_saved_at: null }), params)).status).toBe(409);
    state.updateRows = 0;
    expect(await json(await PUT(request('PUT', { ...settings, base_version: 3, draft_saved_at: null }), params))).toMatchObject({ status: 409, body: { error: { message: expect.stringContaining('다른 사람이 먼저') } } });
    expect(state.updated).toHaveLength(1);
  });
  it('고칠 수 없으면 403, 외부 연결형은 400', async () => {
    state.canEdit = false;
    expect((await PUT(request('PUT', { ...settings, base_version: 3, draft_saved_at: null }), params)).status).toBe(403);
    state.canEdit = true; state.row = { agent_type: 'link' };
    expect((await PUT(request('PUT', { ...settings, base_version: 3, draft_saved_at: null }), params)).status).toBe(400);
    expect(state.updated).toEqual([]);
  });
});

describe('배포(POST)', () => {
  const current = (over: Record<string, unknown> = {}) => ({ version: 3, app_draft: draft(), name: '옛 이름', description: '설명', category: '총무', system_prompt: '옛 지시', app_definition: form, capabilities: {}, ...over });
  it('바뀐 칸만 save_agent로 올리고(시험 판 표시) 같은 시험 판일 때만 비운다', async () => {
    state.row = current();
    const out = await json(await POST(request('POST', { draft_saved_at: SAVED }), params));
    expect(out.status).toBe(200);
    expect(state.saves).toHaveLength(1);
    const [id, base, patch, actor, kind, detail] = state.saves[0] as [string, number, Record<string, unknown>, string, string, Record<string, unknown>];
    expect([id, base, actor, kind, detail]).toEqual([AGENT, 3, 'u1', 'settings', { from_draft: SAVED }]);
    expect(Object.keys(patch).sort()).toEqual(['name', 'system_prompt']);
    expect(state.updated).toContainEqual({ app_draft: null });
    expect(state.filters).toContainEqual(['eq', 'app_draft->>saved_at', SAVED]);
    expect(out.body.meta).toEqual({ version: 4, changed: ['name', 'system_prompt'] });
  });
  it('시험 판이 없거나 바뀌었거나 그 사이 배포됐으면 409, save_agent 충돌도 409 — 비우지 않는다', async () => {
    state.row = current({ app_draft: null });
    expect((await POST(request('POST', { draft_saved_at: SAVED }), params)).status).toBe(409);
    state.row = current({ app_draft: draft({ saved_at: '2026-11-04T13:00:00.000Z' }) });
    expect((await POST(request('POST', { draft_saved_at: SAVED }), params)).status).toBe(409);
    state.row = current({ version: 4 });
    expect(await json(await POST(request('POST', { draft_saved_at: SAVED }), params))).toMatchObject({ status: 409, body: { error: { message: expect.stringContaining('새로 배포') } } });
    state.row = current(); state.saveResult = { ok: false, reason: 'conflict', currentVersion: 4 };
    expect((await POST(request('POST', { draft_saved_at: SAVED }), params)).status).toBe(409);
    expect(state.updated).toEqual([]);
    expect((await POST(request('POST', {}), params)).status).toBe(400);
  });
  it('배포 때 능력 범위를 다시 보고, 바뀐 것이 없으면 판을 올리지 않고 시험 판만 비운다', async () => {
    state.row = current(); state.scopeError = '그 사이 범위가 줄었습니다';
    expect((await POST(request('POST', { draft_saved_at: SAVED }), params)).status).toBe(403);
    state.scopeError = null;
    state.row = current({ name: '여비 점검', system_prompt: '지시문' });
    expect(await json(await POST(request('POST', { draft_saved_at: SAVED }), params))).toMatchObject({ status: 200, body: { meta: { version: 3, changed: [] } } });
    expect(state.saves).toEqual([]);
    expect(state.updated).toContainEqual({ app_draft: null });
  });
});

describe('버리기(DELETE)', () => {
  it('불러온 시험 판일 때만 비우고, 없거나 바뀌었으면 409', async () => {
    expect((await DELETE(request('DELETE', undefined, `?saved_at=${encodeURIComponent(SAVED)}`), params)).status).toBe(200);
    expect(state.filters).toContainEqual(['eq', 'app_draft->>saved_at', SAVED]);
    expect((await DELETE(request('DELETE'), params)).status).toBe(400);
    state.updateRows = 0;
    expect((await DELETE(request('DELETE', undefined, `?saved_at=${encodeURIComponent(SAVED)}`), params)).status).toBe(409);
  });
});

describe('화면·연결(원본 확인)', () => {
  it('시험 판 칸 — 나만의 앱은 그리지 않고, 낡은 시험 판은 배포를 막는다', () => {
    const d = readAppDraft(draft())!;
    const none = { tier: 'department', version: 3, agentId: AGENT, busy: false, onPublish: () => {}, onDiscard: () => {} };
    expect(renderToStaticMarkup(createElement(AppDraftPanel, { ...none, tier: 'personal', draft: d }))).toBe('');
    expect(renderToStaticMarkup(createElement(AppDraftPanel, { ...none, draft: null }))).toContain('시험 판</strong>으로 저장됩니다');
    const page = renderToStaticMarkup(createElement(AppDraftPanel, { ...none, draft: d }));
    expect(page).toContain(`href="/apps/run?agent=${AGENT}&amp;draft=1"`);
    expect(page).toContain(`${kstTime(SAVED)} 저장, 판 3 기준`);
    expect(page).not.toContain('disabled=""');
    const stale = renderToStaticMarkup(createElement(AppDraftPanel, { ...none, version: 4, draft: d }));
    expect(stale).toContain('배포할 수 없으니');
    expect(stale).toMatch(/<button type="button" disabled="" class="rounded-lg[^"]*">배포<\/button>/);
    expect(kstTime(SAVED)).toBe('2026-11-04 21:00');
  });
  it('목록 라우트는 시험 판을 떼고, 실행 화면은 시험 판 표시를 보내며 예약·연동을 숨긴다', () => {
    const list = readFileSync('src/app/api/agents/route.ts', 'utf8');
    expect(list.match(/data: listRows\(agents\)/g)).toHaveLength(4);
    expect(readFileSync('src/app/api/agents/favorite/route.ts', 'utf8')).toContain('map(withoutAppDraft)');
    const run = readFileSync('src/app/apps/run/page.tsx', 'utf8');
    expect(run).toContain('...(draftSavedAt ? { app_draft: draftSavedAt } : {})');
    expect(run).toContain('{!draftSavedAt && <AppScheduleForm');
    expect(run).toContain('{!draftSavedAt && <AppWebhookForm');
    const builder = readFileSync('src/app/apps/builder/page.tsx', 'utf8');
    expect(builder).toContain("agent && savesAsDraft(agent.tier)");
    expect(builder).toContain('/app-draft`, { method: \'PUT\'');
  });
  it('마이그레이션은 칸 하나와 꼴 CHECK, 판 사본에는 들어가지 않는다', () => {
    const sql = readFileSync('supabase/migrations/0053_app_drafts.sql', 'utf8');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS app_draft jsonb');
    expect(sql).toContain("COALESCE(jsonb_typeof(app_draft->'base_version'), '') = 'number'");
    // 판 사본 함수의 마지막 정의(0043이 app_definition을 더했다) — 시험 판은 판 기록에 들어가지 않는다
    const snapshot = readFileSync('supabase/migrations/0043_form_apps.sql', 'utf8').match(/FUNCTION agent_snapshot[\s\S]*?\$\$;/)?.[0] ?? '';
    expect(snapshot).toContain("'app_definition'");
    expect(snapshot).not.toContain('app_draft');
    const later = readdirSync('supabase/migrations').filter((f) => f > '0043_form_apps.sql' && /FUNCTION (public\.)?agent_snapshot/.test(readFileSync(`supabase/migrations/${f}`, 'utf8')));
    expect(later).toEqual([]);
  });
});
