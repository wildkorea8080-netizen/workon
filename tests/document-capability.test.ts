// tests/document-capability.test.ts
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createDocument, DOCUMENT_ADDENDUM, type DocumentDeps } from '@/lib/capabilities/document';
import type { TurnContext } from '@/lib/capabilities/types';
import { buildHwpx, para } from './fixtures/hwpx';
import { buildDocx, wp } from './fixtures/docx';

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
    builtinReady: vi.fn(async () => true),
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

  it('파일이 있는 기본 양식만 목록에 둔다', async () => {
    const d = await deps({ builtinReady: vi.fn(async (t) => t.ref === 'builtin:minutes') });
    const list = JSON.parse((await run(d, 'list_templates', {})).text) as { ref: string; kind: string }[];
    expect(list.filter((t) => t.kind === 'builtin').map((t) => t.ref)).toEqual(['builtin:minutes']);
    expect(list.some((t) => t.ref === 'tpl-1')).toBe(true);
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
    // 초안을 안 쓴 경로(바로 파일)도 있다 — 쓰지 않았다면 써 드릴 수 있다고 알리게 한다
    expect(out.text).toContain('쓰지 않았다면');
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

describe('문서 만들기 — 형식에 맞는 문구', () => {
  it('HWPX는 한글 파일, DOCX는 Word(DOCX) 파일이라고 알린다', async () => {
    const hwpx = await run(await deps(), 'fill_template', { ref: 'tpl-1', title: '회의', values: [{ slot_id: 's1', text: 'x' }] });
    expect(hwpx.text).toContain('한글 파일을 만들었습니다');

    const docx = await buildDocx(wp('{{회의명}}'));
    const d = await deps({
      listAgentTemplates: vi.fn(async () => [{ id: 'tpl-2', name: 'Word 회의록', file_name: '회의록.docx', storage_path: 'templates/y.docx' }]),
      downloadAgentTemplate: vi.fn(async () => docx),
    });
    const out = await run(d, 'fill_template', { ref: 'tpl-2', title: '회의', values: [{ slot_id: 's1', text: '주간 회의' }] });
    expect(out.ok).toBe(true);
    expect(out.text).toContain('Word(DOCX) 파일을 만들었습니다');
    expect(out.text).not.toContain('한글 파일');
    expect(out.files).toEqual([{ id: 'file-1', file_name: '회의.docx', size_bytes: expect.any(Number) }]);
  });
});

describe('문서 만들기 — 대체 경로', () => {
  const REPORT_LABELS = ['제목', '작성일', '작성부서', '개요', '추진 경과', '주요 내용', '향후 계획', '건의 사항'];

  async function fallbackDeps() {
    const minutes = await buildHwpx(para('{{회의명}}') + para('{{논의 내용}}'));
    const report = await buildHwpx(REPORT_LABELS.map((l) => para(`{{${l}}}`)).join(''));
    const noSlots = await buildHwpx(para('1. 사업 개요') + para('본문') + para('2. 추진 일정'));
    return deps({
      downloadAgentTemplate: vi.fn(async () => noSlots),
      loadBuiltin: vi.fn(async (t) => (t.ref === 'builtin:report' ? report : minutes)),
    });
  }

  it('대체 양식은 mode·reason을 싣고 표준 보고서로 만든다', async () => {
    const d = await fallbackDeps();
    const read = await run(d, 'read_template', { ref: 'tpl-1' });
    expect(read.ok).toBe(true);
    expect(JSON.parse(read.text)).toMatchObject({
      ref: 'tpl-1',
      mode: 'fallback',
      reason: expect.stringContaining('표준 서식'),
      slots: [{ id: 's1', label: '1. 사업 개요' }, { id: 's2', label: '2. 추진 일정' }],
    });
    const out = await run(d, 'fill_template', { ref: 'tpl-1', title: '사업 보고', values: [{ slot_id: 's1', text: '개요 글' }] });
    expect(out.ok).toBe(true);
    expect(out.text).toContain('표준 서식으로 만들었습니다');
    // 내용이 어디로 갔고 무엇이 살지 않았는지 알게 한다
    expect(out.text).toContain('주요 내용');
    expect(out.text).toContain('원래 양식의 모양은 살리지 못했습니다');
    expect(out.text).toContain('한글 파일을 만들었습니다');
    expect(out.text).toContain('2. 추진 일정');
    const saved = (d.saveFile as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(saved).toMatchObject({ templateRef: 'tpl-1', extension: 'hwpx', fileName: '사업 보고.hwpx' });
    expect(d.loadBuiltin).toHaveBeenCalledWith(expect.objectContaining({ ref: 'builtin:report' }));
  });

  it('표준 보고서 파일이 없으면 이유를 돌려준다', async () => {
    const noSlots = await buildHwpx(para('1. 사업 개요'));
    const d = await deps({ downloadAgentTemplate: vi.fn(async () => noSlots), loadBuiltin: vi.fn(async () => null) });
    const out = await run(d, 'fill_template', { ref: 'tpl-1', title: '보고', values: [{ slot_id: 's1', text: 'x' }] });
    expect(out).toEqual({ ok: false, text: expect.stringContaining('표준 서식(일반 보고서) 파일이 아직 준비되지 않아') });
    expect(d.saveFile).not.toHaveBeenCalled();
  });

  it('표시 경로에는 표준 보고서를 읽지 않는다', async () => {
    const d = await deps();
    await run(d, 'fill_template', { ref: 'tpl-1', title: '회의', values: [{ slot_id: 's1', text: 'x' }] });
    expect(d.loadBuiltin).not.toHaveBeenCalled();
    const read = JSON.parse((await run(d, 'read_template', { ref: 'tpl-1' })).text);
    expect(read.mode).toBe('fill');
    expect(read.reason).toBeUndefined();
  });

  it('기록에 mode가 남는다', async () => {
    const d = await fallbackDeps();
    await run(d, 'fill_template', { ref: 'tpl-1', title: '보고', values: [{ slot_id: 's1', text: 'x' }] });
    expect(d.logGenerated).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ mode: 'fallback' }) }));
    const d2 = await deps();
    await run(d2, 'fill_template', { ref: 'tpl-1', title: '회의', values: [{ slot_id: 's1', text: 'x' }] });
    expect(d2.logGenerated).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ mode: 'fill' }) }));
  });
});

