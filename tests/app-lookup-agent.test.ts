import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import type { RetrievedChunk } from '@/lib/db';
import type { ActorScope } from '@/lib/agent-permissions';
import { appLookupAgentIds, appUsesDocSearchLookup, validateAppDefinition, type AppDefinition, type AppField, type AppStep } from '@/lib/apps/definition';
import { appLookupRunner, runAppIntermediateSteps } from '@/lib/apps/pipeline';
import { APP_DOC_LOOKUP_AGENT_DENIED, appDocSearchRunner, checkLookupAgents, lookupAgentDenied, type LookupAgentRow } from '@/lib/apps/app-doc-lookup';
import { lookupAgentChoices } from '@/components/apps/AppStepEditor';

/** 문서 찾기 단계가 다른 비서의 문서함을 찾기(2026-11-09) — 실행 전에 실행하는 사람이 그 비서를 쓸 수 있는지 서버가 본다 */

const OWN = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-2222-4222-8222-222222222222';
const THIRD = 'cccccccc-3333-4333-8333-333333333333';
const ORG = 'dddddddd-4444-4444-8444-444444444444';
const DEPT = 'eeeeeeee-5555-4555-8555-555555555555';
const fields: AppField[] = [{ key: 'topic', label: '주제', type: 'text', required: true }];
const finalStep: AppStep = { name: '보고서', instruction: '찾은 근거로 정리하세요.' };
const def = (steps: unknown[]) => validateAppDefinition({ schemaVersion: 1, fields, output: 'bullets', steps });
const chunk = (over: Partial<RetrievedChunk> = {}): RetrievedChunk => ({ documentId: OTHER, documentTitle: '감사 지침', chunkIndex: 0, n: 1, text: '감사 기준은 이렇다.', similarity: 0.9, page: 3, ...over });

const actor: ActorScope = { userId: 'u1', isAdmin: false, departmentId: DEPT, organizationId: ORG, visibleDepartmentIds: [DEPT], managedDepartmentIds: [], managesWholeOrganization: false };
const row = (over: Partial<LookupAgentRow> = {}): LookupAgentRow => ({
  id: OTHER, tier: 'official', department_id: DEPT, organization_id: ORG, visibility: 'organization', owner_id: null, created_by: 'x',
  is_active: true, is_published: true, deleted_at: null, approval_status: null, version: 1, approval_version: null,
  name: '감사 비서', capabilities: { doc_search: {} }, agent_type: 'chat', ...over,
} as LookupAgentRow);

describe('정의', () => {
  it('찾을 비서는 문서 찾기 단계에서만, 비서 id 꼴만 — 소문자로 저장한다', () => {
    const ok = def([{ name: '찾기', instruction: '', lookup: { tool: 'doc_search', query: '{{topic}}', agent: OTHER.toUpperCase() } }, finalStep]);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value?.steps?.[0].lookup?.agent).toBe(OTHER);
    expect(def([{ name: '법령', instruction: '', lookup: { tool: 'law_search', query: '{{topic}}', agent: OTHER } }, finalStep])).toMatchObject({ ok: false });
    expect(def([{ name: '찾기', instruction: '', lookup: { tool: 'doc_search', query: '{{topic}}', agent: 'not-a-uuid' } }, finalStep])).toMatchObject({ ok: false });
    expect(def([{ name: '찾기', instruction: '', lookup: { tool: 'doc_search', query: '{{topic}}', agent: 12 } }, finalStep])).toMatchObject({ ok: false });
    const empty = def([{ name: '찾기', instruction: '', lookup: { tool: 'doc_search', query: '{{topic}}', agent: '' } }, finalStep]);
    expect(empty.ok && empty.value?.steps?.[0].lookup).toEqual({ tool: 'doc_search', query: '{{topic}}' });
  });

  it('다른 비서를 찾는 단계만 있으면 이 앱의 문서 찾기 능력이 필요 없다 — 찾을 비서 목록은 이 앱 비서를 빼고 중복 없이', () => {
    const checked = def([
      { name: '감사', instruction: '', lookup: { tool: 'doc_search', query: '{{topic}}', agent: OTHER } },
      { name: '감사 2', instruction: '', lookup: { tool: 'doc_search', query: '{{topic}} 기준', agent: OTHER } },
      { name: '자기', instruction: '', lookup: { tool: 'doc_search', query: '{{topic}}', agent: OWN } },
      finalStep,
    ]);
    expect(checked.ok).toBe(true);
    if (!checked.ok || !checked.value) return;
    expect(appUsesDocSearchLookup({ ...checked.value, steps: checked.value.steps!.slice(0, 2).concat(finalStep) } as AppDefinition)).toBe(false);
    expect(appUsesDocSearchLookup(checked.value)).toBe(false); // 이 앱 비서 자신을 고른 단계는 실행기가 이 앱 능력을 다시 본다(아래)
    expect(appLookupAgentIds(checked.value.steps, OWN.toUpperCase())).toEqual([OTHER]);
    expect(appLookupAgentIds(undefined, OWN)).toEqual([]);
  });
});

