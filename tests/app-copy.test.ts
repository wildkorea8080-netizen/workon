import { describe, expect, it } from 'vitest';
import type { Agent } from '@/lib/db';
import { appCopyDraft } from '@/lib/apps/copy';
import { splitAgentBody } from '@/lib/agent-patch';

const source = (patch: Partial<Agent> = {}): Agent => ({
  id: 'source', name: '기관 안내문', department_id: 'original-dept', tier: 'official', is_active: true,
  version: 12, config: {}, created_at: '', updated_at: '', owner_id: 'original-owner', system_prompt: '자료의 사실만 사용해 안내문을 작성하세요.',
  model_id: 'original-model', capabilities: { doc_search: {}, public_data: { connectors: ['private'] } },
  app_definition: { schemaVersion: 1, output: 'bullets', fields: [{ key: 'type', label: '종류', type: 'select', required: true, options: ['안내', '공지'] }], attachments: { required: true }, steps: [{ name: '정리', instruction: '사실 정리', when: { all: [{ field: 'type', op: 'equals', value: '안내' }] } }, { name: '작성', instruction: '안내문 작성' }] },
  ...patch,
});

describe('app copy draft', () => {
  it('copies form/steps and instructions without identities, tools, models or resources', () => {
    const original = source();
    const draft = appCopyDraft(original);
    expect(draft).toEqual({ name: '기관 안내문 (복사)', description: '', category: '문서 작성·정리', instructions: original.system_prompt, definition: original.app_definition });
    expect(Object.keys(draft).sort()).toEqual(['category', 'definition', 'description', 'instructions', 'name']);
    const settings = splitAgentBody({ name: draft.name, system_prompt: draft.instructions, app_definition: draft.definition, capabilities: { file_read: {} } }, { currentType: 'chat', knownConnectorIds: [], knownModelIds: [] });
    expect(settings.error).toBeUndefined();
    expect(settings.settings.app_definition).toEqual(original.app_definition);
    expect(settings.settings.capabilities).toEqual({ file_read: {} });
  });
  it('creates independent fields, options, conditions and attachment settings', () => {
    const original = source(); const draft = appCopyDraft(original);
    draft.definition.fields[0].options![0] = '변경';
    draft.definition.steps![0].when!.all[0].value = '변경';
    draft.definition.attachments!.required = false;
    expect(original.app_definition!.fields[0].options![0]).toBe('안내');
    expect(original.app_definition!.steps![0].when!.all[0].value).toBe('안내');
    expect(original.app_definition!.attachments!.required).toBe(true);
  });
  it.each([{ is_active: false }, { deleted_at: '2026-10-31' }, { agent_type: 'link' as const }, { app_definition: null }, { system_prompt: '' }, { system_prompt: 'x'.repeat(12001) }])('rejects unavailable or uneditable source %j', patch => {
    expect(() => appCopyDraft(source(patch))).toThrow();
  });
  it('leaves room for the copy suffix and respects editor limits', () => {
    const draft = appCopyDraft(source({ name: '가'.repeat(100), description: '나'.repeat(600), category: '다'.repeat(50) }));
    expect(draft.name.length).toBeLessThanOrEqual(80); expect(draft.name).toMatch(/\(복사\)$/);
    expect(draft.description).toHaveLength(500); expect(draft.category).toHaveLength(40);
  });
});