describe('문서 만들기 — 흐름 안내', () => {
  it('대체 경로의 reason을 그대로 전하게 한다 — 안내는 reason에 들어 있다', () => {
    expect(DOCUMENT_ADDENDUM).toContain('fallback');
    expect(DOCUMENT_ADDENDUM).toContain('reason을 사용자에게 그대로');
  });

  it('한글·Word 양식을 다루고, 자리 hint의 기호를 이어 쓰게 한다', () => {
    expect(DOCUMENT_ADDENDUM).toContain('한글·Word 양식');
    expect(DOCUMENT_ADDENDUM).toContain('○·- 같은 기호가 있으면 그 기호로 시작해');
    expect(DOCUMENT_ADDENDUM).not.toContain('이대로 한글 파일로 만들까요');
  });

  it('목차 확인과 지어내지 않기를 프롬프트에 붙인다', async () => {
    const result = await createDocument(await deps()).prepare!(ctx);
    expect(result.systemAddendum).toBe(DOCUMENT_ADDENDUM);
    expect(DOCUMENT_ADDENDUM).toContain('목차');
    expect(DOCUMENT_ADDENDUM).toContain('지어내지');
  });

  it('앞 응답의 도구 결과가 남지 않으니 다시 확인하고 추측하지 않게 한다', () => {
    expect(DOCUMENT_ADDENDUM).toContain('다시 확인');
    expect(DOCUMENT_ADDENDUM).toContain('추측하지');
    expect(DOCUMENT_ADDENDUM).toContain('(2의 목차 확인은 그대로 거칩니다)');
  });
});

describe('문서 만들기 — 원본 검사', () => {
  it('양식 목록은 비서 id와 폐기 여부로만 거른다 — 양식의 유일한 기관 경계', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/lib/capabilities/document.ts'), 'utf-8');
    const block = src.slice(src.indexOf('async listAgentTemplates'), src.indexOf('async downloadAgentTemplate'));
    expect(block).toContain(".eq('agent_id'");
    expect(block).toContain(".is('retired_at', null)");
  });
});
