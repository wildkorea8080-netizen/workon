import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-18 — 대화 입력 필터와 금지어 저장.
 * - 금지어를 읽지 못하면 바로 돌아가 **개인정보 패턴 검사까지 꺼졌다**(그 검사는 DB가 필요 없다) — 기록은 console.warn 한 줄뿐
 * - 금지어·주민등록번호 사이에 보이지 않는 글자(U+200B 등)를 끼우면 검사에 걸리지 않았고,
 *   붙여 넣은 금지어에 딸려 온 글자 때문에 그 금지어가 영영 걸리지 않았다
 * - 한 글자 금지어('개')가 저장돼 그 글자가 든 질문을 모두 막을 수 있었다(길이·개수 상한 없음)
 */

type Call = { table: string; ops: Array<[string, unknown[]]> };
type Result = { data?: unknown; error: unknown; count?: number | null };

const state: {
  session: unknown;
  calls: Call[];
  /** 대화 필터가 읽는 금지어 */
  words: Result;
  existing: Result;
  count: Result;
  inserted: Result;
  systemLogs: Array<Record<string, unknown>>;
  usage: Array<Record<string, unknown>>;
} = {
  session: null, calls: [], words: { data: [], error: null }, existing: { data: null, error: { code: 'PGRST116' } },
  count: { error: null, count: 0 }, inserted: { data: null, error: null }, systemLogs: [], usage: [],
};

const did = (c: Call, name: string) => c.ops.some(([n]) => n === name);

function resolve(c: Call): Result {
  if (c.table === 'users') return { data: { department_id: 'd1' }, error: null };
  if (c.table === 'forbidden_words') {
    if (did(c, 'insert')) {
      const row = (c.ops.find(([n]) => n === 'insert')?.[1] as [Record<string, unknown>])[0];
      return state.inserted.error ? state.inserted : { data: { id: 'w1', is_active: true, created_at: '2026-11-18T00:00:00Z', ...row }, error: null };
    }
    if (c.ops.some(([n, a]) => n === 'select' && ((a as unknown[])[1] as { head?: boolean } | undefined)?.head)) return state.count;
    if (did(c, 'single')) return state.existing;
    return state.words; // 대화 필터
  }
  throw new Error(`unexpected table ${c.table}`);
}

vi.mock('@/lib/auth', () => ({
  getServerAuthSession: async () => state.session,
  isAdminSession: (s: { user?: { role?: string } } | null) => s?.user?.role === 'ADMIN',
}));
vi.mock('@/lib/actor-scope', () => ({ getActorScope: async () => ({ organizationId: 'org1', managedDepartmentIds: ['d1'] }) }));
vi.mock('@/lib/forbidden-words-scope', () => ({ listManagedForbiddenWords: async () => ({ rows: [] }) }));
vi.mock('@/lib/assistant/persist', () => ({ writeUsageLog: async (row: Record<string, unknown>) => { state.usage.push(row); } }));
vi.mock('@/lib/logger', () => ({ logSystem: async (p: Record<string, unknown>) => { state.systemLogs.push(p); } }));
vi.mock('@/lib/security-log', () => ({ logSecurityEvent: async () => true }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const call: Call = { table, ops: [] };
      state.calls.push(call);
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'in', 'insert']) b[n] = (...args: unknown[]) => { call.ops.push([n, args]); return b; };
      b.single = async () => { call.ops.push(['single', []]); return resolve(call); };
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(resolve(call)).then(res, rej);
      return b;
    },
  },
}));

import { filterUserInput, resetFilterGapReports } from '@/lib/filter';
import {
  cleanForbiddenContext, cleanForbiddenWord, containsForbiddenWord, stripInvisible,
  FORBIDDEN_WORD_MAX, FORBIDDEN_WORDS_PER_DEPARTMENT,
} from '@/lib/forbidden-match';
import { POST } from '@/app/api/forbidden-words/route';

const ERR = { code: 'XX000', message: 'boom' };
const ZW = '​';
const post = async (body: unknown) => {
  const res = await POST({ json: async () => body } as never);
  return { status: res.status, body: await res.json() };
};
const inserts = () => state.calls.filter((c) => did(c, 'insert')).map((c) => (c.ops.find(([n]) => n === 'insert')?.[1] as [Record<string, unknown>])[0]);

