import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

/** 원문에서 보기(2026-11-06) — 원본을 글로 다시 읽고 근거 자리를 칠한다. 스캔 PDF는 NODA로 보내지 않는다 */

const state = vi.hoisted(() => ({
  session: { user: { id: 'me' } } as unknown,
  results: {} as Record<string, { data?: unknown; error?: { message: string } | null }[]>,
  blob: { ok: true, size: 10 } as { ok: boolean; size: number },
  read: { mode: 'ok' as 'ok' | 'scan' | 'broken' | 'crash', text: '본문', warnings: [] as string[] },
  agent: null as unknown,
}));
vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => state.session }));
vi.mock('@/lib/actor-scope', () => ({ getActorScope: async () => ({ userId: 'me', isAdmin: false, organizationId: 'org', departmentId: 'dept', visibleDepartmentIds: ['dept'], managedDepartmentIds: [], managesWholeOrganization: false }) }));
vi.mock('@/lib/agent-store', () => ({ loadAgentAccess: async () => state.agent }));
vi.mock('@/lib/attachments/reader', () => {
  class AttachmentReadError extends Error { constructor(message: string, readonly cause?: unknown) { super(message); } }
  return {
    AttachmentReadError,
    readAttachment: async (_bytes: Buffer, _name: string, deps: { parseScanned?: () => Promise<unknown> }) => {
      if (state.read.mode === 'scan') { try { await deps.parseScanned!(); } catch (e) { throw new AttachmentReadError('읽지 못했습니다', e); } }
      if (state.read.mode === 'broken') throw new AttachmentReadError('파일이 깨져 읽지 못했습니다.');
      if (state.read.mode === 'crash') throw new Error('boom');
      return { text: state.read.text, warnings: state.read.warnings, tables: [] };
    },
  };
});
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) q[m] = () => q;
      q.maybeSingle = () => Promise.resolve({ data: null, error: null, ...(state.results[table]?.shift() ?? {}) });
      return q;
    },
    storage: { from: () => ({ download: async () => (state.blob.ok ? { data: { size: state.blob.size, arrayBuffer: async () => new ArrayBuffer(4) }, error: null } : { data: null, error: { message: 'x' } }) }) },
  },
}));

import { NextRequest } from 'next/server';
import { locatePassage } from '@/components/chat/source-locate';
import { sourceTextHref } from '@/components/chat/source-label';
import { ORIGINAL_TEXT_MAX_BYTES, readOriginalText } from '@/lib/source-original';
import { GET as agentText } from '@/app/api/documents/[id]/text/route';
import { GET as commonText } from '@/app/api/common-documents/[id]/text/route';
import SourceTextViewer from '@/components/chat/SourceTextViewer';

const ID = '11111111-0000-4000-8000-00000000000a';
beforeEach(() => {
  state.session = { user: { id: 'me' } }; state.results = {}; state.blob = { ok: true, size: 10 };
  state.read = { mode: 'ok', text: '본문', warnings: [] };
  state.agent = { id: 'ag', tier: 'official', department_id: 'dept', organization_id: 'org', visibility: 'organization', owner_id: null, created_by: 'x', is_active: true, is_published: true, deleted_at: null, approval_status: null, version: 1, approval_version: null };
});

describe('근거 자리 찾기', () => {
  const doc = '제1장 총칙\n\n제5조(국내 출장)\n| 구분 | 일비 |\n| --- | --- |\n| 공무원 | 2만원 |\n국내 출장 일비는 하루 2만원으로 하고, 식비는 별도로 지급한다.\n\n제6조(국외 출장)\n국외 출장은 별표 2에 따른다.';

  it('줄바꿈·표 선·공백이 달라도 글자·숫자로 맞춰 원문 위치로 되돌린다', () => {
    const passage = '[1] 규정.hwpx · 3쪽\n국내 출장 일비는 하루 2만원으로 하고,\n식비는 별도로 지급한다.';
    const at = locatePassage(doc, passage)!;
    expect(doc.slice(at.start, at.end)).toBe('국내 출장 일비는 하루 2만원으로 하고, 식비는 별도로 지급한다');
  });

  it('표 꼴이 달라도(마크다운 표 ↔ 칸 글) 찾는다', () => {
    const at = locatePassage(doc, '구분 일비 공무원 2만원 국내 출장');
    expect(at && doc.slice(at.start, at.end)).toContain('공무원 | 2만원');
  });

  it('못 찾음·너무 짧음·빈 원문은 null, 앞 조각이 여러 번 나오면 다른 조각으로', () => {
    expect(locatePassage(doc, '전혀 다른 문서의 내용이 들어 있는 근거 발췌입니다 정말로')).toBeNull();
    expect(locatePassage(doc, '국외 출장')).toBeNull();
    expect(locatePassage('', '국내 출장 일비는 하루 2만원으로 하고')).toBeNull();
    const repeated = '반복되는 머리말 글입니다 반복되는 머리말 글입니다\n가\n반복되는 머리말 글입니다 반복되는 머리말 글입니다\n그리고 여기가 진짜 근거가 되는 고유한 문장입니다 끝';
    const at = locatePassage(repeated, '반복되는 머리말 글입니다 반복되는 머리말 글입니다\n그리고 여기가 진짜 근거가 되는 고유한 문장입니다 끝');
    expect(at && repeated.slice(at.start, at.end)).toContain('고유한 문장입니다 끝');
  });
});

