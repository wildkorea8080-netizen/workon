import { beforeEach, describe, it, expect, vi } from 'vitest';
import { createHash } from 'crypto';
import { NextRequest } from 'next/server';
import { loadBuiltinTemplate, findBuiltinTemplate } from '@/lib/builtin-templates';
import { buildAppResultHwpx } from '@/lib/apps/export';
import { extractTextFromHwp } from '@/lib/hwp';
import { checkPackage } from '@/lib/work/documents/package-check';

const state = vi.hoisted(() => ({ session: true, actor: true, conversation: true, ownAgent: true, otherOrg: false, race: false, bytes: null as Buffer | null, content: '가상 행사 참석자는 30명입니다.', refs: {} as Record<string, unknown>, cached: false, queries: [] as unknown[], saves: 0 }));
vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => state.session ? { user: { id: 'me' } } : null }));
vi.mock('@/lib/actor-scope', () => ({ getActorScope: async () => state.actor ? { userId: 'me', organizationId: 'org', departmentId: 'dept', visibleDepartmentIds: ['dept'] } : null }));
vi.mock('@/lib/generated-files', () => ({ safeFileName: (name: string) => `${name}.hwpx`, saveGeneratedFile: async (input: { bytes: Buffer }) => { state.saves++; state.bytes = input.bytes; if (state.race) { state.cached = true; throw new Error('duplicate'); } return { id: 'file', file_name: '결과.hwpx', size_bytes: 100 }; } }));
vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: { from(table: string) {
  const q = { select: () => q, eq: (key: string, value: unknown) => { state.queries.push([table, key, value]); return q; }, order: () => q, limit: () => q, maybeSingle: async () => ({ error: null, data: table === 'conversations' ? state.conversation ? { id: 'conv', agent_id: 'a' } : null : table === 'agents' ? { id: 'a', name: '시험 앱', tier: 'personal', owner_id: state.ownAgent ? 'me' : 'other', organization_id: state.otherOrg ? 'other' : 'org', is_active: true } : table === 'messages' ? { id: 'message', content: state.content, source_references: state.refs, agent_version: 3 } : state.cached ? { id: 'cached', file_name: '결과.hwpx', size_bytes: 100 } : null }) }; return q;
} } }));
import { POST } from '@/app/api/apps/export/route';
const id = '11111111-1111-4111-8111-111111111111';
function req(extra: Record<string, unknown> = {}) { return new NextRequest('http://localhost/api/apps/export', { method: 'POST', body: JSON.stringify({ conversationId: id, expectedHash: createHash('sha256').update(state.content).digest('hex'), ...extra }) }); }
beforeEach(() => { Object.assign(state, { session: true, actor: true, conversation: true, ownAgent: true, refs: {}, cached: false, otherOrg: false, race: false, bytes: null, saves: 0, queries: [] }); });

describe('HWPX answer export authorization and integrity', () => {
  it('requires login', async () => { state.session = false; expect((await POST(req())).status).toBe(401); expect(state.queries).toEqual([]); });
  it('requires organization membership', async () => { state.actor = false; expect((await POST(req())).status).toBe(403); });
  it('rejects malformed ids', async () => { expect((await POST(req({ conversationId: '../other' }))).status).toBe(400); expect(state.saves).toBe(0); });
  it('does not expose conversations owned by others', async () => { state.conversation = false; expect((await POST(req())).status).toBe(404); expect(state.queries).toContainEqual(['conversations', 'user_id', 'me']); expect(state.saves).toBe(0); });
  it('rechecks current agent access', async () => { state.ownAgent = false; expect((await POST(req())).status).toBe(403); expect(state.saves).toBe(0); });
  it('rejects a different displayed answer', async () => { expect((await POST(req({ expectedHash: '0'.repeat(64) }))).status).toBe(409); expect(state.saves).toBe(0); });
  it('rejects interrupted stage outputs', async () => { state.refs = { app_steps: [{ status: 'completed' }, { status: 'failed' }] }; expect((await POST(req())).status).toBe(409); expect(state.saves).toBe(0); });
  it('allows intentionally skipped stages when the final answer completed', async () => { state.refs = { app_steps: [{ status: 'skipped' }, { status: 'completed' }] }; expect((await POST(req())).status).toBe(200); expect(state.saves).toBe(1); });
  it('reuses an existing artifact instead of generating another file', async () => { state.cached = true; const response = await POST(req()); expect((await response.json()).data.id).toBe('cached'); expect(state.saves).toBe(0); });
  it('denies access after an organization change', async () => { state.otherOrg = true; expect((await POST(req())).status).toBe(403); expect(state.saves).toBe(0); });
  it('returns the winning artifact after a concurrent insert', async () => { state.race = true; expect((await (await POST(req())).json()).data.id).toBe('cached'); expect(state.saves).toBe(1); });
  it('uses the stored answer and ignores client-supplied replacement text', async () => { const response = await POST(req({ content: '임의로 바꾼 본문' })); expect(response.status).toBe(200); expect(state.saves).toBe(1); expect(state.queries).toContainEqual(['messages', 'role', 'assistant']); const text = await extractTextFromHwp(state.bytes!, 'result.hwpx'); expect(text).toContain(state.content); expect(text).not.toContain('임의로 바꾼 본문'); });
});

describe('actual report template packaging', () => {
  it('preserves text, notes and citations while removing irrelevant empty sections', async () => {
    const template = (await loadBuiltinTemplate(findBuiltinTemplate('builtin:report')!))!;
    const content = '가상 행사: 30명\n새빛회의실 & 검토 <필요>\n- 확정일은 미정입니다.';
    const bytes = await buildAppResultHwpx(template, { name: '안내문 앱', version: 3, content, createdAt: '시험 시각', references: { documents_skipped: true, number_check: { unverified: ['99'] }, chunks: [{ n: 1, documentTitle: '행사 자료', page: 2 }] } });
    const text = await extractTextFromHwp(bytes, 'result.hwpx');
    expect(text).toContain('30명'); expect(text).toContain('새빛회의실 & 검토 <필요>'); expect(text).toContain('[AI 작성 초안]'); expect(text).toContain('확인되지 않은 숫자: 99'); expect(text).toContain('행사 자료');
    expect(text).not.toContain('□ 추진 경과'); expect(text).not.toContain('□ 향후 계획');
    expect((await checkPackage(bytes, { format: 'hwpx' })).valid).toBe(true);
  });
  it('removes markdown markers from the stored answer but keeps every word and number', async () => {
    const template = (await loadBuiltinTemplate(findBuiltinTemplate('builtin:report')!))!;
    const content = '## 개강식 안내문 — 초안\n---\n**참석 안내**\n- **다과비:** 1인당 8,000원 → [확인 필요]\n| 구분 | 인원 |\n|---|---:|\n| 강사 | 2명 |\n> ※ 초안입니다.';
    const bytes = await buildAppResultHwpx(template, { name: '안내문 앱', version: 1, content, createdAt: '시험 시각', references: {} });
    const text = await extractTextFromHwp(bytes, 'result.hwpx');
    for (const kept of ['개강식 안내문 — 초안', '참석 안내', '- 다과비: 1인당 8,000원 → [확인 필요]', '구분 | 인원', '강사 | 2명', '※ 초안입니다.']) expect(text).toContain(kept);
    for (const marker of ['**', '## ', '---', '> ※']) expect(text).not.toContain(marker);
    expect((await checkPackage(bytes, { format: 'hwpx' })).valid).toBe(true);
  });
});
