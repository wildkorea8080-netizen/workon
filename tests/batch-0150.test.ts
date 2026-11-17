import { readFileSync } from 'fs';
import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * 2026-11-18 — 한 턴의 질문·답 두 행은 한 번에 들어가 `created_at`이 같다(운영 10턴 모두). 시각만으로 줄 세우면 같은 시각 안의 순서가
 * 정해지지 않고, 운영은 최신순에서도 '질문, 답'으로 돌려줬다 — 이력을 시간순으로 뒤집으면 [답1, 질문1, 답2, 질문2, 답3, 질문3],
 * 앞 답을 떼면 질문1 → 답2처럼 **한 칸씩 밀린 이력이 모델에 갔다**(첫 답은 빠짐, 오류 없음). 같은 시각이면 역할로 가른다.
 */

const state: { calls: unknown[][]; rows: unknown[] } = { calls: [], rows: [] };
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: () => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'order', 'limit']) b[n] = (...a: unknown[]) => { state.calls.push([n, ...a]); return b; };
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: state.rows, error: null }).then(ok);
      return b;
    },
  },
}));

import { loadHistory, trimHistory } from '@/lib/assistant/history';

beforeEach(() => { state.calls = []; state.rows = []; });

const T3 = '2026-11-18T01:00:03Z', T2 = '2026-11-18T01:00:02Z', T1 = '2026-11-18T01:00:01Z';
const row = (role: string, content: string, at: string) => ({ role, content, at });

describe('이력 순서', () => {
  it('최신순·같은 시각이면 답이 먼저로 받아 시간순으로 뒤집으면 질문 → 그 답', async () => {
    // DB가 (created_at desc, role asc)로 돌려주는 꼴
    state.rows = [row('assistant', 'A3', T3), row('user', 'Q3', T3), row('assistant', 'A2', T2), row('user', 'Q2', T2), row('assistant', 'A1', T1), row('user', 'Q1', T1)];
    const h = await loadHistory('c1');
    expect(h.map((m) => m.content)).toEqual(['Q1', 'A1', 'Q2', 'A2', 'Q3', 'A3']);
    expect(state.calls).toContainEqual(['order', 'created_at', { ascending: false }]);
    expect(state.calls).toContainEqual(['order', 'role', { ascending: true }]);
    const i = state.calls.findIndex((c) => c[0] === 'order' && c[1] === 'created_at');
    const j = state.calls.findIndex((c) => c[0] === 'order' && c[1] === 'role');
    expect(i).toBeLessThan(j); // 시각이 먼저, 역할은 같은 시각 안에서만
  });
  it('예전처럼 같은 시각 안이 질문, 답 순이면 한 칸씩 밀렸다(이 순서를 막으려는 것)', () => {
    const old = trimHistory([row('user', 'Q3', T3), row('assistant', 'A3', T3), row('user', 'Q2', T2), row('assistant', 'A2', T2), row('user', 'Q1', T1), row('assistant', 'A1', T1)]);
    expect(old.map((m) => m.content)).toEqual(['Q1', 'A2', 'Q2', 'A3', 'Q3']);
  });
});

describe('화면·공유', () => {
  it('대화 열기는 시간순·같은 시각이면 질문 먼저', () => {
    const s = readFileSync('src/app/api/conversations/[id]/route.ts', 'utf8');
    const i = s.indexOf(".order('created_at', { referencedTable: 'messages', ascending: true })");
    const j = s.indexOf(".order('role', { referencedTable: 'messages', ascending: false })");
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
  });
  it('공유 화면도 같은 순서(예전엔 순서를 정하지 않았다)', () => {
    const s = readFileSync('src/app/api/shared/[token]/route.ts', 'utf8');
    const i = s.indexOf(".order('created_at', { referencedTable: 'messages', ascending: true })");
    const j = s.indexOf(".order('role', { referencedTable: 'messages', ascending: false })");
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
  });
});
