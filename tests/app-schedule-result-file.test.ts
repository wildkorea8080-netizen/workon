import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';

/** 예약 결과 한글 파일(0071) — 손 내보내기와 같은 열쇠·같은 규칙, 끝나지 않은 결과는 만들지 않음, 같은 답은 한 벌 */
type Result = { data?: unknown; error?: { message: string } | null };
const state = vi.hoisted(() => ({ results: {} as Record<string, Result[]>, calls: [] as unknown[][], saves: [] as Record<string, unknown>[], saveFails: false, template: null as Buffer | null }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'limit', 'is']) q[m] = (...args: unknown[]) => { state.calls.push([table, m, ...args]); return q; };
      q.maybeSingle = () => Promise.resolve({ data: null, error: null, ...(state.results[table]?.shift() ?? {}) });
      return q;
    },
    storage: { from: () => ({ download: async () => (state.template ? { data: new Blob([new Uint8Array(state.template)]), error: null } : { data: null, error: { message: 'gone' } }) }) },
  },
}));
vi.mock('@/lib/generated-files', () => ({
  safeFileName: (name: string) => `${name}.hwpx`,
  saveGeneratedFile: async (row: Record<string, unknown>) => { state.saves.push(row); if (state.saveFails) throw new Error('duplicate'); return { id: 'new-file', file_name: 'x.hwpx', size_bytes: 1 }; },
}));

import { saveScheduledResultFile } from '@/lib/apps/schedule-result-file';
import { extractTextFromHwp } from '@/lib/hwp';
import { findBuiltinTemplate, loadBuiltinTemplate } from '@/lib/builtin-templates';

const row = { user_id: 'u1', organization_id: 'org', department_id: 'dept', agent_id: 'a1' };
const content = '## 주간 보고\n- 민원 처리 12건';
const message = (refs: Record<string, unknown> = {}) => ({ id: 'm1', content, source_references: refs, agent_version: 4 });
beforeEach(() => { state.results = {}; state.calls = []; state.saves = []; state.saveFails = false; state.template = null; });

