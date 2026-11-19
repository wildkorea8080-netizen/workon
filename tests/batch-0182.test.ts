import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 슈퍼관리자 공지 만들기·고치기·지우기.
 * 예전: 만료일을 그날 UTC 0시(한국 오전 9시)로 넣어 그날 아침에 공지가 내려감, 중요도·대상·기관 id·길이를 보지 않음
 * ('특정 기관'인데 기관이 없으면 아무에게도 안 보이고, 표 밖 중요도는 직원 띠에 영영 안 나옴), 발행된 공지를 고칠 때마다
 * 발행 시각을 다시 찍어 맨 위로 올림, 없는 공지는 500(고치기)·'삭제됨'(지우기), 화면은 실패를 알리지 않음.
 */

type Chain = { table: string; ops: Array<[string, unknown[]]> };
const ORG = '22222222-2222-2222-2222-222222222222';
const state = {
  chains: [] as Chain[],
  before: { title: '옛 제목', is_published: true, target_type: 'all', target_org_ids: [] } as Record<string, unknown> | null,
  beforeError: null as unknown,
};
const has = (c: Chain, op: string) => c.ops.some(([k]) => k === op);
const arg = (c: Chain, op: string) => c.ops.find(([k]) => k === op)?.[1];

vi.mock('@/lib/super-auth', () => ({ getSuperAdminFromRequest: () => ({ sub: 'sa' }) }));
vi.mock('@/lib/audit-write', () => ({ writeAuditRow: vi.fn(async () => true) }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Chain = { table, ops: [] };
      state.chains.push(chain);
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'update', 'insert', 'delete', 'order']) b[n] = (...a: unknown[]) => { chain.ops.push([n, a]); return b; };
      const respond = () => {
        if (has(chain, 'insert')) return { data: { id: 'n1', ...(arg(chain, 'insert')![0] as object) }, error: null };
        if (has(chain, 'update')) return { data: state.before ? { ...state.before, ...(arg(chain, 'update')![0] as object) } : null, error: null };
        if (has(chain, 'delete')) return { data: null, error: null };
        return { data: state.before, error: state.beforeError };
      };
      b.maybeSingle = async () => respond();
      b.single = async () => respond();
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(respond()).then(res);
      return b;
    },
  },
}));

import { noticeExpiryFromDay, parseNoticeInput } from '@/lib/notice-input';
import { POST } from '@/app/api/super/notices/route';
import { PATCH, DELETE } from '@/app/api/super/notices/[id]/route';

const req = (method: string, body?: unknown) => new Request('http://x/', {
  method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
}) as never;
const ctx = { params: { id: 'n1' } };
const written = (op: 'insert' | 'update') => state.chains.filter((c) => has(c, op)).map((c) => arg(c, op)![0] as Record<string, unknown>);

beforeEach(() => {
  state.chains = [];
  state.before = { title: '옛 제목', is_published: true, target_type: 'all', target_org_ids: [] };
  state.beforeError = null;
});

describe('만료일', () => {
  it('그날 한국 23:59:59.999까지', () => {
    expect(noticeExpiryFromDay('2026-12-31')).toBe('2026-12-31T14:59:59.999Z');
    expect(noticeExpiryFromDay('2026-02-30')).toBeNull();
    expect(noticeExpiryFromDay('내일')).toBeNull();
  });
});

describe('parseNoticeInput', () => {
  it('틀린 값은 거절', () => {
    const ok = { title: '제목', content: '내용' };
    for (const b of [
      null, {}, { title: ' ', content: '내용' }, { ...ok, title: 'x'.repeat(201) }, { ...ok, importance: 'high' },
      { ...ok, targetType: 'some' }, { ...ok, targetType: 'specific' }, { ...ok, targetType: 'specific', targetOrgIds: [] },
      { ...ok, targetType: 'specific', targetOrgIds: ['abc'] }, { ...ok, isPublished: 'yes' }, { ...ok, expiresAt: '2026-13-01' },
    ]) expect(parseNoticeInput(b, false).ok).toBe(false);
  });
  it('다듬고, 전체 대상이면 기관 목록을 비움', () => {
    expect(parseNoticeInput({ title: ' 제목 ', content: '내용', targetType: 'all', targetOrgIds: [ORG], expiresAt: '' }, false))
      .toEqual({ ok: true, value: { title: '제목', content: '내용', targetType: 'all', targetOrgIds: [], expiresAt: null } });
  });
  it('고치기는 온 칸만', () => {
    expect(parseNoticeInput({ isPublished: false }, true)).toEqual({ ok: true, value: { isPublished: false } });
  });
});

