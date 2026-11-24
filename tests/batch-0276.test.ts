import { readFileSync } from 'fs';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { createHash } from 'crypto';
import { NextRequest } from 'next/server';
import { loadBuiltinTemplate, findBuiltinTemplate } from '@/lib/builtin-templates';
import { buildAppResultHwpx } from '@/lib/apps/export';
import { extractTextFromHwp } from '@/lib/hwp';

/**
 * 2026-11-23 — 일반 대화 답변을 한글(HWPX) 파일로 받기.
 * 예전엔 입력형 앱 결과만 한글 파일로 받을 수 있어, 직원이 대화 답변을 복사해 한글에 붙여 넣었다(출처·AI 초안 안내가 빠졌다).
 * 이제 저장된 답변마다 '한글 파일로 받기' — 같은 내보내기 길, 저장된 답을 그대로(모델 호출 없음), 질문·비서 이름·출처를 함께 싣는다.
 * 근거로 고쳐 쓴 답이 있으면 그 답도 받는다.
 */

const builtin = async (ref: string) => (await loadBuiltinTemplate(findBuiltinTemplate(ref)!))!;
const textOf = (bytes: Buffer) => extractTextFromHwp(bytes, 'a.hwpx');

describe('파일 내용 — buildAppResultHwpx', () => {
  it('대화 답변은 비서 이름·판·질문을 싣고 제목을 질문으로 단다(앱 줄 없음)', async () => {
    const bytes = await buildAppResultHwpx(await builtin('builtin:report'), {
      name: '규정 안내 비서', version: 4, content: '국내 출장 일비는 2만 원입니다 [1].', createdAt: '시험 시각', kind: 'answer',
      question: '[첨부 파일: x.pdf]\n국내 출장 일비는 얼마인가요? 그리고 숙박비 상한은 어떻게 되나요? 지역별로 알려 주세요.',
      references: { chunks: [{ n: 1, documentTitle: '여비 규정', page: 3 }, { n: 2, documentTitle: '공무원 여비 기준', scope: 'common', editionYear: 2026, section: '제2장 › 일비' }] },
    });
    const text = await textOf(bytes);
    expect(text).toContain('비서: 규정 안내 비서');
    expect(text).toContain('비서 설정 판: 4');
    expect(text).toContain('질문: [첨부 파일: x.pdf] 국내 출장 일비는 얼마인가요?');
    expect(text).toContain('[AI 작성 초안] [첨부 파일: x.pdf] 국내 출장 일비는 얼마인가요? 그리고 숙박비 …');
    expect(text).toContain('[1] 여비 규정 · 3쪽');
    expect(text).toContain('[2] [공통] 공무원 여비 기준(2026) · 제2장 › 일비');
    expect(text).not.toContain('앱: ');
    expect(text).toContain('국내 출장 일비는 2만 원입니다');
  });

  it('고쳐 쓴 답은 그렇다고 밝힌다 — 앱 결과(기본)는 예전 그대로', async () => {
    const revised = await textOf(await buildAppResultHwpx(await builtin('builtin:report'), { name: '비서', version: null, content: '고친 답', createdAt: '시험', references: {}, kind: 'answer', revised: true }));
    expect(revised).toContain('근거로 고쳐 쓴 답입니다');
    expect(revised).toContain('[AI 작성 초안] 비서');
    const app = await textOf(await buildAppResultHwpx(await builtin('builtin:report'), { name: '공문 앱', version: 2, content: '결과', createdAt: '시험', references: {} }));
    expect(app).toContain('앱: 공문 앱');
    expect(app).toContain('실행 설정 버전: 2');
    expect(app).not.toContain('비서: ');
  });
});

// ── 라우트 ──
const REVISED = '고쳐 쓴 답: 일비는 2만 5천 원입니다.';
const state = vi.hoisted(() => ({
  appDefinition: null as unknown, refs: {} as Record<string, unknown>, content: '원래 답: 일비는 2만 원입니다.',
  question: { data: { content: '일비가 얼마인가요?' }, error: null } as { data: unknown; error: unknown } | 'throw',
  saved: null as null | { templateRef: string; templateName: string; fileName: string; bytes: Buffer }, saves: 0,
}));
vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => ({ user: { id: 'me' } }) }));
vi.mock('@/lib/actor-scope', () => ({ getActorScope: async () => ({ userId: 'me', organizationId: 'org', departmentId: 'dept', visibleDepartmentIds: ['dept'] }) }));
vi.mock('@/lib/generated-files', () => ({ safeFileName: (name: string) => `${name}.hwpx`, saveGeneratedFile: async (row: { templateRef: string; templateName: string; fileName: string; bytes: Buffer }) => { state.saves++; state.saved = row; return { id: 'file', file_name: row.fileName, size_bytes: 100 }; } }));
vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {
  storage: { from: () => ({ download: async () => ({ data: null, error: { message: 'none' } }) }) },
  from(table: string) {
    const filters: Record<string, unknown> = {};
    const q = {
      select: () => q, order: () => q, limit: () => q, lte: () => q,
      eq: (key: string, value: unknown) => { filters[key] = value; return q; },
      is: () => q,
      then: (resolve: (r: unknown) => unknown) => resolve({ error: null, data: [] }),
      maybeSingle: async () => {
        if (table === 'conversations') return { error: null, data: { id: 'conv', agent_id: 'a' } };
        if (table === 'agents') return { error: null, data: { id: 'a', name: '규정 비서', tier: 'personal', owner_id: 'me', organization_id: 'org', is_active: true, app_definition: state.appDefinition } };
        if (table === 'messages' && filters.role === 'user') {
          if (state.question === 'throw') throw new Error('boom');
          return state.question;
        }
        if (table === 'messages') return { error: null, data: { id: 'message', content: state.content, source_references: state.refs, agent_version: 3, created_at: '2026-11-23T01:00:00.000Z' } };
        return { error: null, data: null };
      },
    };
    return q;
  },
} }));
import { POST } from '@/app/api/apps/export/route';

