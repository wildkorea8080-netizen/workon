import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { validateAppDefinition } from '@/lib/apps/definition';
import { appCopyDraft } from '@/lib/apps/copy';
import type { Agent } from '@/lib/db';

/** 앱 설정의 결과 한글 파일 양식(2026-11-08) — 이 앱 비서의 HWPX 양식 id, 쓸 때 다시 확인, 복사로 옮겨 가지 않음 */
const base = { schemaVersion: 1, fields: [{ key: 'title', label: '제목', type: 'text', required: true }], output: 'paragraphs' };
const T = '22222222-2222-4222-8222-22222222222A';

describe('결과 한글 파일 양식', () => {
  it('정의 — uuid만 받아 소문자로 두고, 없으면 칸을 만들지 않는다', () => {
    expect(validateAppDefinition({ ...base, exportTemplateId: T })).toEqual({ ok: true, value: { ...base, exportTemplateId: T.toLowerCase() } });
    expect(validateAppDefinition(base)).toEqual({ ok: true, value: base });
    for (const bad of ['../x', 1, '', null]) expect(validateAppDefinition({ ...base, exportTemplateId: bad })).toMatchObject({ ok: false, message: '결과 한글 파일 양식을 확인해 주세요.' });
  });
  it('복사한 앱은 원래 앱의 양식 id를 가져가지 않는다', () => {
    const source = { name: '공문 앱', description: '', category: '문서', system_prompt: '공문을 씁니다.', is_active: true, deleted_at: null, agent_type: 'chat', app_definition: { ...base, exportTemplateId: T } } as unknown as Agent;
    expect(appCopyDraft(source).definition).toEqual(base);
  });
  it('화면 — 빌더가 이 앱의 HWPX 양식만 고르게 하고, 내보내기가 그 양식을 먼저 골라 둔다(실행 화면·대화 둘 다)', () => {
    const builder = readFileSync('src/app/apps/builder/page.tsx', 'utf8');
    expect(builder).toContain('<ExportTemplatePicker agentId={agent?.id ?? null}');
    expect(builder).toContain('/templates`');
    expect(builder).toContain("filter(t => /\\.hwpx$/i.test(t.file_name))");
    const exporter = readFileSync('src/components/apps/AppResultExport.tsx', 'utf8');
    expect(exporter).toContain('if (defaultTemplateId && list.some(t => t.id === defaultTemplateId)) setChoice(defaultTemplateId);');
    expect(readFileSync('src/app/apps/run/page.tsx', 'utf8')).toContain('defaultTemplateId={definition.exportTemplateId}');
    expect(readFileSync('src/components/chat/ChatInterface.tsx', 'utf8')).toContain('?.exportTemplateId} />');
  });
});
