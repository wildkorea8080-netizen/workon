import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-18 — 이어지는 대화의 이력·대화 준비·일괄 실행의 읽기 실패.
 * - 앞 턴(이력)을 못 읽으면 빈 이력으로 보아 **이어지는 질문이 앞 대화 없이 모델에 갔다** — 엉뚱한 답이 오류 없이 나갔다
 *   (대화 화면에는 앞 턴이 그대로 보여 직원은 알 수 없다)
 * - 비서·대화를 못 읽으면 '없음'(404)으로 답했다
 * - 일괄 실행의 줄을 못 읽으면 '0줄'로 보이고 결과 엑셀이 빈 표로 내려갔다
 */

const state: { messages: { data: unknown; error: unknown } } = { messages: { data: [], error: null } };

vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'limit']) q[m] = () => q;
      q.then = (res: (v: unknown) => unknown) => Promise.resolve(state.messages).then(res);
      return q;
    },
  },
}));

import { HistoryReadError, loadHistory } from '@/lib/assistant/history';

beforeEach(() => {
  state.messages = { data: [], error: null };
});

describe('loadHistory', () => {
  it('못 읽으면 빈 이력이 아니라 던진다', async () => {
    state.messages = { data: null, error: { code: 'XX000', message: 'boom' } };
    await expect(loadHistory('c1')).rejects.toBeInstanceOf(HistoryReadError);
    await expect(loadHistory('c1')).rejects.toMatchObject({ code: 'XX000' });
  });

  it('읽으면 시간순으로 다듬어 돌려준다(최신순으로 받은 것을 뒤집음)', async () => {
    state.messages = {
      data: [
        { role: 'assistant', content: '답 2', revised: null },
        { role: 'user', content: '질문 2', revised: null },
        { role: 'assistant', content: '답 1', revised: null },
        { role: 'user', content: '질문 1', revised: null },
      ],
      error: null,
    };
    expect(await loadHistory('c1')).toEqual([
      { role: 'user', content: '질문 1' },
      { role: 'assistant', content: '답 1' },
      { role: 'user', content: '질문 2' },
      { role: 'assistant', content: '답 2' },
    ]);
  });

  it('대화가 비어 있으면(오류 없이 0행) 빈 이력', async () => {
    expect(await loadHistory('c1')).toEqual([]);
  });
});

describe('대화 준비 — 원본 확인', () => {
  const src = readFileSync('src/lib/assistant/prepare.ts', 'utf8');

  it('이력을 못 읽으면 답하지 않는다(503)', () => {
    expect(src).toContain("import { HistoryReadError, loadHistory } from './history';");
    expect(src).toMatch(/try \{\s*history = await loadHistory\(conversationId\);\s*\} catch \(err\) \{\s*if \(err instanceof HistoryReadError\) return reject\([^)]*, 503\);/);
  });

  it('비서·대화를 못 읽은 것을 404로 보지 않는다', () => {
    const agentRead = src.indexOf('agentReadError');
    expect(agentRead).toBeGreaterThan(-1);
    expect(src).toContain('if (agentReadError) return reject(READ_FAILED_MESSAGE, 503);');
    expect(src).toContain('if (conversationReadError) return reject(READ_FAILED_MESSAGE, 503);');
    // 못 읽은 것을 먼저 보고 나서 '없음'을 본다
    expect(src.indexOf('if (conversationReadError)')).toBeLessThan(src.indexOf("if (!existing) return reject('대화를 찾을 수 없습니다.', 404);"));
  });
});

describe('일괄 실행 — 원본 확인', () => {
  const lib = readFileSync('src/lib/apps/batches.ts', 'utf8');

  it('묶음·줄을 못 읽으면 던지고(BatchReadError), 그만두기·다시 실행은 503으로 돌려준다', () => {
    const own = lib.slice(lib.indexOf('async function ownBatch'), lib.indexOf('export async function getBatch'));
    expect(own).toContain('if (error) throw new BatchReadError();');
    const get = lib.slice(lib.indexOf('export async function getBatch'), lib.indexOf('export async function cancelBatch'));
    expect(get).toContain('if (itemsError) throw new BatchReadError();');
    expect(get.indexOf('if (itemsError)')).toBeLessThan(get.indexOf('const items ='));
    expect(lib.match(/if \(batch === 'failed'\) return \{ ok: false, status: 503/g)).toHaveLength(3); // 그만두기·다시 실행·사람 판정(0126)
  });

  for (const route of ['src/app/api/apps/batches/[id]/route.ts', 'src/app/api/apps/batches/[id]/export/route.ts']) {
    it(`${route} — 못 읽으면 404·빈 표가 아니라 503`, () => {
      const src = readFileSync(route, 'utf8');
      expect(src).toContain('if (err instanceof BatchReadError) return fail(');
      expect(src).toMatch(/BatchReadError\) return fail\('[^']+', 503\)/);
    });
  }
});