describe('실행 — 찾기', () => {
  it('확인한 목록의 비서만 그 비서로 찾고, 목록 밖이면 찾지 않는다', async () => {
    const search = vi.fn(async () => [chunk()]);
    const runner = appDocSearchRunner({ agentId: OWN, organizationId: ORG }, search, [OTHER]);
    expect(await runner('감사', OTHER)).toMatchObject({ content: expect.stringContaining('감사 지침') });
    expect(search).toHaveBeenLastCalledWith({ agentId: OTHER, organizationId: ORG, query: '감사' });
    expect(await runner('감사', THIRD)).toEqual({ content: APP_DOC_LOOKUP_AGENT_DENIED, sources: [], isError: true });
    expect(search).toHaveBeenCalledTimes(1);
    await runner('감사');
    expect(search).toHaveBeenLastCalledWith({ agentId: OWN, organizationId: ORG, query: '감사' });
    await runner('감사', OWN); // 이 앱 비서를 골랐으면 목록 없이 이 앱 비서
    expect(search).toHaveBeenLastCalledWith({ agentId: OWN, organizationId: ORG, query: '감사' });
  });

  it('이 앱 비서 자신을 적은 단계는 이 앱의 문서 찾기가 꺼져 있으면 찾지 않는다', async () => {
    const search = vi.fn(async () => [chunk()]);
    const off = appDocSearchRunner({ agentId: OWN, organizationId: ORG, capabilities: {} }, search, []);
    expect(await off('감사', OWN.toUpperCase().toLowerCase())).toMatchObject({ isError: true });
    expect(search).not.toHaveBeenCalled();
    const on = appDocSearchRunner({ agentId: OWN, organizationId: ORG, capabilities: { doc_search: {} } }, search, []);
    expect(await on('감사', OWN)).toMatchObject({ content: expect.stringContaining('감사 지침') });
  });

  it('다른 비서를 찾는 단계는 이 앱 비서의 문서 찾기가 꺼져 있어도 돈다 — 이 앱 비서 단계는 여전히 막힌다', async () => {
    const tool = vi.fn();
    const docs = vi.fn(async () => ({ content: '근거', sources: [] }));
    const lookup = appLookupRunner({ capabilities: {} }, tool, docs);
    expect(await lookup('doc_search', 'q', undefined, OTHER)).toEqual({ content: '근거', sources: [] });
    expect(docs).toHaveBeenLastCalledWith('q', OTHER);
    expect(await lookup('doc_search', 'q')).toMatchObject({ isError: true });
  });

  it('단계의 찾을 비서가 실행기에 그대로 간다', async () => {
    const checked = def([{ name: '감사', instruction: '', lookup: { tool: 'doc_search', query: '{{topic}}', agent: OTHER } }, finalStep]);
    expect(checked.ok).toBe(true);
    if (!checked.ok || !checked.value) return;
    const lookup = vi.fn(async () => ({ content: '근거', sources: [] }));
    const steps = checked.value.steps!;
    await runAppIntermediateSteps({
      steps, records: steps.map((s) => ({ name: s.name, status: 'pending' })), model: 'm', system: 's', inputs: { topic: '감사' },
      messages: [{ role: 'user', content: '주제: 감사' }], usage: { model: 'm', input_tokens: 0, output_tokens: 0 },
      complete: vi.fn(async () => ({ text: '정리', usage: { model: 'm', input_tokens: 1, output_tokens: 1 } })) as never,
      update: () => {}, guard: async () => {}, lookup: lookup as never,
    });
    expect(lookup).toHaveBeenCalledWith('doc_search', '감사', undefined, OTHER);
  });
});

