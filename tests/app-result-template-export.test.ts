import { beforeEach, describe, it, expect, vi } from 'vitest';
import { createHash } from 'crypto';
import { NextRequest } from 'next/server';
import { loadBuiltinTemplate, findBuiltinTemplate } from '@/lib/builtin-templates';
import { AppExportTemplateError, buildAppResultInTemplate } from '@/lib/apps/export';
import { extractTextFromHwp } from '@/lib/hwp';
import { checkPackage } from '@/lib/work/documents/package-check';
import { readHwpxTables } from '@/lib/attachments/tables-hwpx';

const builtin = async (ref: string) => (await loadBuiltinTemplate(findBuiltinTemplate(ref)!))!;
const input = (content: string, references: Record<string, unknown> = {}) => ({ name: '공문 앱', version: 2, content, createdAt: '시험 시각', references });

describe('기관 양식에 결과 담기 — buildAppResultInTemplate', () => {
  it('공문 양식: {{본문}}에 결과, {{제목}}에 AI 초안 제목 — {{개요}}가 없으면 AI 초안·확인 안내를 본문 맨 앞에, 나머지 표시는 빈 칸으로 이름을 돌려준다', async () => {
    const { bytes, emptied } = await buildAppResultInTemplate(await builtin('builtin:official_letter'), input('행사 참석 인원은 30명입니다.\n- 장소: 새빛회의실', { number_check: { unverified: ['99'] }, chunks: [{ n: 1, documentTitle: '행사 자료', page: 2 }] }));
    const text = await extractTextFromHwp(bytes, 'result.hwpx');
    for (const kept of ['[AI 작성 초안] 공문 앱', 'AI가 작성한 초안입니다', '확인되지 않은 숫자: 99', '행사 참석 인원은 30명입니다.', '- 장소: 새빛회의실', '[1] 행사 자료 · 2쪽']) expect(text).toContain(kept);
    expect(text.indexOf('AI가 작성한 초안입니다')).toBeLessThan(text.indexOf('행사 참석 인원은 30명입니다.'));
    expect(text).not.toContain('{{');
    expect(emptied).toEqual(['행정기관명', '수신', '경유', '붙임', '발신명의', '공개구분']);
    expect((await checkPackage(bytes, { format: 'hwpx' })).valid).toBe(true);
  });

  it('{{개요}}가 있는 양식은 안내를 개요에, 결과는 {{주요 내용}}에 — 표준 보고서의 빈 구역 지우기는 하지 않고 빈 칸으로 돌려준다', async () => {
    const { bytes, emptied } = await buildAppResultInTemplate(await builtin('builtin:report'), input('주요 결과 본문'));
    const text = await extractTextFromHwp(bytes, 'result.hwpx');
    expect(text).toContain('파일 생성: 시험 시각');
    expect(text.indexOf('AI가 작성한 초안입니다')).toBeLessThan(text.indexOf('주요 결과 본문'));
    expect(text.match(/AI가 작성한 초안입니다/g)).toHaveLength(1);
    expect(emptied).toEqual(['작성부서', '추진 경과', '향후 계획', '건의 사항']);
    expect(text).not.toContain('{{');
  });

  it('마크다운 표는 기관 양식에서도 진짜 한글 표로', async () => {
    const { bytes } = await buildAppResultInTemplate(await builtin('builtin:official_letter'), input('예산 현황\n| 구분 | 금액 |\n|---|---:|\n| 국비 | 1,200 |'));
    expect((await readHwpxTables(bytes)).tables.map(t => t.cells)).toContainEqual([['구분', '금액'], ['국비', '1,200']]);
    expect((await checkPackage(bytes, { format: 'hwpx' })).valid).toBe(true);
  });

  it('본문 표시가 없는 양식(회의록)은 넣을 곳을 짐작하지 않고 거절한다', async () => {
    const err = await buildAppResultInTemplate(await builtin('builtin:minutes'), input('결과')).catch(e => e);
    expect(err).toBeInstanceOf(AppExportTemplateError);
    expect(err.message).toContain('{{주요 내용}}');
  });

  it('HWPX가 아닌 바이트는 거절한다', async () => {
    const err = await buildAppResultInTemplate(Buffer.from('not a zip'), input('결과')).catch(e => e);
    expect(err).toBeInstanceOf(AppExportTemplateError);
  });
});

// ── 라우트 ──
const state = vi.hoisted(() => ({
  session: true, ownAgent: true, content: '가상 결과 본문입니다.', cached: false, saves: 0, refs: [] as string[],
  templates: [] as { id: string; name: string; file_name: string; storage_path: string; agent_id: string }[],
  template: null as Buffer | null, downloads: [] as string[], saved: null as null | { templateRef: string; templateName: string; bytes: Buffer },
}));
vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => state.session ? { user: { id: 'me' } } : null }));
vi.mock('@/lib/actor-scope', () => ({ getActorScope: async () => ({ userId: 'me', organizationId: 'org', departmentId: 'dept', visibleDepartmentIds: ['dept'] }) }));
vi.mock('@/lib/generated-files', () => ({ safeFileName: (name: string) => `${name}.hwpx`, saveGeneratedFile: async (row: { templateRef: string; templateName: string; bytes: Buffer }) => { state.saves++; state.saved = row; return { id: 'file', file_name: '결과.hwpx', size_bytes: 100 }; } }));
vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {
  storage: { from: () => ({ download: async (path: string) => { state.downloads.push(path); return state.template ? { data: new Blob([new Uint8Array(state.template)]), error: null } : { data: null, error: { message: 'gone' } }; } }) },
  from(table: string) {
    const filters: Record<string, unknown> = {};
    const q = {
      select: () => q, order: () => q, limit: () => q,
      eq: (key: string, value: unknown) => { filters[key] = value; if (key === 'template_ref') state.refs.push(String(value)); return q; },
      is: (key: string, value: unknown) => { filters[key] = value; return q; },
      then: (resolve: (r: unknown) => unknown) => resolve({ error: null, data: table === 'agent_templates' ? state.templates.filter(t => t.agent_id === filters.agent_id) : [] }),
      maybeSingle: async () => ({ error: null, data: table === 'conversations' ? { id: 'conv', agent_id: 'a' } : table === 'agents' ? { id: 'a', name: '시험 앱', tier: 'personal', owner_id: state.ownAgent ? 'me' : 'other', organization_id: 'org', is_active: true } : table === 'messages' ? { id: 'message', content: state.content, source_references: {}, agent_version: 3 } : state.cached ? { id: 'cached', file_name: '결과.hwpx', size_bytes: 100 } : null }),
    };
    return q;
  },
} }));
import { GET, POST } from '@/app/api/apps/export/route';

