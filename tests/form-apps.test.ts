import { describe, it, expect } from 'vitest';
import { validateAppDefinition, renderAppInput, appOutputInstruction, type AppDefinition } from '@/lib/apps/definition';
import { splitAgentBody } from '@/lib/agent-patch';
import { readAppStream } from '@/lib/apps/stream';
const definition: AppDefinition = { schemaVersion: 1, fields: [{ key: 'source', label: '원문', type: 'textarea', required: true }, { key: 'style', label: '문체', type: 'select', required: false, options: ['공문체', '쉬운 말'] }], output: 'bullets' };
describe('bounded form app contract', () => {
  it('normalizes supported definitions without retaining extra properties', () => { expect(validateAppDefinition({ ...definition, executeCode: 'bad' })).toEqual({ ok: true, value: definition }); });
  it.each([{}, { ...definition, fields: [] }, { ...definition, fields: Array(9).fill(definition.fields[0]) }, { ...definition, fields: [definition.fields[0], definition.fields[0]] }, { ...definition, fields: [{ ...definition.fields[0], key: '../bad' }] }, { ...definition, fields: [{ ...definition.fields[1], options: ['same', 'same'] }] }, { ...definition, output: 'execute' }])('rejects malformed schemas: %j', raw => { expect(validateAppDefinition(raw).ok).toBe(false); });
  it('requires fields and rejects unknown keys or invalid selections', () => { for (const raw of [{}, { source: 'x', extra: 'x' }, { source: 'x', style: 'unknown' }, { source: ['x'] }]) expect(renderAppInput(definition, raw).ok).toBe(false); });
  it('keeps submitted data bounded and escaped in the server-generated request', () => { const r = renderAppInput(definition, { source: '내용\n"지시문"', style: '공문체' }); expect(r.ok).toBe(true); if (r.ok) expect(r.message).toContain('내용\\n\\"지시문\\"'); expect(renderAppInput(definition, { source: 'x'.repeat(6001) }).ok).toBe(false); });
  it('checks numbers and real calendar dates', () => { const d: AppDefinition = { schemaVersion: 1, fields: [{ key: 'n', label: '수', type: 'number', required: true }, { key: 'd', label: '날짜', type: 'date', required: true }], output: 'paragraphs' }; expect(renderAppInput(d, { n: '-12.5', d: '2028-02-29' }).ok).toBe(true); expect(renderAppInput(d, { n: 'NaN', d: '2028-02-29' }).ok).toBe(false); expect(renderAppInput(d, { n: '1', d: '2026-02-29' }).ok).toBe(false); });
  it('stores schemas only after server validation and rejects link apps', () => { const opts = { currentType: 'chat' as const, knownConnectorIds: [], knownModelIds: [] }; expect(splitAgentBody({ app_definition: definition }, opts).settings.app_definition).toEqual(definition); expect(splitAgentBody({ app_definition: definition }, { ...opts, currentType: 'link' }).error).toBeTruthy(); expect(splitAgentBody({ app_definition: {} }, opts).error).toBeTruthy(); });
  it('adds bounded output instructions', () => { expect(appOutputInstruction(definition)).toContain('글머리 목록'); });
});
describe('app SSE reader', () => {
  const stream = (text: string) => new ReadableStream<Uint8Array>({ start(c) { const bytes = new TextEncoder().encode(text); for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); } });
  it('handles split UTF-8 and event boundaries', async () => { const events: string[] = []; await readAppStream(stream('event: delta\ndata: {"text":"초안"}\n\nevent: done\ndata: {}\n\n'), (name, data) => events.push(`${name}:${data.text ?? ''}`)); expect(events).toEqual(['delta:초안', 'done:']); });
  it('does not report a truncated stream as completed', async () => { await expect(readAppStream(stream('event: delta\ndata: {"text":"일부"}\n\n'), () => {})).rejects.toThrow('중단'); });
  it('surfaces server errors', async () => { await expect(readAppStream(stream('event: error\ndata: {"message":"실행 실패"}\n\n'), () => {})).rejects.toThrow('실행 실패'); });
});