describe('원본 글 읽기', () => {
  it('읽은 글과 잘림 여부, 스캔 PDF는 NODA 없이 안내, 깨진 파일은 그 안내, 너무 크면 413', async () => {
    state.read = { mode: 'ok', text: '규정 본문', warnings: ['본문이 길어 앞의 200,000자만 읽었습니다'] };
    expect(await readOriginalText('p', '규정.hwpx')).toEqual({ ok: true, text: '규정 본문', truncated: true });
    state.read.mode = 'scan';
    expect(await readOriginalText('p', '스캔.pdf')).toMatchObject({ ok: false, status: 422, message: expect.stringContaining('스캔본') });
    state.read.mode = 'broken';
    expect(await readOriginalText('p', 'x.docx')).toMatchObject({ ok: false, status: 422, message: '파일이 깨져 읽지 못했습니다.' });
    state.read.mode = 'crash';
    expect(await readOriginalText('p', 'x.docx')).toMatchObject({ ok: false, status: 500 });
    state.blob = { ok: true, size: ORIGINAL_TEXT_MAX_BYTES + 1 };
    expect(await readOriginalText('p', 'x.docx')).toMatchObject({ status: 413 });
    state.blob = { ok: false, size: 0 };
    expect(await readOriginalText('p', 'x.docx')).toMatchObject({ status: 503 });
  });
});

describe('라우트', () => {
  const call = (handler: typeof agentText, id = ID) => handler(new NextRequest('http://localhost/x'), { params: { id } });
  it('비서 문서 — 로그인 없음 401, 이상한 id·없는 문서·못 쓰는 비서 404, 열 수 있으면 글', async () => {
    state.session = null;
    expect((await call(agentText)).status).toBe(401);
    state.session = { user: { id: 'me' } };
    expect((await call(agentText, 'x')).status).toBe(404);
    expect((await call(agentText)).status).toBe(404);
    const row = { id: ID, agent_id: 'ag', organization_id: 'org', department_id: 'dept', visibility: 'organization', storage_path: 'p', file_name: '규정.hwpx', file_type: 'hwpx', noda_status: 'ready' };
    state.results.documents = [{ data: row }];
    state.agent = { ...(state.agent as object), tier: 'personal', owner_id: 'someone' };
    expect((await call(agentText)).status).toBe(404);
    state.agent = { ...(state.agent as object), tier: 'official', owner_id: null };
    state.results.documents = [{ data: row }];
    const res = await call(agentText);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ fileName: '규정.hwpx', text: '본문', truncated: false });
  });

  it('공통 자료실 — 같은 유형이면 글, 다른 유형 404, 조회 실패 503', async () => {
    const row = { id: ID, org_type: '공공기관', storage_path: 'c', file_name: '기준.pdf', file_type: 'pdf', noda_status: 'ready' };
    state.results.organizations = [{ data: { type: '공공기관' } }];
    state.results.common_documents = [{ data: row }];
    expect((await call(commonText)).status).toBe(200);
    state.results.organizations = [{ data: { type: '교육기관' } }];
    state.results.common_documents = [{ data: row }];
    expect((await call(commonText)).status).toBe(404);
    state.results.organizations = [{ error: { message: 'down' } }];
    expect((await call(commonText)).status).toBe(503);
  });
});

describe('화면', () => {
  it('주소·근거 창 단추(원문이 있는 근거만)·보기 창', () => {
    expect(sourceTextHref({ documentId: ID.toUpperCase() })).toBe(`/api/documents/${ID}/text`);
    expect(sourceTextHref({ documentId: ID, scope: 'common' })).toBe(`/api/common-documents/${ID}/text`);
    expect(sourceTextHref({ documentId: 'x' })).toBeNull();
    const panel = readFileSync('src/components/chat/SourcePanel.tsx', 'utf8');
    expect(panel).toContain('{textHref && text && (');
    expect(panel).toContain('<SourceTextViewer href={textHref} title={title} passage={text}');
    const html = renderToStaticMarkup(createElement(SourceTextViewer, { href: '/x', title: '규정', passage: 'p', onClose: () => {} }));
    expect(html).toContain('원문을 읽는 중');
    expect(html).toContain('aria-label="원문에서 보기"');
  });
});
