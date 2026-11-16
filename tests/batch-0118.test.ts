import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ insertError: null as null | { code?: string; message?: string }, logs: [] as Record<string, unknown>[], rows: [] as Record<string, unknown>[] }));

vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        if (table === 'usage_logs') state.rows.push(row);
        return { error: state.insertError };
      },
    }),
  },
}));
vi.mock('@/lib/logger', () => ({ logSystem: async (p: Record<string, unknown>) => { state.logs.push(p); } }));

import { writeUsageLog } from '@/lib/assistant/persist';
import { reportUsageLogFailure, usageFailureDetails } from '@/lib/usage-log-failure';
import { sourceFiles } from './helpers/code-schema-refs';

/**
 * 2026-11-17 — 사용 기록 쓰기 실패를 운영 기록에. 사용 기록은 청구·예산 판정의 근거인데 실패가 console 한 줄뿐이라
 * 쓴 토큰이 청구·한도에서 조용히 빠질 수 있었다(보안 로그가 표 없이 조용히 사라졌던 0097과 같은 꼴).
 */

beforeEach(() => { state.insertError = null; state.logs = []; state.rows = []; });

const ROW = {
  departmentId: 'D', userId: 'U', action: 'chat_message', resourceType: 'conversation', resourceId: 'C',
  details: { model: 'claude-sonnet-4-6', input_tokens: 1200, output_tokens: 300, cost_krw: 12.5, query: '질문 원문', file_name: '예산.xlsx' },
};

describe('writeUsageLog', () => {
  it('성공이면 운영 기록 없음', async () => {
    await writeUsageLog(ROW);
    expect(state.rows).toHaveLength(1);
    expect(state.logs).toEqual([]);
  });
  it('실패하면 critical·payment로 부서·활동·코드·모델·토큰·원가만(질문·파일 이름·사람 없음)', async () => {
    state.insertError = { code: '23502', message: 'null value' };
    await writeUsageLog(ROW);
    expect(state.logs).toEqual([{
      level: 'critical', category: 'payment', message: '사용 기록을 남기지 못했습니다(청구·한도에서 빠짐)',
      details: { department_id: 'D', action: 'chat_message', code: '23502', model: 'claude-sonnet-4-6', input_tokens: 1200, output_tokens: 300, cost_krw: 12.5 },
    }]);
    const text = JSON.stringify(state.logs);
    for (const secret of ['질문 원문', '예산.xlsx', '"U"']) expect(text).not.toContain(secret);
  });
});

describe('reportUsageLogFailure', () => {
  it('토큰 없는 기록은 빈 칸, 운영 기록마저 실패해도 던지지 않음', async () => {
    expect(usageFailureDetails({ departmentId: null, action: 'file_attached', details: { status: 'ready' } }, 'x')).toEqual({
      department_id: null, action: 'file_attached', code: 'x', model: null, input_tokens: null, output_tokens: null, cost_krw: null,
    });
    await expect(reportUsageLogFailure({ departmentId: 'D', action: 'a', details: {} }, 'x', async () => { throw new Error('down'); })).resolves.toBeUndefined();
  });
});

describe('사용 기록은 두 곳에서만 쓴다', () => {
  it('직접 insert는 assistant/persist.ts(writeUsageLog)·업무 store(writeUsage)뿐', () => {
    const offenders = sourceFiles(['src'])
      .map((f) => f.replace(/\\/g, '/'))
      .filter((f) => !f.endsWith('src/lib/assistant/persist.ts') && !f.endsWith('src/lib/work/store/supabase.ts'))
      .filter((f) => /from\(\s*'usage_logs'\s*\)\s*\.insert/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
  it('업무 store도 실패를 운영 기록에', () => {
    expect(readFileSync('src/lib/work/store/supabase.ts', 'utf8')).toContain("if (error) await reportUsageLogFailure({ departmentId: u.departmentId, action: u.action");
  });
});