beforeEach(() => {
  state.session = { user: { id: 'admin1', role: 'ADMIN', departmentId: 'd1' } };
  state.calls = [];
  state.systemLogs = [];
  state.usage = [];
  state.words = { data: [{ word: '대외비' }], error: null };
  state.existing = { data: null, error: { code: 'PGRST116' } };
  state.count = { error: null, count: 0 };
  state.inserted = { data: null, error: null };
  resetFilterGapReports();
});

describe('금지어를 읽지 못했을 때', () => {
  it('개인정보 패턴 검사는 그대로 한다 — 예전에는 함께 꺼졌다', async () => {
    state.words = { data: null, error: ERR };
    const blocked = await filterUserInput('d1', '주민번호 900101-1234567 확인해 줘');
    expect(blocked.isValid).toBe(false);
    expect(blocked.blockedPatterns).toContain('900101-1234567');
  });

  it('금지어 검사만 건너뛰고(대화는 막지 않음) 운영 기록에 남긴다 — 질문 글 없이, 부서마다 10분에 한 번', async () => {
    state.words = { data: null, error: ERR };
    const passed = await filterUserInput('d1', '대외비 자료 정리해 줘');
    expect(passed.isValid).toBe(true);
    expect(state.systemLogs).toEqual([{
      level: 'error', category: 'security', message: '금지어를 읽지 못해 금지어 검사 없이 대화를 통과시켰습니다',
      details: { department_id: 'd1', code: 'XX000' },
    }]);
    expect(JSON.stringify(state.systemLogs)).not.toContain('대외비');

    await filterUserInput('d1', '다시 질문');
    expect(state.systemLogs).toHaveLength(1);
    await filterUserInput('d2', '다른 부서 질문');
    expect(state.systemLogs).toHaveLength(2);
  });

  it('읽었으면 기록이 없고 금지어가 걸린다', async () => {
    const blocked = await filterUserInput('d1', '대외비 자료 정리해 줘');
    expect(blocked.blockedWords).toEqual(['대외비']);
    expect(state.systemLogs).toHaveLength(0);
  });
});

describe('보이지 않는 글자', () => {
  it('금지어 사이에 끼워도 걸린다', async () => {
    expect(containsForbiddenWord(`대${ZW}외⁠비 자료`, '대외비')).toBe(true);
    expect(containsForbiddenWord(`se${ZW}cret plan`, 'secret')).toBe(true);
    const blocked = await filterUserInput('d1', `대${ZW}외비 자료 정리해 줘`);
    expect(blocked.blockedWords).toEqual(['대외비']);
  });

  it('금지어에 딸려 온 보이지 않는 글자 때문에 안 걸리지 않는다', () => {
    expect(containsForbiddenWord('대외비 자료', `대외비${ZW}`)).toBe(true);
    expect(containsForbiddenWord('대외비 자료', `﻿대외비`)).toBe(true);
  });

  it('주민등록번호 사이에 끼워도 걸리고, 돌려주는 글은 원래 글 그대로', async () => {
    const text = `900101${ZW}-1234567 조회`;
    const blocked = await filterUserInput('d1', text);
    expect(blocked.isValid).toBe(false);
    expect(blocked.filteredText).toBe(text);
  });

  it('보이는 글은 건드리지 않는다', () => {
    expect(stripInvisible('가 나\t다\n라')).toBe('가 나\t다\n라');
    expect(containsForbiddenWord('공개 문서입니다', '대외비')).toBe(false);
    expect(containsForbiddenWord('class 설명', 'ass')).toBe(false);
  });
});

