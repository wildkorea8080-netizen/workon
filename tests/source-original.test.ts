import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';

/** 대화 근거 창의 '원본 열기'(2026-11-05) — 볼 수 있는 문서·쓸 수 있는 비서만, PDF는 그 쪽, 공통 자료실은 같은 기관 유형만 */

const state = vi.hoisted(() => ({
  session: { user: { id: 'me', role: 'USER', departmentId: 'dept' } } as unknown,
  results: {} as Record<string, { data?: unknown; error?: { message: string } | null }[]>,
  calls: [] as unknown[][],
  agent: null as unknown,
  signed: 'https://store.example/sign/p?token=t' as string | null,
}));
vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => state.session }));
vi.mock('@/lib/actor-scope', () => ({
  getActorScope: async () => ({ userId: 'me', isAdmin: false, organizationId: 'org', departmentId: 'dept', visibleDepartmentIds: ['dept', 'parent'], managedDepartmentIds: [], managesWholeOrganization: false }),
}));
vi.mock('@/lib/agent-store', () => ({ loadAgentAccess: async () => state.agent }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) q[m] = (...args: unknown[]) => { state.calls.push([table, m, ...args]); return q; };
      q.maybeSingle = () => Promise.resolve({ data: null, error: null, ...(state.results[table]?.shift() ?? {}) });
      return q;
    },
    storage: { from: () => ({ createSignedUrl: async () => (state.signed ? { data: { signedUrl: state.signed }, error: null } : { data: null, error: { message: 'x' } }) }) },
  },
}));

import { NextRequest } from 'next/server';
import { GET as getAgentOriginal } from '@/app/api/documents/[id]/original/route';
import { GET as getCommonOriginal } from '@/app/api/common-documents/[id]/original/route';
import { canOpenAgentOriginal, canOpenCommonOriginal, originalUrl, parsePage, type AgentOriginalDoc, type CommonOriginalDoc } from '@/lib/source-original';
import { sourceOriginalHref } from '@/components/chat/source-label';
import type { ActorScope, AgentAccessInfo } from '@/lib/agent-permissions';

const ID = '11111111-0000-4000-8000-00000000000a';
const actor: ActorScope = { userId: 'me', isAdmin: false, organizationId: 'org', departmentId: 'dept', visibleDepartmentIds: ['dept', 'parent'], managedDepartmentIds: [], managesWholeOrganization: false };
const doc = (over: Partial<AgentOriginalDoc> = {}): AgentOriginalDoc => ({
  id: ID, agent_id: 'ag', organization_id: 'org', department_id: 'dept', visibility: 'organization', storage_path: 'documents/x.pdf', file_name: '여비 규정.pdf', file_type: 'pdf', noda_status: 'ready', ...over,
});
const agent = (over: Partial<AgentAccessInfo> = {}): AgentAccessInfo => ({
  id: 'ag', tier: 'official', department_id: 'dept', organization_id: 'org', visibility: 'organization', owner_id: null, created_by: 'x', is_active: true, is_published: true, deleted_at: null, approval_status: 'approved', version: 1, approval_version: null, ...over,
} as AgentAccessInfo);
const common = (over: Partial<CommonOriginalDoc> = {}): CommonOriginalDoc => ({ id: ID, org_type: '공공기관', storage_path: 'common/public/a.pdf', file_name: '예산편성기준.pdf', file_type: 'pdf', noda_status: 'ready', ...over });

beforeEach(() => {
  state.session = { user: { id: 'me', role: 'USER', departmentId: 'dept' } };
  state.results = {}; state.calls = []; state.agent = agent(); state.signed = 'https://store.example/sign/p?token=t';
});

describe('열 주소', () => {
  it('쪽 번호는 1~100,000 정수 글만', () => {
    expect(parsePage('12')).toBe(12);
    for (const bad of [null, '', '0', '-1', '1.5', '12a', '0012', '100001', '9999999']) expect(parsePage(bad)).toBeNull();
  });

  it('PDF는 그 쪽으로(쪽 없으면 그대로), 그 밖은 원래 이름으로 한 번만 인코딩해 내려받기', () => {
    expect(originalUrl('https://s/x?token=t', 'a.pdf', 'pdf', 12)).toBe('https://s/x?token=t#page=12');
    expect(originalUrl('https://s/x?token=t', '규정', 'application/pdf', null)).toBe('https://s/x?token=t');
    expect(originalUrl('https://s/x?token=t', '여비 규정.hwpx', 'hwpx', 3)).toBe(`https://s/x?token=t&download=${encodeURIComponent('여비 규정.hwpx')}`);
    expect(originalUrl('https://s/x', '표.xlsx', null, null)).toBe(`https://s/x?download=${encodeURIComponent('표.xlsx')}`);
  });

  it('근거 창 주소 — 비서 문서·공통 자료실, 쪽이 있으면 붙이고 uuid가 아니면 단추 없음', () => {
    expect(sourceOriginalHref({ documentId: ID.toUpperCase(), page: 7 })).toBe(`/api/documents/${ID}/original?page=7`);
    expect(sourceOriginalHref({ documentId: ID, scope: 'common', page: null })).toBe(`/api/common-documents/${ID}/original`);
    expect(sourceOriginalHref({ documentId: ID, page: 0 })).toBe(`/api/documents/${ID}/original`);
    expect(sourceOriginalHref({ documentId: '../x' })).toBeNull();
  });
});

