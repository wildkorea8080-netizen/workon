import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { emptyListText, fetchOkJson } from '@/lib/ok-json';

/**
 * 2026-11-20 — 화면이 못 읽은 목록을 '없습니다'로 보이지 않는다.
 * 서버는 읽기 실패를 503으로 답하게 고쳐 왔는데, 관리자 비서 화면(공식·승인 대기·반려)과 대화 목록(사이드바)은
 * 응답이 `{ ok: false }`면 아무것도 하지 않아 '등록된 공식 비서가 없습니다'·'승인 대기 중인 비서가 없습니다'·'대화가 없습니다'로 보였다
 * (승인 대기 목록을 못 읽으면 관리자는 기다리는 신청이 없는 줄 안다).
 * 이제 `fetchOkJson`이 null이면 '지금 불러오지 못했습니다'로 보인다. 앞서 읽은 목록은 그대로 둔다.
 */

const res = (ok: boolean, body: unknown) => ({ ok, json: async () => body });

describe('fetchOkJson', () => {
  it('2xx이고 몸이 ok: true면 그 몸', async () => {
    expect(await fetchOkJson('/x', async () => res(true, { ok: true, data: [1] }))).toEqual({ ok: true, data: [1] });
  });
  it('503·몸이 ok: false·몸이 객체가 아님·몸을 못 읽음은 null', async () => {
    expect(await fetchOkJson('/x', async () => res(false, { ok: false, error: { message: 'x' } }))).toBeNull();
    expect(await fetchOkJson('/x', async () => res(true, { ok: false }))).toBeNull();
    expect(await fetchOkJson('/x', async () => res(true, null))).toBeNull();
    expect(await fetchOkJson('/x', async () => res(true, []))).toBeNull();
    expect(await fetchOkJson('/x', async () => ({ ok: true, json: async () => { throw new SyntaxError('html'); } }))).toBeNull();
  });
  it('연결이 끊겨도 던지지 않고 null', async () => {
    expect(await fetchOkJson('/x', vi.fn(async () => { throw new TypeError('fetch failed'); }))).toBeNull();
  });
});

describe('emptyListText', () => {
  it('못 읽었으면 없습니다라고 하지 않는다', () => {
    expect(emptyListText(false, '대화가 없습니다.', '대화 목록을')).toBe('대화가 없습니다.');
    expect(emptyListText(true, '대화가 없습니다.', '대화 목록을')).toBe('대화 목록을 지금 불러오지 못했습니다. 화면을 새로 고쳐 주세요.');
    expect(emptyListText(true, '승인 대기 중인 비서가 없습니다.', '승인 대기 목록을')).not.toContain('없습니다');
  });
});

describe('화면 (원본)', () => {
  const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

  it('관리자 비서 화면 — 세 목록 모두 못 읽음을 기억하고 빈 자리에 가른다', () => {
    const src = read('src/components/admin/AgentsManager.tsx');
    expect(src).toContain("fetchOkJson<{ data?: Agent[] }>('/api/agents?manage=true')");
    expect(src).toContain('setUnread((u) => ({ ...u, official: !result }));');
    expect(src).toContain('setUnread((u) => ({ ...u, pending: !result }));');
    expect(src).toContain('setUnread((u) => ({ ...u, rejected: !result }));');
    expect(src).toContain("{emptyListText(unread.official, '등록된 공식 비서가 없습니다.', '공식 비서 목록을')}");
    expect(src).toContain("{emptyListText(unread.pending, '승인 대기 중인 비서가 없습니다.', '승인 대기 목록을')}");
    expect(src).toContain("{emptyListText(unread.rejected, '반려된 비서가 없습니다.', '반려된 비서 목록을')}");
    // 못 읽었을 때 목록을 비우지 않는다(앞서 읽은 것을 그대로)
    expect(src).toContain('if (result) setAgents(result.data ?? []);');
  });

  it('대화 목록 — 못 읽으면 대화가 없습니다 대신 알린다', () => {
    const src = read('src/components/layout/Sidebar.tsx');
    expect(src).toContain("const result = await fetchOkJson<{ data?: Conversation[] }>('/api/conversations?limit=80');");
    expect(src).toContain('setUnread(!result);');
    expect(src).toContain('if (result) setConversations(result.data ?? []);');
    expect(src).toContain("{emptyListText(unread, '대화가 없습니다.', '대화 목록을')}");
  });
});