describe('cleanForbiddenWord — 저장할 금지어', () => {
  it('보이지 않는 글자·제어 글자를 빼고 공백을 하나로', () => {
    expect(cleanForbiddenWord(`  대외비${ZW} `)).toEqual({ ok: true, word: '대외비' });
    expect(cleanForbiddenWord('내부\t\n 자료')).toEqual({ ok: true, word: '내부 자료' });
  });

  it('한 글자는 받지 않는다(그 글자가 든 질문을 모두 막는다), 두 글자부터', () => {
    expect(cleanForbiddenWord('개')).toMatchObject({ ok: false });
    expect(cleanForbiddenWord(`개${ZW}`)).toMatchObject({ ok: false });
    expect(cleanForbiddenWord('AI')).toEqual({ ok: true, word: 'AI' });
    expect(cleanForbiddenWord('비밀')).toEqual({ ok: true, word: '비밀' });
  });

  it('50자까지, 글이 아니거나 비면 거절', () => {
    expect(cleanForbiddenWord('가'.repeat(FORBIDDEN_WORD_MAX)).ok).toBe(true);
    expect(cleanForbiddenWord('가'.repeat(FORBIDDEN_WORD_MAX + 1)).ok).toBe(false);
    expect(cleanForbiddenWord(` ${ZW} `).ok).toBe(false);
    expect(cleanForbiddenWord(12).ok).toBe(false);
  });

  it('설명은 200자까지, 비면 null', () => {
    expect(cleanForbiddenContext('  외부 반출 금지 자료  ')).toBe('외부 반출 금지 자료');
    expect(cleanForbiddenContext('가'.repeat(300))).toHaveLength(200);
    expect(cleanForbiddenContext('   ')).toBeNull();
    expect(cleanForbiddenContext(undefined)).toBeNull();
  });
});

describe('POST /api/forbidden-words', () => {
  it('다듬은 금지어를 저장한다', async () => {
    const out = await post({ word: ` 대외비${ZW} `, context: ' 외부 반출 금지 ' });
    expect(out.status).toBe(200);
    expect(inserts()).toEqual([{ department_id: 'd1', word: '대외비', context: '외부 반출 금지' }]);
    expect(state.usage[0]).toMatchObject({ action: 'add_forbidden_word', details: { word: '대외비' } });
    // 겹침 확인도 다듬은 글로
    const dup = state.calls.find((c) => c.table === 'forbidden_words' && did(c, 'single') && !did(c, 'insert'))!;
    expect(dup.ops.some(([n, a]) => n === 'eq' && JSON.stringify(a) === JSON.stringify(['word', '대외비']))).toBe(true);
  });

  it('한 글자·너무 긴 금지어·깨진 요청은 400 — 쓰지 않는다', async () => {
    expect((await post({ word: '개' })).status).toBe(400);
    expect((await post({ word: '가'.repeat(51) })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    const res = await POST({ json: async () => { throw new Error('bad'); } } as never);
    expect(res.status).toBe(400);
    expect(inserts()).toHaveLength(0);
  });

  it('부서 상한에 닿았으면 400, 수를 못 세면 넣지 않는다(500)', async () => {
    state.count = { error: null, count: FORBIDDEN_WORDS_PER_DEPARTMENT };
    const full = await post({ word: '대외비' });
    expect(full.status).toBe(400);
    expect(full.body.error.message).toContain(`${FORBIDDEN_WORDS_PER_DEPARTMENT}개까지`);

    state.count = { error: ERR, count: null };
    expect((await post({ word: '대외비' })).status).toBe(500);
    state.count = { error: null, count: null };
    expect((await post({ word: '대외비' })).status).toBe(500);
    expect(inserts()).toHaveLength(0);
  });

  it('이미 있으면 409, 관리자가 아니면 403', async () => {
    state.existing = { data: { id: 'w0' }, error: null };
    expect((await post({ word: '대외비' })).status).toBe(409);
    state.session = { user: { id: 'u1', role: 'USER', departmentId: 'd1' } };
    expect((await post({ word: '대외비' })).status).toBe(403);
    expect(inserts()).toHaveLength(0);
  });
});

describe('원본 확인', () => {
  it('금지어를 못 읽어도 개인정보 검사 전에 돌아가지 않는다', () => {
    const src = readFileSync('src/lib/filter.ts', 'utf8');
    const fn = src.slice(src.indexOf('export async function filterUserInput'), src.indexOf('export function sanitizeText'));
    expect(fn).not.toMatch(/if \(error\) \{[^}]*return result;/);
    expect(fn).toContain('await reportFilterGap(departmentId');
    expect(fn).toContain('const visible = stripInvisible(text);');
  });

  it('맞추기 규칙 파일은 여전히 아무것도 가져오지 않는다', () => {
    expect(readFileSync('src/lib/forbidden-match.ts', 'utf8')).not.toMatch(/^import /m);
  });

  it('설정 화면은 켜고 끈 응답을 앞 값에 합친다(부서 이름이 사라지지 않게)', () => {
    expect(readFileSync('src/components/admin/SettingsManager.tsx', 'utf8')).toContain('word.id === wordId ? { ...word, ...result.data } : word');
  });
});