describe('비서 문서 원본을 열 수 있는가', () => {
  it('볼 수 있는 문서 + 쓸 수 있는 비서면 연다 — 지난 판도', () => {
    expect(canOpenAgentOriginal(doc(), agent(), actor)).toBe(true);
    expect(canOpenAgentOriginal(doc({ noda_status: 'retired' }), agent(), actor)).toBe(true);
    expect(canOpenAgentOriginal(doc({ visibility: 'department', department_id: 'parent' }), agent(), actor)).toBe(true);
  });

  it('닫는다: 다른 기관·안 보이는 부서 문서·지우는 중·원본 없음·비서 없음·비서가 다름·숨긴 비서·남의 나만의 비서', () => {
    expect(canOpenAgentOriginal(doc({ organization_id: 'other' }), agent(), actor)).toBe(false);
    expect(canOpenAgentOriginal(doc({ visibility: 'department', department_id: 'secret' }), agent(), actor)).toBe(false);
    expect(canOpenAgentOriginal(doc({ visibility: null }), agent(), actor)).toBe(false);
    expect(canOpenAgentOriginal(doc({ noda_status: 'deleting' }), agent(), actor)).toBe(false);
    expect(canOpenAgentOriginal(doc({ storage_path: null }), agent(), actor)).toBe(false);
    expect(canOpenAgentOriginal(doc({ agent_id: null }), agent(), actor)).toBe(false);
    expect(canOpenAgentOriginal(doc(), null, actor)).toBe(false);
    expect(canOpenAgentOriginal(doc(), agent({ id: 'other' }), actor)).toBe(false);
    expect(canOpenAgentOriginal(doc(), agent({ deleted_at: '2026-11-01' }), actor)).toBe(false);
    expect(canOpenAgentOriginal(doc(), agent({ is_active: false }), actor)).toBe(false);
    expect(canOpenAgentOriginal(doc(), agent({ tier: 'personal', owner_id: 'someone' }), actor)).toBe(false);
    expect(canOpenAgentOriginal(doc(), agent({ tier: 'personal', owner_id: 'me' }), actor)).toBe(true);
  });

  it('공통 자료실은 같은 기관 유형만, 지우는 중·원본 없음·유형 모름은 닫음', () => {
    expect(canOpenCommonOriginal(common(), '공공기관')).toBe(true);
    expect(canOpenCommonOriginal(common({ noda_status: 'retired' }), '공공기관')).toBe(true);
    expect(canOpenCommonOriginal(common(), '지방자치단체')).toBe(false);
    expect(canOpenCommonOriginal(common(), null)).toBe(false);
    expect(canOpenCommonOriginal(common({ org_type: '없는유형' }), '없는유형')).toBe(false);
    expect(canOpenCommonOriginal(common({ noda_status: 'deleting' }), '공공기관')).toBe(false);
    expect(canOpenCommonOriginal(common({ storage_path: null }), '공공기관')).toBe(false);
    expect(canOpenCommonOriginal(null, '공공기관')).toBe(false);
  });
});

describe('라우트', () => {
  const open = (path: string, handler: typeof getAgentOriginal, id = ID) => handler(new NextRequest(`http://localhost${path}`), { params: { id } });

  it('비서 문서 — 로그인 없음 401, 이상한 id 404, 없는·못 여는 문서 404, 열면 307 + 쪽·캐시 금지', async () => {
    state.session = null;
    expect((await open(`/api/documents/${ID}/original`, getAgentOriginal)).status).toBe(401);
    state.session = { user: { id: 'me' } };
    expect((await open('/api/documents/x/original', getAgentOriginal, 'x')).status).toBe(404);
    expect((await open(`/api/documents/${ID}/original`, getAgentOriginal)).status).toBe(404);
    state.results.documents = [{ data: doc() }];
    state.agent = agent({ tier: 'personal', owner_id: 'someone' });
    expect((await open(`/api/documents/${ID}/original`, getAgentOriginal)).status).toBe(404);
    state.results.documents = [{ data: doc() }];
    state.agent = agent();
    const res = await open(`/api/documents/${ID}/original?page=12`, getAgentOriginal);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://store.example/sign/p?token=t#page=12');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(state.calls).toContainEqual(['documents', 'eq', 'organization_id', 'org']);
  });

  it('비서 문서 — 행을 못 읽거나 서명을 못 만들면 503', async () => {
    state.results.documents = [{ error: { message: 'down' } }];
    expect((await open(`/api/documents/${ID}/original`, getAgentOriginal)).status).toBe(503);
    state.results.documents = [{ data: doc() }];
    state.signed = null;
    expect((await open(`/api/documents/${ID}/original`, getAgentOriginal)).status).toBe(503);
  });

  it('공통 자료실 — 같은 유형이면 307, 다른 유형은 404, 조회 실패 503', async () => {
    state.results.organizations = [{ data: { type: '공공기관' } }];
    state.results.common_documents = [{ data: common({ file_name: '기준.hwpx', file_type: 'hwpx' }) }];
    const res = await open(`/api/common-documents/${ID}/original?page=3`, getCommonOriginal);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`https://store.example/sign/p?token=t&download=${encodeURIComponent('기준.hwpx')}`);
    state.results.organizations = [{ data: { type: '교육기관' } }];
    state.results.common_documents = [{ data: common() }];
    expect((await open(`/api/common-documents/${ID}/original`, getCommonOriginal)).status).toBe(404);
    state.results.organizations = [{ error: { message: 'down' } }];
    expect((await open(`/api/common-documents/${ID}/original`, getCommonOriginal)).status).toBe(503);
  });
});

describe('화면 연결 (원본)', () => {
  it('근거 창에 새 탭으로 여는 원본 단추(noopener)', () => {
    const ui = readFileSync('src/components/chat/SourcePanel.tsx', 'utf8');
    expect(ui).toContain('sourceOriginalHref(source)');
    expect(ui).toContain('rel="noopener noreferrer"');
    expect(ui).toContain('원본에서 p.${source.page} 열기');
  });
});