const conv = '11111111-1111-4111-8111-111111111111';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
async function post(extra: Record<string, unknown> = {}, text = state.content) {
  const res = await POST(new NextRequest('http://localhost/api/apps/export', { method: 'POST', body: JSON.stringify({ conversationId: conv, expectedHash: sha(text), ...extra }) }));
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  Object.assign(state, { appDefinition: null, refs: {}, saved: null, saves: 0, question: { data: { content: '[첨부 파일: 표.xlsx]\n일비가 얼마인가요?' }, error: null } });
});

describe('POST /api/apps/export — 대화 답변', () => {
  it('일반 비서의 답은 \'대화 답변\'으로, 질문(첨부 표시 줄 뗌)과 함께', async () => {
    const out = await post();
    expect(out.status).toBe(200);
    expect(state.saved!.templateName).toBe('대화 답변');
    expect(state.saved!.fileName).toBe('규정 비서 답변.hwpx');
    const text = await textOf(state.saved!.bytes);
    expect(text).toContain('질문: 일비가 얼마인가요?');
    expect(text).not.toContain('첨부 파일: 표.xlsx');
    expect(text).toContain('비서: 규정 비서');
    expect(text).toContain(state.content);
  });

  it('앱 비서(앱 정의 있음)는 예전처럼 \'앱 실행 결과\' — 질문을 찾지 않는다', async () => {
    state.appDefinition = { steps: [] };
    state.question = 'throw';
    expect((await post()).status).toBe(200);
    expect(state.saved!.templateName).toBe('앱 실행 결과');
    expect(state.saved!.fileName).toBe('규정 비서 작성 결과.hwpx');
    expect(await textOf(state.saved!.bytes)).toContain('앱: 규정 비서');
  });

  it('질문을 못 읽어도 파일은 만든다(질문 줄만 없이)', async () => {
    state.question = 'throw';
    expect((await post()).status).toBe(200);
    expect(await textOf(state.saved!.bytes)).not.toContain('질문:');
    state.question = { data: null, error: { code: 'XX000' } };
    expect((await post()).status).toBe(200);
  });

  it('근거로 고쳐 쓴 답 — 고친 글의 해시로 맞대고, 고친 답의 근거로 담는다', async () => {
    state.refs = { revision: { status: 'done', text: REVISED, chunks: [{ documentId: 'd1', documentTitle: '여비 규정', page: 7, chunkIndex: 0, n: 1, text: '…' }], number_check: { unverified: [] }, revised_numbers: ['2만'], created_at: '2026-11-23T01:00:00.000Z' } };
    const out = await post({ variant: 'revised' }, REVISED);
    expect(out.status).toBe(200);
    expect(state.saved!.templateName).toBe('대화 답변(고쳐 쓴 답)');
    expect(state.saved!.fileName).toBe('규정 비서 답변(고쳐 쓴 답).hwpx');
    expect(state.saved!.templateRef).toBe(`app-result:message:${sha(REVISED)}`);
    const text = await textOf(state.saved!.bytes);
    expect(text).toContain(REVISED);
    expect(text).toContain('근거로 고쳐 쓴 답입니다');
    expect(text).toContain('[1] 여비 규정 · 7쪽');
    expect(text).not.toContain('원래 답: 일비는');
  });

  it('고친 답이 없으면 404, 원래 답의 해시로 고친 답을 달라면 409, 모르는 variant는 400 — 파일을 만들지 않는다', async () => {
    expect((await post({ variant: 'revised' }, REVISED)).status).toBe(404);
    state.refs = { revision: { status: 'done', text: REVISED, chunks: [] } };
    expect((await post({ variant: 'revised' })).status).toBe(409);
    expect((await post({ variant: 'other' })).status).toBe(400);
    expect(state.saves).toBe(0);
  });
});

describe('화면', () => {
  it('앱이 아닌 저장된 답에 \'한글 파일로 받기\' — 고쳐 쓴 답이 있으면 담을 답을 고른다', () => {
    const chat = readFileSync('src/components/chat/ChatInterface.tsx', 'utf8');
    expect(chat).toMatch(/!\(selectedAgent\.app_definition \|\| msg\.appSteps\) && \(\s*<AnswerExport/);
    const exp = readFileSync('src/components/chat/AnswerExport.tsx', 'utf8');
    expect(exp).toContain("variant={useRevised ? 'revised' : undefined}");
    expect(exp).toContain('content={useRevised && revision ? revision.text : content}');
    const panel = readFileSync('src/components/apps/AppResultExport.tsx', 'utf8');
    expect(panel).toContain('...(variant ? { variant } : {})');
  });
});