describe('saveScheduledResultFile', () => {
  it('저장된 답을 표준 보고서 한글 파일로 — 손 내보내기와 같은 열쇠, 직원·기관·대화에 묶는다', async () => {
    state.results = { messages: [{ data: message() }], agents: [{ data: { name: '주간 보고 앱' } }] };
    expect(await saveScheduledResultFile(row, 'c1')).toBe('new-file');
    const saved = state.saves[0];
    expect(saved).toMatchObject({ userId: 'u1', organizationId: 'org', departmentId: 'dept', agentId: 'a1', conversationId: 'c1', templateName: '앱 실행 결과', extension: 'hwpx', fileName: '주간 보고 앱 작성 결과.hwpx' });
    expect(saved.templateRef).toBe(`app-result:m1:${createHash('sha256').update(content).digest('hex')}`);
    const text = await extractTextFromHwp(saved.bytes as Buffer, 'r.hwpx');
    expect(text).toContain('민원 처리 12건'); expect(text).toContain('[AI 작성 초안] 주간 보고 앱');
    expect(state.calls).toContainEqual(['messages', 'eq', 'role', 'assistant']);
    expect(state.calls).toContainEqual(['generated_files', 'eq', 'user_id', 'u1']);
  });
  it('이미 같은 답의 파일이 있으면 만들지 않고 그 id', async () => {
    state.results = { messages: [{ data: message() }], agents: [{ data: { name: '앱' } }], generated_files: [{ data: { id: 'old-file' } }] };
    expect(await saveScheduledResultFile(row, 'c1')).toBe('old-file');
    expect(state.saves).toHaveLength(0);
  });
  it('끝나지 않은 단계·빈 답·답 없음은 만들지 않는다(null)', async () => {
    state.results = { messages: [{ data: message({ app_steps: [{ status: 'completed' }, { status: 'failed' }] }) }], agents: [{ data: { name: '앱' } }] };
    expect(await saveScheduledResultFile(row, 'c1')).toBeNull();
    state.results = { messages: [{ data: { ...message(), content: '  ' } }], agents: [{ data: { name: '앱' } }] };
    expect(await saveScheduledResultFile(row, 'c1')).toBeNull();
    state.results = { messages: [{ data: null }], agents: [{ data: { name: '앱' } }] };
    expect(await saveScheduledResultFile(row, 'c1')).toBeNull();
    expect(state.saves).toHaveLength(0);
  });
  it('앱 설정의 결과 양식(2026-11-08)이 이 앱의 지금 HWPX 양식이면 그 양식에 — 열쇠에 양식 id, 만든 곳은 양식 이름', async () => {
    const T = '22222222-2222-4222-8222-222222222222';
    state.template = (await loadBuiltinTemplate(findBuiltinTemplate('builtin:official_letter')!))!;
    state.results = {
      messages: [{ data: message() }], agents: [{ data: { name: '주간 보고 앱', app_definition: { exportTemplateId: T } } }],
      generated_files: [{ data: null }], agent_templates: [{ data: { id: T, name: '우리 기관 공문', file_name: '공문.hwpx', storage_path: 'templates/a1/공문.hwpx' } }],
    };
    expect(await saveScheduledResultFile(row, 'c1')).toBe('new-file');
    expect(state.saves[0].templateRef).toBe(`app-result:m1:${createHash('sha256').update(content).digest('hex')}:${T}`);
    expect(state.saves[0].templateName).toBe('우리 기관 공문');
    expect(await extractTextFromHwp(state.saves[0].bytes as Buffer, 'r.hwpx')).toContain('민원 처리 12건');
    expect(state.calls).toContainEqual(['agent_templates', 'eq', 'agent_id', 'a1']);
    expect(state.calls).toContainEqual(['agent_templates', 'is', 'retired_at', null]);
  });
  it('양식을 쓸 수 없으면(지운 양식·본문 표시 없음·못 받음) 표준 보고서로 — 파일이 빠지지 않는다', async () => {
    const T = '22222222-2222-4222-8222-222222222222';
    const base = () => ({ messages: [{ data: message() }], agents: [{ data: { name: '앱', app_definition: { exportTemplateId: T } } }] });
    state.results = { ...base(), generated_files: [{ data: null }, { data: null }], agent_templates: [{ data: null }] };
    await saveScheduledResultFile(row, 'c1');
    state.template = (await loadBuiltinTemplate(findBuiltinTemplate('builtin:minutes')!))!; // 본문 표시 없음
    state.results = { ...base(), generated_files: [{ data: null }, { data: null }], agent_templates: [{ data: { id: T, name: '회의록', file_name: 'm.hwpx', storage_path: 'p' } }] };
    await saveScheduledResultFile(row, 'c1');
    state.template = null; // 받지 못함
    state.results = { ...base(), generated_files: [{ data: null }, { data: null }], agent_templates: [{ data: { id: T, name: '공문', file_name: 'g.hwpx', storage_path: 'p' } }] };
    await saveScheduledResultFile(row, 'c1');
    expect(state.saves.map(s => s.templateName)).toEqual(['앱 실행 결과', '앱 실행 결과', '앱 실행 결과']);
    expect(state.saves.every(s => !String(s.templateRef).endsWith(T))).toBe(true);
  });
  it('같은 양식으로 이미 만든 파일이 있으면 양식을 받지도 않고 그 id', async () => {
    const T = '22222222-2222-4222-8222-222222222222';
    state.results = { messages: [{ data: message() }], agents: [{ data: { name: '앱', app_definition: { exportTemplateId: T } } }], generated_files: [{ data: { id: 'old-tpl' } }] };
    expect(await saveScheduledResultFile(row, 'c1')).toBe('old-tpl');
    expect(state.calls.some(c => c[0] === 'agent_templates')).toBe(false);
  });
  it('동시에 만들어 저장이 지면 먼저 들어간 파일, 그것도 없으면 던진다 · 읽기 오류는 던진다', async () => {
    state.saveFails = true;
    state.results = { messages: [{ data: message() }], agents: [{ data: { name: '앱' } }], generated_files: [{ data: null }, { data: { id: 'winner' } }] };
    expect(await saveScheduledResultFile(row, 'c1')).toBe('winner');
    state.results = { messages: [{ data: message() }], agents: [{ data: { name: '앱' } }], generated_files: [{ data: null }, { data: null }] };
    await expect(saveScheduledResultFile(row, 'c1')).rejects.toThrow('duplicate');
    state.results = { messages: [{ error: { message: 'down' } }], agents: [{ data: null }] };
    await expect(saveScheduledResultFile(row, 'c1')).rejects.toThrow('down');
  });
});