const conv = '11111111-1111-4111-8111-111111111111';
const tpl = '22222222-2222-4222-8222-222222222222';
const otherTpl = '33333333-3333-4333-8333-333333333333';
function post(extra: Record<string, unknown> = {}) { return POST(new NextRequest('http://localhost/api/apps/export', { method: 'POST', body: JSON.stringify({ conversationId: conv, expectedHash: createHash('sha256').update(state.content).digest('hex'), ...extra }) })); }
const list = () => GET(new NextRequest(`http://localhost/api/apps/export?conversationId=${conv}`));

beforeEach(async () => {
  Object.assign(state, { session: true, ownAgent: true, cached: false, saves: 0, refs: [], downloads: [], saved: null, template: await builtin('builtin:official_letter'),
    templates: [
      { id: tpl, name: '우리 기관 공문', file_name: '공문.hwpx', storage_path: 'templates/a/공문.hwpx', agent_id: 'a' },
      { id: otherTpl, name: '워드 양식', file_name: '양식.docx', storage_path: 'templates/a/양식.docx', agent_id: 'a' },
      { id: '44444444-4444-4444-8444-444444444444', name: '남의 앱 양식', file_name: '남.hwpx', storage_path: 'templates/b/남.hwpx', agent_id: 'b' },
    ] });
});

describe('GET /api/apps/export — 담을 수 있는 기관 양식', () => {
  it('이 대화 앱의 HWPX 양식만 이름과 id로 — 저장소 경로는 내보내지 않는다', async () => {
    const res = await list(); const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.templates).toEqual([{ id: tpl, name: '우리 기관 공문' }]);
    expect(JSON.stringify(body)).not.toContain('storage_path');
  });
  it('로그인·앱 권한을 다시 본다', async () => {
    state.session = false; expect((await list()).status).toBe(401);
    state.session = true; state.ownAgent = false; expect((await list()).status).toBe(403);
    expect((await GET(new NextRequest('http://localhost/api/apps/export?conversationId=../x'))).status).toBe(400);
  });
});

describe('POST /api/apps/export — templateId', () => {
  it('기관 양식에 담아 저장하고, 빈 칸으로 둔 항목을 돌려준다 — 캐시 열쇠에 양식 id가 붙는다', async () => {
    const res = await post({ templateId: tpl }); const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.emptied).toEqual(['행정기관명', '수신', '경유', '붙임', '발신명의', '공개구분']);
    expect(state.downloads).toEqual(['templates/a/공문.hwpx']);
    expect(state.saved!.templateRef).toMatch(new RegExp(`^app-result:message:[a-f0-9]{64}:${tpl}$`));
    expect(state.saved!.templateName).toBe('우리 기관 공문');
    expect(await extractTextFromHwp(state.saved!.bytes, 'r.hwpx')).toContain(state.content);
  });
  it('표준 보고서는 지금처럼(양식 id 없는 캐시 열쇠, 양식을 내려받지 않음)', async () => {
    expect((await post()).status).toBe(200);
    expect(state.saved!.templateRef).toMatch(/^app-result:message:[a-f0-9]{64}$/);
    expect(state.downloads).toEqual([]);
  });
  it('다른 앱의 양식·없는 양식은 404, DOCX 양식은 422 — 파일을 만들지 않는다', async () => {
    expect((await post({ templateId: '44444444-4444-4444-8444-444444444444' })).status).toBe(404);
    expect((await post({ templateId: '55555555-5555-4555-8555-555555555555' })).status).toBe(404);
    expect((await post({ templateId: otherTpl })).status).toBe(422);
    expect((await post({ templateId: 'x' })).status).toBe(400);
    expect(state.saves).toBe(0); expect(state.downloads).toEqual([]);
  });
  it('본문 표시가 없는 양식은 422로 이유를 보이고, 양식을 못 받으면 503', async () => {
    state.template = await builtin('builtin:minutes');
    const res = await post({ templateId: tpl });
    expect(res.status).toBe(422); expect((await res.json()).error.message).toContain('{{주요 내용}}');
    state.template = null;
    expect((await post({ templateId: tpl })).status).toBe(503);
    expect(state.saves).toBe(0);
  });
  it('이미 만든 파일은 다시 만들지 않는다(같은 양식·같은 답)', async () => {
    state.cached = true;
    expect((await (await post({ templateId: tpl })).json()).data.id).toBe('cached');
    expect(state.saves).toBe(0); expect(state.downloads).toEqual([]);
  });
});
