import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * 2026-11-18 — 직원 공지(업무 틀·대화 화면 위 띠). 예전 `/api/notices`는 대상 칸(`target_type`·`target_org_ids`)을 고르지 않은 채
 * 그 칸으로 걸러 **모든 공지가 빠졌다** — 운영의 전체 공지 1건이 한 번도 보이지 않았다(읽음 0건).
 */

const ORG = '11111111-1111-1111-1111-111111111111';
const state: { session: unknown; calls: unknown[][]; notices: unknown; error: unknown } = { session: null, calls: [], notices: [], error: null };

function builder(table: string) {
  const b: Record<string, unknown> = {};
  for (const n of ['select', 'eq', 'or', 'order', 'limit', 'in', 'maybeSingle']) {
    b[n] = (...a: unknown[]) => { state.calls.push([`${table}.${n}`, ...a]); return b; };
  }
  b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(
    table === 'departments' ? { data: { organization_id: ORG }, error: null }
      : table === 'notice_reads' ? { data: [{ notice_id: 'n2' }], error: null }
        : { data: state.notices, error: state.error },
  ).then(ok, bad);
  return b;
}

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: { from: (t: string) => builder(t) } }));
vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => state.session }));

import { GET } from '@/app/api/notices/route';
import { noticeVisibleTo } from '@/lib/notice-visibility';

const notice = (id: string, o: Record<string, unknown> = {}) => ({ id, title: `공지 ${id}`, content: '본문', importance: 'normal', published_at: '2026-04-27T08:16:44Z', expires_at: null, target_type: 'all', target_org_ids: [], ...o });

beforeEach(() => { state.session = { user: { id: 'u1', departmentId: 'd1' } }; state.calls = []; state.notices = []; state.error = null; });

describe('대상 규칙', () => {
  it('전체 공지 또는 내 기관이 든 공지', () => {
    expect(noticeVisibleTo({ target_type: 'all', target_org_ids: [] }, null)).toBe(true);
    expect(noticeVisibleTo({ target_type: 'specific', target_org_ids: [ORG] }, ORG)).toBe(true);
    expect(noticeVisibleTo({ target_type: 'specific', target_org_ids: ['other'] }, ORG)).toBe(false);
    expect(noticeVisibleTo({ target_type: 'specific', target_org_ids: [ORG] }, null)).toBe(false);
    expect(noticeVisibleTo({ target_type: null, target_org_ids: null }, ORG)).toBe(false);
  });
});

describe('GET /api/notices', () => {
  it('대상 칸을 고르고 DB에서 거른다 — 전체 공지가 보인다(예전엔 빠졌다)', async () => {
    state.notices = [notice('n1'), notice('n2', { target_type: 'specific', target_org_ids: [ORG] }), notice('n3', { target_type: 'specific', target_org_ids: ['x'] })];
    const body = await (await GET(new Request('http://x') as never)).json();
    const sel = state.calls.find((c) => c[0] === 'notices.select');
    expect(String(sel?.[1])).toContain('target_type');
    expect(String(sel?.[1])).toContain('target_org_ids');
    expect(state.calls).toContainEqual(['notices.or', `target_type.eq.all,target_org_ids.cs.{${ORG}}`]);
    expect(body.data.map((n: { id: string }) => n.id)).toEqual(['n1', 'n2']); // n3은 다른 기관
    expect(body.data.find((n: { id: string }) => n.id === 'n2').isRead).toBe(true);
    expect(body.data[0]).not.toHaveProperty('target_org_ids'); // 대상 기관 목록은 내보내지 않음
  });
  it('로그인 안 했으면 빈 목록', async () => {
    state.session = null;
    expect((await (await GET(new Request('http://x') as never)).json()).data).toEqual([]);
  });
  it('못 읽으면 503(빈 목록으로 꾸미지 않음)', async () => {
    state.error = { code: 'X' };
    expect((await GET(new Request('http://x') as never)).status).toBe(503);
  });
});