describe('POST /api/super/notices', () => {
  it('틀린 입력은 400 — DB를 부르지 않음', async () => {
    for (const b of ['{깨짐', { title: '제목', content: '내용', importance: 'x' }]) {
      state.chains = [];
      expect((await POST(req('POST', b))).status).toBe(400);
      expect(state.chains).toHaveLength(0);
    }
  });
  it('만료일은 그날 한국 하루 끝으로 저장', async () => {
    expect((await POST(req('POST', { title: '제목', content: '내용', expiresAt: '2026-12-31' }))).status).toBe(200);
    expect(written('insert')[0]).toMatchObject({ expires_at: '2026-12-31T14:59:59.999Z', target_type: 'all', target_org_ids: [], importance: 'normal' });
  });
});

describe('PATCH /api/super/notices/[id]', () => {
  it('공지를 못 읽으면 503, 없으면 404 — 바꾸지 않음', async () => {
    state.beforeError = { code: 'XX000' };
    expect((await PATCH(req('PATCH', { title: '새' }), ctx)).status).toBe(503);
    state.beforeError = null; state.before = null;
    expect((await PATCH(req('PATCH', { title: '새' }), ctx)).status).toBe(404);
    expect(written('update')).toHaveLength(0);
  });
  it('발행된 공지를 고쳐도 발행 시각을 다시 찍지 않음', async () => {
    expect((await PATCH(req('PATCH', { title: '새 제목', isPublished: true }), ctx)).status).toBe(200);
    expect(written('update')[0]).not.toHaveProperty('published_at');
  });
  it('새로 발행할 때만 발행 시각, 취소하면 비움', async () => {
    state.before = { ...state.before!, is_published: false };
    await PATCH(req('PATCH', { isPublished: true }), ctx);
    expect(written('update')[0].published_at).toEqual(expect.any(String));
    state.chains = []; state.before = { ...state.before!, is_published: true };
    await PATCH(req('PATCH', { isPublished: false }), ctx);
    expect(written('update')[0].published_at).toBeNull();
  });
  it('지금 특정 기관 공지에서 기관을 모두 빼면 400', async () => {
    state.before = { ...state.before!, target_type: 'specific', target_org_ids: [ORG] };
    expect((await PATCH(req('PATCH', { targetOrgIds: [] }), ctx)).status).toBe(400);
    expect(written('update')).toHaveLength(0);
  });
});

describe('DELETE /api/super/notices/[id]', () => {
  it('없으면 404, 못 읽으면 503 — 지우지 않음', async () => {
    state.before = null;
    expect((await DELETE(req('DELETE'), ctx)).status).toBe(404);
    state.beforeError = { code: 'XX000' };
    expect((await DELETE(req('DELETE'), ctx)).status).toBe(503);
    expect(state.chains.some((c) => has(c, 'delete'))).toBe(false);
  });
});

describe('원본 확인 — 공지 화면', () => {
  const src = readFileSync('src/app/super/notices/page.tsx', 'utf8');
  it('만료일은 한국 날짜로 읽고, 발행·삭제·저장 실패를 알린다', () => {
    expect(src).toContain('kstDay(notice.expires_at)');
    expect(src).toContain("'바꾸지 못했습니다.'");
    expect(src).toContain("'삭제하지 못했습니다.'");
    expect(src).toContain("'저장하지 못했습니다.'");
  });
});
