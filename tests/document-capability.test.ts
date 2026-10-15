// tests/document-capability.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createDocument, DOCUMENT_ADDENDUM, type DocumentDeps } from '@/lib/capabilities/document';
import type { TurnContext } from '@/lib/capabilities/types';
import { buildHwpx, para } from './fixtures/hwpx';

const ctx: TurnContext = {
  organizationId: 'org', departmentId: 'dept', userId: 'u1', agentId: 'agent-1', agentVersion: 3,
  capabilities: { document: {} }, message: '회의록 만들어줘', conversationId: 'conv-1',
};

async function deps(over: Partial<DocumentDeps> = {}) {
  const template = await buildHwpx(para('{{회의명}}') + para('{{논의 내용}}'));
  const d: DocumentDeps = {
    listAgentTemplates: vi.fn(async () => [{ id: 'tpl-1', name: '우리 회의록', file_name: '회의록.hwpx', storage_path: 'templates/x.hwpx' }]),
    downloadAgentTemplate: vi.fn(async () => template),
    loadBuiltin: vi.fn(async () => template),
    saveFile: vi.fn(async (input) => ({ id: 'file-1', file_name: input.fileName, size_bytes: input.bytes.length })),
    logGenerated: vi.fn(async () => {}),
    ...over,
  };
  return d;
}

const run = async (d: DocumentDeps, tool: string, input: Record<string, unknown>) =>
  createDocument(d).execute!(tool, input, ctx);

describe('문서 만들기 — 목록·읽기', () => {
  it('기본 양식과 이 비서의 양식을 함께 보여 준다', async () => {
    const d = await deps();
    const out = await run(d, 'list_templates', {});
    expect(out.ok).toBe(true);
    const list = JSON.parse(out.text) as { ref: string; kind: string; format: string }[];
    expect(list.map((t) => t.ref)).toEqual(['builtin:official_letter', 'builtin:report', 'builtin:minutes', 'tpl-1']);
    expect(list.find((t) => t.ref === 'tpl-1')).toMatchObject({ kind: 'agent', format: 'hwpx' });
    expect(d.listAgentTemplates).toHaveBeenCalledWith('agent-1');
  });

  it('양식의 자리를 읽어 준다', async () => {
    const out = await run(await deps(), 'read_template', { ref: 'tpl-1' });
    expect(JSON.parse(out.text)).toMatchObject({ ref: 'tpl-1', name: '우리 회의록', slots: [{ id: 's1', label: '회의명' }, { id: 's2', label: '논의 내용' }] });
  });

  it('이 비서의 양식이 아닌 ref는 거절한다 — 다른 비서·기관의 양식 id', async () => {
    const out = await run(await deps(), 'read_template', { ref: 'someone-elses-template' });
    expect(out).toEqual({ ok: false, text: expect.stringContaining('쓸 수 없는 양식') });
  });

  it('기본 양식 파일이 아직 없으면 그렇게 알린다', async () => {
    const out = await run(await deps({ loadBuiltin: vi.fn(async () => null) }), 'read_template', { ref: 'builtin:minutes' });
    expect(out).toEqual({ ok: false, text: expect.stringContaining('준비되지 않았습니다') });
  });

  it('읽을 수 없는 양식은 이유를 돌려준다', async () => {
    const d = await deps({ downloadAgentTemplate: vi.fn(async () => Buffer.from('not zip')) });
    const out = await run(d, 'read_template', { ref: 'tpl-1' });
    expect(out.ok).toBe(false);
  });
});

describe('문서 만들기 — 채우기', () => {
  it('파일을 만들어 기록하고 링크를 싣는다 — 기관·대화 값은 서버 문맥에서', async () => {
    const d = await deps();
    const out = await run(d, 'fill_template', {
      ref: 'builtin:minutes', title: '10월 주간 회의', values: [{ slot_id: 's1', text: '주간 회의' }],
      organization_id: 'attacker-org', conversation_id: 'other',
    });
    expect(out.ok).toBe(true);
    expect(out.files).toEqual([{ id: 'file-1', file_name: '10월 주간 회의.hwpx', size_bytes: expect.any(Number) }]);
    const saved = (d.saveFile as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(saved).toMatchObject({
      organizationId: 'org', departmentId: 'dept', userId: 'u1', agentId: 'agent-1', conversationId: 'conv-1',
      templateRef: 'builtin:minutes', extension: 'hwpx', mimeType: 'application/hwp+zip',
    });
    expect(d.logGenerated).toHaveBeenCalledWith(expect.objectContaining({
      departmentId: 'dept', userId: 'u1', conversationId: 'conv-1',
      details: expect.objectContaining({ agent_id: 'agent-1', template_ref: 'builtin:minutes', file_name: '10월 주간 회의.hwpx' }),
    }));
    // 안 채운 자리를 AI에게 알려 사용자에게 말하게 한다
    expect(out.text).toContain('논의 내용');
  });

  it('저장이 실패하면 이유와 함께 초안이 남아 있다고 알린다', async () => {
    const d = await deps({ saveFile: vi.fn(async () => { throw new Error('저장소 가득'); }) });
    const out = await run(d, 'fill_template', { ref: 'builtin:minutes', title: '회의', values: [{ slot_id: 's1', text: 'x' }] });
    expect(out.ok).toBe(false);
    expect(out.text).toContain('초안');
    expect(out.text).toContain('저장소 가득');
    expect(d.logGenerated).not.toHaveBeenCalled();
  });

  it('입력 꼴이 틀리면 거절한다', async () => {
    const d = await deps();
    expect((await run(d, 'fill_template', { ref: 'builtin:minutes', title: '회의', values: 'x' })).ok).toBe(false);
    expect((await run(d, 'fill_template', { ref: 'builtin:minutes', title: '회의', values: [{ slot_id: 1, text: 'x' }] })).ok).toBe(false);
    expect((await run(d, 'read_template', {})).ok).toBe(false);
  });

  it('없는 자리 번호는 엔진의 이유를 그대로 돌려준다', async () => {
    const out = await run(await deps(), 'fill_template', { ref: 'tpl-1', title: '회의', values: [{ slot_id: 's9', text: 'x' }] });
    expect(out).toEqual({ ok: false, text: expect.stringContaining('s9') });
  });
});

describe('문서 만들기 — 흐름 안내', () => {
  it('목차 확인과 지어내지 않기를 프롬프트에 붙인다', async () => {
    const result = await createDocument(await deps()).prepare!(ctx);
    expect(result.systemAddendum).toBe(DOCUMENT_ADDENDUM);
    expect(DOCUMENT_ADDENDUM).toContain('목차');
    expect(DOCUMENT_ADDENDUM).toContain('지어내지');
  });
});