describe('실행 전 — 권한', () => {
  const load = (rows: LookupAgentRow[] | null) => vi.fn(async () => rows);

  it('쓸 수 있고 문서 찾기가 켜진 비서면 통과', async () => {
    expect(await checkLookupAgents([OTHER], actor, load([row()]))).toEqual({ ok: true });
    expect(await checkLookupAgents([], actor, load(null))).toEqual({ ok: true });
  });

  it('없음·링크형·쓸 수 없음·문서 찾기 꺼짐·다른 기관·읽기 실패는 모두 막는다', async () => {
    expect(await checkLookupAgents([OTHER], actor, load([]))).toEqual({ ok: false, message: lookupAgentDenied(null) });
    expect(await checkLookupAgents([OTHER], actor, load([row({ agent_type: 'link' })]))).toEqual({ ok: false, message: lookupAgentDenied('감사 비서') });
    expect(await checkLookupAgents([OTHER], actor, load([row({ tier: 'personal', owner_id: 'someone' })]))).toMatchObject({ ok: false });
    expect(await checkLookupAgents([OTHER], actor, load([row({ capabilities: { file_read: {} } })]))).toMatchObject({ ok: false });
    expect(await checkLookupAgents([OTHER], actor, load([row({ organization_id: 'ffffffff-6666-4666-8666-666666666666' })]))).toMatchObject({ ok: false });
    expect(await checkLookupAgents([OTHER], actor, load([row({ deleted_at: '2026-11-01' })]))).toMatchObject({ ok: false });
    expect(await checkLookupAgents([OTHER], actor, load(null))).toEqual({ ok: false, message: lookupAgentDenied(null) });
    // 둘 중 하나라도 아니면 막는다
    expect(await checkLookupAgents([OTHER, THIRD], actor, load([row()]))).toMatchObject({ ok: false });
  });

  it('대화 준비가 대화를 만들기 전에 보고, 실행기는 확인한 목록만 넘긴다', () => {
    const prepare = readFileSync('src/lib/assistant/prepare.ts', 'utf8');
    const check = prepare.indexOf('checkLookupAgents(appLookupAgents, actor)');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(prepare.indexOf('// ── 대화 ──'));
    expect(readFileSync('src/lib/assistant/stream.ts', 'utf8')).toContain('turn.appLookupAgents ?? []');
  });
});

describe('편집 화면', () => {
  it('고를 수 있는 비서 — 문서 찾기가 켜진 것만, 링크형·이 앱 비서·중복 빼고', () => {
    const choices = lookupAgentChoices([
      { id: OTHER.toUpperCase(), name: '감사 비서', tier: 'official', capabilities: { doc_search: {} } },
      { id: OTHER.toUpperCase(), name: '감사 비서', tier: 'official', capabilities: { doc_search: {} } },
      { id: THIRD, name: '링크', capabilities: { doc_search: {} }, agent_type: 'link' },
      { id: OWN, name: '이 앱', capabilities: { doc_search: {} } },
      { id: 'abababab-1111-4111-8111-111111111111', name: '문서 없음', capabilities: {} },
      { id: 'cdcdcdcd-1111-4111-8111-111111111111', name: '내 비서', tier: 'personal', capabilities: { doc_search: {} } },
    ], OWN);
    expect(choices).toEqual([{ id: OTHER, name: '감사 비서', tier: 'official' }, { id: 'cdcdcdcd-1111-4111-8111-111111111111', name: '내 비서', tier: 'personal' }]);
  });
});
