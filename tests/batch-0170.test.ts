import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-18 — 대화 입력 필터의 개인정보 검사.
 * - 대화 준비가 필터에 **사람 id를 넘기지 않아**, 대화에서 금지어·개인정보가 걸려도 보안 로그에 한 번도 남지 않았다
 *   (감사 화면에 '금지어 감지'·'개인정보 패턴 감지' 이름표는 있는데 기록이 없었다 — 운영 보안 로그 0건)
 * - 하이픈으로 쓴 꼴만 잡아, 붙여 쓰거나 띄어 쓴 카드번호(16자리는 긴 숫자 규칙 9~15자리에도 안 걸림)와 띄어 쓴 주민등록번호가 통과했다
 */

const state: {
  words: { word: string }[];
  logs: Array<{ dept: unknown; user: unknown; type: string; details: Record<string, unknown>; severity: string }>;
} = { words: [], logs: [] };

vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in']) q[m] = () => q;
      q.then = (res: (v: unknown) => unknown) => res({ data: state.words, error: null });
      return q;
    },
  },
}));
vi.mock('@/lib/logger', () => ({ logSystem: async () => {} }));
vi.mock('@/lib/security-log', () => ({
  logSecurityEvent: async (dept: unknown, user: unknown, type: string, details: Record<string, unknown>, severity: string) => {
    state.logs.push({ dept, user, type, details, severity });
    return true;
  },
}));

import { filterUserInput, passesLuhn } from '@/lib/filter';
import { securityDetailParts } from '@/lib/security-event-text';

const blocked = async (text: string) => !(await filterUserInput('d1', text)).isValid;

beforeEach(() => {
  state.words = [];
  state.logs = [];
});

describe('카드번호', () => {
  it('붙여 쓰거나 띄어 쓴 카드번호도 막는다(예전엔 하이픈으로 쓴 것만)', async () => {
    expect(await blocked('카드번호 4111111111111111 입니다')).toBe(true);
    expect(await blocked('카드번호 4111 1111 1111 1111 입니다')).toBe(true);
    expect(await blocked('카드 5500-0000-0000-0004')).toBe(true);
    expect(await blocked('카드 6011 0009 9013 9424 결제')).toBe(true);
  });

  it('하이픈으로 쓴 16자리는 예전처럼 검증식과 상관없이 막고, 한 번만 알린다', async () => {
    const r = await filterUserInput('d1', '카드번호 1234-5678-9012-3456 입니다');
    expect(r.isValid).toBe(false);
    expect(r.blockedPatterns).toEqual(['1234-5678-9012-3456']);
    expect(r.securityEvents).toHaveLength(1);
  });

  it('카드번호가 아닌 16자리·네 자리 숫자 넷은 막지 않는다', async () => {
    expect(await blocked('2023 2024 2025 2026 예산 추이')).toBe(false); // 연도 넷(검증식은 통과하지만 발급사 첫 자리가 아님)
    expect(await blocked('과제번호 2026123456789012 확인')).toBe(false);
    expect(await blocked('일련번호 1234567890123456')).toBe(false);
    expect(await blocked('물량 4111 1111 1111 1112')).toBe(false); // 검증식이 틀림
    expect(await blocked('예산 1,234,567,890,123,456원')).toBe(false);
  });

  it('검증식(Luhn)', () => {
    expect(passesLuhn('4111111111111111')).toBe(true);
    expect(passesLuhn('4111111111111112')).toBe(false);
    expect(passesLuhn('1234567890123456')).toBe(false);
    expect(passesLuhn('')).toBe(false);
    expect(passesLuhn('41111111 1111111')).toBe(false);
  });
});

describe('주민등록번호', () => {
  it('띄어 쓴 꼴도 막는다(예전엔 하이픈을 붙여 쓴 것만)', async () => {
    expect(await blocked('주민번호 900101 1234567')).toBe(true);
    expect(await blocked('주민번호 900101 - 1234567')).toBe(true);
    expect(await blocked('주민번호 900101-1234567')).toBe(true);
    expect(await blocked('주민번호 9001011234567')).toBe(true);
  });

  it('하이픈으로 쓴 주민등록번호는 한 번만 알린다(같은 규칙이 둘이라 사건이 두 번 남았다)', async () => {
    const r = await filterUserInput('d1', '주민번호 900101-1234567');
    expect(r.blockedPatterns).toEqual(['900101-1234567']);
    expect(r.securityEvents).toHaveLength(1);
  });

  it('날짜가 아닌 여섯 자리·뒤 첫 자리가 1~8이 아닌 숫자 둘은 막지 않는다', async () => {
    expect(await blocked('예산 500000 1200000 비교')).toBe(false); // 달 00
    expect(await blocked('물량 901301 1234567')).toBe(false); // 13월
    expect(await blocked('수치 900101 9234567')).toBe(false); // 뒤 첫 자리 9
    expect(await blocked('2026년 11월 18일 회의')).toBe(false);
  });
});

describe('그대로인 것', () => {
  it('업무 글은 통과, 휴대전화·긴 숫자는 예전처럼 막는다', async () => {
    expect(await blocked('예산 150000000원 집행 계획')).toBe(false);
    expect(await blocked('전화 02-1234-5678로 문의')).toBe(false);
    expect(await blocked('문서번호 총무과-1234')).toBe(false);
    expect(await blocked('휴대폰 010 1234 5678')).toBe(true);
    expect(await blocked('계좌 110123456789')).toBe(true);
  });
});

describe('보안 로그', () => {
  it('사람 id를 주면 걸린 것이 남는다 — 개인정보는 걸린 글 없이 몇 곳인지만', async () => {
    const r = await filterUserInput('d1', '카드번호 4111 1111 1111 1111 입니다', 'u1');
    expect(r.isValid).toBe(false);
    expect(state.logs).toEqual([{ dept: 'd1', user: 'u1', type: 'personal_info_detected', severity: 'critical', details: { pattern: 'card_number', matches: 1 } }]);
    expect(JSON.stringify(state.logs)).not.toContain('4111');
  });

  it('금지어도 남는다, 걸린 것이 없으면 남지 않는다', async () => {
    state.words = [{ word: '대외비' }];
    await filterUserInput('d1', '대외비 자료 정리해 줘', 'u1');
    expect(state.logs.map((l) => [l.type, l.severity, l.user])).toEqual([['forbidden_word_detected', 'high', 'u1']]);
    state.logs = [];
    await filterUserInput('d1', '회의록 정리해 줘', 'u1');
    expect(state.logs).toHaveLength(0);
  });

  it('대화 준비가 필터에 사람 id를 넘긴다(예전엔 undefined라 한 번도 남지 않았다)', () => {
    const src = readFileSync('src/lib/assistant/prepare.ts', 'utf8');
    expect(src).toContain('await filterUserInput(actor.departmentId, message, actor.userId, { departmentIds: actor.visibleDepartmentIds })');
    expect(src).not.toContain('filterUserInput(actor.departmentId, message, undefined');
  });

  it('감사 화면 상세 — 개인정보는 몇 곳인지, 규칙 원문은 보이지 않는다', () => {
    const noName = () => null;
    expect(securityDetailParts({ pattern: 'card_number', matches: 2 }, noName)).toEqual(['개인정보 꼴 2곳']);
    expect(securityDetailParts({ pattern: '\\b\\d{6}-\\d{7}\\b', matches: 1 }, noName)).toEqual(['개인정보 꼴 1곳']);
    expect(securityDetailParts({ word: '대외비', context: '대외비 자료 정리해 줘' }, noName)).toEqual(['탐지어: 대외비']);
  });
});
