import { describe, it, expect } from 'vitest';
import { renderAppInput, type AppDefinition } from '@/lib/apps/definition';
import { restoreAppSteps } from '@/lib/apps/resume';
import { runAppIntermediateSteps } from '@/lib/apps/pipeline';
import { loadAppResumeSource } from '@/lib/apps/resume-client';
const def: AppDefinition = { schemaVersion: 1, fields: [{ key: 'source', label: '자료', type: 'text', required: true }], output: 'bullets', steps: [{ name: '정리', instruction: '정리' }, { name: '작성', instruction: '작성' }, { name: '검토', instruction: '검토' }] };
function refs() { return { app_inputs: { source: '가상 자료' }, app_steps: [{ name: '정리', status: 'completed', output: '기존 정리 결과' }, { name: '작성', status: 'failed' }, { name: '검토', status: 'not_run' }] }; }
const input = renderAppInput(def, { source: '가상 자료' }); if (!input.ok) throw Error('fixture');
const message = input.message;
describe('validated app resume checkpoints', () => {
  it('reuses completed prefix only and resets unfinished stages', () => { const r = restoreAppSteps(def, refs(), message); expect(r).toMatchObject({ ok: true, records: [{ name: '정리', status: 'completed', reused: true, output: '기존 정리 결과' }, { name: '작성', status: 'pending' }, { name: '검토', status: 'pending' }] }); });
  it('rejects changed input, missing metadata and completed runs', () => { expect(restoreAppSteps(def, refs(), '다른 입력').ok).toBe(false); expect(restoreAppSteps(def, { app_steps: refs().app_steps }, message).ok).toBe(false); const r = refs(); r.app_steps = r.app_steps.map(s => ({ ...s, status: 'completed', output: '완료' })); expect(restoreAppSteps(def, r, message).ok).toBe(false); });
  it('rejects stage mismatch and malformed outputs', () => { for (const patch of [{ name: '다른 단계' }, { output: '' }, { output: 'x'.repeat(12001) }]) { const r = refs(); r.app_steps[0] = { ...r.app_steps[0], ...patch }; expect(restoreAppSteps(def, r, message).ok).toBe(false); } });
  it('rejects outputs appearing after a failed stage', () => { const r = refs(); r.app_steps[2] = { name: '검토', status: 'completed', output: '잘못된 후속 결과' }; expect(restoreAppSteps(def, r, message).ok).toBe(false); });
  it('does not call or charge the model for reused work', async () => {
    const restored = restoreAppSteps(def, refs(), message); if (!restored.ok) throw Error(restored.message);
    let calls = 0; const usage = { model: 'model', input_tokens: 0, output_tokens: 0 };
    const result = await runAppIntermediateSteps({ steps: def.steps!, records: restored.records, model: 'model', system: 'S', messages: [{ role: 'user', content: message }], inputs: { source: '가상 자료' }, usage, guard: async () => {}, update: () => {}, complete: async request => { calls++; expect(JSON.stringify(request.messages)).toContain('기존 정리 결과'); return { text: '새 작성 결과', usage: { model: 'model', input_tokens: 3, output_tokens: 2 } }; } });
    expect(calls).toBe(1); expect(usage.input_tokens).toBe(3); expect(JSON.stringify(result.messages)).toContain('새 작성 결과');
  });
  it('prefills only a matching owned API response without executing a model', async () => {
    const agent = { id: 'a', version: 3, app_definition: def } as never;
    const response = (agentId: string, version: number) => async () => new Response(JSON.stringify({ ok: true, data: { agent_id: agentId, messages: [{ id: 'm', role: 'assistant', agent_version: version, source_references: refs() }] } }), { headers: { 'Content-Type': 'application/json' } });
    expect(await loadAppResumeSource(agent, 'c', 'm', response('a', 3))).toMatchObject({ id: 'm', inputs: { source: '가상 자료' } });
    expect(await loadAppResumeSource(agent, 'c', 'm', response('other', 3))).toBeNull();
    expect(await loadAppResumeSource(agent, 'c', 'm', response('a', 4))).toBeNull();
  });
});

describe('resume with step branches', () => {
  const kind = { key: 'kind', label: '종류', type: 'select' as const, required: true, options: ['질의', '요구'] };
  const branchDef: AppDefinition = { ...def, fields: [...def.fields, kind], steps: [
    { name: '정리', instruction: '정리', branches: [{ name: '요구 정리', when: { all: [{ field: 'kind', op: 'equals', value: '요구' }] }, instruction: '요구 정리' }] },
    def.steps![1], def.steps![2],
  ] };
  const msg = (k: string) => { const r = renderAppInput(branchDef, { source: '가상 자료', kind: k }); if (!r.ok) throw Error('fixture'); return r.message; };
  const refsWith = (k: string, branch?: string) => ({ app_inputs: { source: '가상 자료', kind: k }, app_steps: [{ name: '정리', status: 'completed', output: '기존 정리 결과', ...(branch ? { branch } : {}) }, { name: '작성', status: 'failed' }, { name: '검토', status: 'not_run' }] });
  it('reuses a completed step only when the recorded branch equals the one the current inputs choose', () => {
    expect(restoreAppSteps(branchDef, refsWith('요구', '요구 정리'), msg('요구'))).toMatchObject({ ok: true, records: [{ name: '정리', status: 'completed', reused: true, branch: '요구 정리' }, { name: '작성', status: 'pending' }, { name: '검토', status: 'pending' }] });
    const plain = restoreAppSteps(branchDef, refsWith('질의'), msg('질의'));
    expect(plain).toMatchObject({ ok: true, records: [{ name: '정리', status: 'completed', reused: true }, { name: '작성', status: 'pending' }, { name: '검토', status: 'pending' }] });
    expect((plain as { records: { branch?: string }[] }).records[0]).not.toHaveProperty('branch');
  });
  it('rejects a reused result made under a branch the current definition no longer chooses (or vice versa)', () => {
    expect(restoreAppSteps(branchDef, refsWith('요구'), msg('요구')).ok).toBe(false);
    expect(restoreAppSteps(branchDef, refsWith('요구', '옛 갈래'), msg('요구')).ok).toBe(false);
    expect(restoreAppSteps(branchDef, refsWith('질의', '요구 정리'), msg('질의')).ok).toBe(false);
  });
});
