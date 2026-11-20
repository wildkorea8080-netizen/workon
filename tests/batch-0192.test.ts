import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 비서를 못 읽으면 '없음'이 아니다.
 * 예전 `loadAgentAccess`는 읽기 실패도 null로 돌려, 비서를 쓰는 라우트 스무 곳이 잠깐의 DB 오류를 '비서를 찾을 수 없습니다'(404)·
 * '권한이 없습니다'(403)로 답했다(직원은 비서가 지워진 줄 안다). 문서 찾기 일괄 평가의 기록 읽기 실패도 '평가 기록을 찾을 수 없습니다'(404).
 */

const state = { agent: null as null | Record<string, unknown>, error: null as unknown };

vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: () => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq']) b[n] = () => b;
      b.maybeSingle = async () => ({ data: state.error ? null : state.agent, error: state.error });
      return b;
    },
  },
}));

import { AgentReadError, isAgentReadError, loadAgentAccess } from '@/lib/agent-store';

beforeEach(() => { state.agent = null; state.error = null; });

describe('loadAgentAccess', () => {
  it('있으면 행, 없으면 null, 못 읽으면 던짐', async () => {
    state.agent = { id: 'a1', tier: 'official' };
    expect(await loadAgentAccess('a1')).toMatchObject({ id: 'a1' });
    state.agent = null;
    expect(await loadAgentAccess('a1')).toBeNull();
    state.error = { code: '57014' };
    const err = await loadAgentAccess('a1').catch((e) => e);
    expect(err).toBeInstanceOf(AgentReadError);
    expect(isAgentReadError(err)).toBe(true);
    expect((err as AgentReadError).code).toBe('57014');
    expect(isAgentReadError(new Error('x'))).toBe(false);
  });
});

describe('원본 확인 — 부르는 곳', () => {
  const callers = [
    'src/app/api/admin/agents/[id]/approve/route.ts', 'src/app/api/admin/agents/[id]/reject/route.ts',
    'src/app/api/admin/rag-eval/route.ts', 'src/app/api/agents/personal/[id]/request-approval/route.ts',
    'src/app/api/agents/personal/[id]/route.ts', 'src/app/api/agents/[id]/app-draft/route.ts',
    'src/app/api/agents/[id]/history/route.ts', 'src/app/api/agents/[id]/promote/route.ts',
    'src/app/api/agents/[id]/revert/route.ts', 'src/app/api/agents/[id]/route.ts',
    'src/app/api/agents/[id]/templates/route.ts', 'src/app/api/agents/[id]/templates/[templateId]/route.ts',
    'src/app/api/documents/assign/route.ts', 'src/app/api/documents/route.ts',
    'src/app/api/documents/[id]/read/route.ts', 'src/app/api/rag-test/route.ts',
  ];
  it('던진 오류를 받는 catch가 있다(처리기 안에서 부름)', () => {
    for (const f of callers) {
      const s = readFileSync(f, 'utf8');
      expect(s, f).toContain('loadAgentAccess(');
      expect(s, f).toMatch(/\} catch/);
    }
  });
  it('try가 없는 두 곳은 따로 받는다', () => {
    expect(readFileSync('src/app/api/documents/[id]/original/route.ts', 'utf8')).toContain("if (isAgentReadError(err)) return jsonError('원본을 지금 불러올 수 없습니다. 잠시 뒤 다시 시도해 주세요.', 503);");
    // 업무 라우트는 handleWork가 WorkError 밖의 오류를 500으로
    expect(readFileSync('src/lib/work/server.ts', 'utf8')).toContain("return fail('INTERNAL', '서버 오류가 발생했습니다. 잠시 뒤 다시 시도해 주세요.', 500);");
  });
  it('일괄 평가 기록 읽기 실패는 404가 아니라 503(세 곳)', () => {
    const s = readFileSync('src/app/api/admin/rag-eval/route.ts', 'utf8');
    expect(s.match(/'평가 기록을 불러오지 못했습니다\. 잠시 뒤 다시 시도해 주세요\.', 503\)/g)).toHaveLength(3);
  });
});
