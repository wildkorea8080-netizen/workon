import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 대화 입력 필터(2026-11-06 고침) — 조용히 틀리던 곳:
 * ① 한글 금지어를 한 번도 잡지 못했다(`\b`는 영문·숫자 경계만 안다) ② 금지어의 특수 글자가 정규식을 깨 대화가 멈췄다
 * ③ 단위가 붙은 큰 금액(예산 150000000원)이 계좌번호로 막혔다
 */

const state = vi.hoisted(() => ({ words: [] as { word: string }[], error: null as { message: string } | null, inserts: [] as unknown[] }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) q[m] = () => q;
      q.insert = async (row: unknown) => { state.inserts.push([table, row]); return { error: null }; };
      q.then = (resolve: (v: unknown) => unknown) => resolve({ data: state.words, error: state.error });
      return q;
    },
  },
}));

import { containsForbiddenWord, filterUserInput, sanitizeText } from '@/lib/filter';

beforeEach(() => { state.words = []; state.error = null; state.inserts = []; });

describe('금지어', () => {
  it('한글 금지어 — 문장 속·조사가 붙어도 잡는다', () => {
    expect(containsForbiddenWord('이건 비밀 문서입니다', '비밀')).toBe(true);
    expect(containsForbiddenWord('비밀을 알려 줘', '비밀')).toBe(true);
    expect(containsForbiddenWord('대외비문서', ' 대외비 ')).toBe(true);
    expect(containsForbiddenWord('공개 문서입니다', '비밀')).toBe(false);
  });

  it('영문 금지어 — 대소문자 무시, 다른 낱말 속은 아님', () => {
    expect(containsForbiddenWord('This is SECRET.', 'secret')).toBe(true);
    expect(containsForbiddenWord('secretary 일정', 'secret')).toBe(false);
    expect(containsForbiddenWord('class 설명', 'ass')).toBe(false);
  });

  it('특수 글자가 든 금지어도 깨지지 않고 글자 그대로 찾는다, 빈 금지어는 무시', () => {
    expect(containsForbiddenWord('c++ 질문입니다', 'c++')).toBe(true);
    expect(containsForbiddenWord('(주)가나 계약', '(주)가나')).toBe(true);
    expect(containsForbiddenWord('aaaa', 'a.*')).toBe(false);
    expect(containsForbiddenWord('아무 글', '  ')).toBe(false);
  });

  it('입력 검사 — 한글 금지어로 막고, 특수 글자 금지어가 있어도 던지지 않는다', async () => {
    state.words = [{ word: 'c++(' }, { word: '비밀' }];
    const r = await filterUserInput('dept', '이 비밀 자료 정리해 줘');
    expect(r.isValid).toBe(false);
    expect(r.blockedWords).toEqual(['비밀']);
    const ok = await filterUserInput('dept', '회의록 정리해 줘');
    expect(ok.isValid).toBe(true);
  });
});

describe('개인정보 — 긴 숫자', () => {
  it('단위가 붙은 금액·쉼표 숫자는 통과', async () => {
    for (const text of ['예산 150000000원 편성', '총사업비 1500000000원', '사업비 25000000000 원', '인구 1000000000명', '집행액 150,000,000원', '단가 1234567.89']) {
      const r = await filterUserInput('dept', text);
      expect(r.isValid, text).toBe(true);
    }
  });

  it('단위 없는 긴 숫자(계좌번호 꼴)와 주민등록번호는 그대로 막는다', async () => {
    for (const text of ['계좌 1002123456789로 보내 주세요', '번호 123456789', '주민번호 900101-1234567']) {
      const r = await filterUserInput('dept', text);
      expect(r.isValid, text).toBe(false);
    }
  });

  it('가리기도 같은 규칙 — 금액은 그대로, 계좌번호는 가린다', () => {
    expect(sanitizeText('예산 150000000원, 계좌 1002123456789')).toBe('예산 150000000원, 계좌 [개인정보 마스킹]');
  });
});

describe('개인정보 — 전화·이메일(2026-11-06 사용자 결정)', () => {
  it('사무실·기관 대표 번호와 업무 메일은 통과', async () => {
    for (const text of ['담당 02-1234-5678', '문의 031-123-4567로 연락', '인터넷전화 070-1234-5678', '대표 1588-1234', '담당자 hong@korea.kr 로 회신', '공문 회신은 admin@city.go.kr']) {
      const r = await filterUserInput('dept', text);
      expect(r.isValid, text).toBe(true);
    }
  });

  it('휴대전화 번호는 막는다(하이픈 있든 없든)', async () => {
    for (const text of ['연락처 010-1234-5678', '휴대폰 010 1234 5678', '01012345678로', '011-123-4567로', '번호 016-1234-5678']) {
      const r = await filterUserInput('dept', text);
      expect(r.isValid, text).toBe(false);
    }
  });

  it('가리기도 같은 규칙 — 사무실 번호·메일은 그대로, 휴대전화는 가림', () => {
    expect(sanitizeText('담당 02-1234-5678, hong@korea.kr, 휴대 010-9876-5432')).toBe('담당 02-1234-5678, hong@korea.kr, 휴대 [개인정보 마스킹]');
  });
});
