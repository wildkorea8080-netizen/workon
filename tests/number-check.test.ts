import { describe, it, expect } from 'vitest';
import { numbersIn, answerNumbers, checkNumbers, NUMBER_CHECK_NOTE, NUMBER_CHECK_TOOLS } from '@/lib/assistant/number-check';

/**
 * 숫자 확인(설계 5.4) — 답변 속 숫자를 이번 턴에 도구가 보여 준 숫자와 대조한다.
 * 답변은 고치지 않는다. 틀린 경고보다 놓친 경고가 덜 해롭다 — 오탐이 잦으면 안내를 아무도 읽지 않는다.
 */

describe('checkNumbers', () => {
  it('표기 차이는 같은 값', () => expect(checkNumbers('합계는 1,234천원, 감소 △5,678', [1234, -5678])).toEqual([]));
  it('반올림한 답은 확인됨', () => expect(checkNumbers('비율은 36.6%', [36.5853])).toEqual([]));
  it('원본에 없는 5자리 숫자는 표시', () => expect(checkNumbers('총 12,345건', [100, 200])).toEqual(['12,345']));
  it('4자리 미만 정수·연도·날짜·시각·id는 대조하지 않는다', () =>
    expect(checkNumbers('2026년 10월 21일 10:30에 a1/t3 표의 상위 3곳, 2026.10.21', [])).toEqual([]));
  it('영문자에 붙은 4자리 이상 숫자도 id라 대조하지 않는다', () => expect(checkNumbers('표 t1024와 a2048', [])).toEqual([]));
  it('괄호 음수·▲', () => expect(checkNumbers('(1,234) 감소, ▲2,000', [-1234, -2000])).toEqual([]));
  it('최대 10개, 중복 없음', () => {
    const nums = Array.from({ length: 15 }, (_, i) => `${(10001 + i).toLocaleString('en-US')}`);
    const answer = `${nums[0]} ${nums[0]} ${nums.join(', ')}`;
    expect(checkNumbers(answer, [])).toEqual(nums.slice(0, 10));
  });

  it('소수는 4자리 미만이어도 대조한다', () => expect(checkNumbers('평균 1.5배', [2])).toEqual(['1.5']));
  it('반올림 범위 밖이면 표시', () => expect(checkNumbers('비율은 36.7%', [36.5853])).toEqual(['36.7']));
  it('정수 답도 반올림한 값이면 확인됨', () => expect(checkNumbers('약 12,346원', [12345.6])).toEqual([]));
  it('쉼표 없는 큰 수·소수 원본', () => expect(checkNumbers('합계 1234567.5', [1234567.5])).toEqual([]));
  it('부호 표기가 달라도(감소라고 말하며 양수로 씀) 같은 값', () =>
    expect(checkNumbers('5,678천원 감소했습니다', [-5678])).toEqual([]));
  it('범위 2024-2025는 연도 둘이라 대조하지 않고, 1,000-2,000은 각각 양수', () => {
    expect(checkNumbers('2024-2025년', [])).toEqual([]);
    expect(checkNumbers('1,000-2,000원', [1000, 2000])).toEqual([]);
  });
  it('날짜 꼴 26. 3. 5.·2026-10-21·2026/10/21·2026. 10.는 대조하지 않는다', () =>
    expect(checkNumbers('26. 3. 5. 회의, 2026-10-21, 2026/10/21, 2026. 10. 기준', [])).toEqual([]));
  it('전화번호는 대조하지 않는다', () => expect(checkNumbers('문의 02-1234-5678', [])).toEqual([]));
  it('마크다운 표 속 숫자도 대조한다', () =>
    expect(checkNumbers('| 총무과 | 1,200 |\n| 기획과 | 9,999 |', [1200])).toEqual(['9,999']));
  it('표기가 다른 같은 원본 값 여러 개를 큰 원본에서 찾는다', () => {
    const shown = Array.from({ length: 50_000 }, (_, i) => i * 3);
    expect(checkNumbers('값 30,000과 30,001', shown)).toEqual(['30,001']);
  });
});

describe('answerNumbers', () => {
  it('raw·값·소수 자릿수', () =>
    expect(answerNumbers('합계 1,234.50원, △5,678, (9,000), -1,500')).toEqual([
      { raw: '1,234.50', value: 1234.5, decimals: 2 },
      { raw: '△5,678', value: -5678, decimals: 0 },
      { raw: '(9,000)', value: -9000, decimals: 0 },
      { raw: '-1,500', value: -1500, decimals: 0 },
    ]));
  it('괄호 안 다른 글이 있으면 음수가 아니다', () =>
    expect(answerNumbers('총무과(1,234천원)')).toEqual([{ raw: '1,234', value: 1234, decimals: 0 }]));
  it('쉼표 구분이 아닌 쉼표는 나눈다', () =>
    expect(answerNumbers('1,2345').map((n) => n.raw)).toEqual(['2345']));
});

describe('numbersIn', () => {
  it('numbersIn은 작은 수까지 모은다', () => expect(numbersIn('| 총무과 | 3 | 1,200 |')).toEqual([3, 1200]));
  it('△·괄호·% 앞 숫자·소수', () => expect(numbersIn('△100, (1,234), 36.5%, 0.25')).toEqual([-100, -1234, 36.5, 0.25]));
  it('빈 글', () => expect(numbersIn('')).toEqual([]));
});

describe('대화 화면 표시', () => {
  it('진행 중에는 done에서, 지난 대화는 source_references.number_check에서 읽어 말풍선 아래 안내로', async () => {
    const { readFileSync } = await import('fs');
    const chat = readFileSync('src/components/chat/ChatInterface.tsx', 'utf8');
    expect(chat).toContain("name === 'done'");
    expect(chat).toContain('payload.number_check');
    expect(chat).toContain('source_references?.number_check');
    const bubble = readFileSync('src/components/chat/MessageBubble.tsx', 'utf8');
    expect(bubble).toContain('role="note"');
    expect(bubble).toContain('NUMBER_CHECK_NOTE(numberCheck)');
  });
});

describe('안내 문구', () => {
  it('정해 둔 글', () =>
    expect(NUMBER_CHECK_NOTE(['12,345', '6,789'])).toBe('원본·계산 결과에서 확인되지 않은 숫자: 12,345 · 6,789 — 직접 확인하세요'));
  it('대조를 켜는 도구는 첨부 도구 둘', () =>
    expect([...NUMBER_CHECK_TOOLS].sort()).toEqual(['combine_tables', 'read_attachment']));
});

describe('최종 수정 — 소제목 번호·두 자리 연도 날짜(I5)', () => {
  it('줄머리 소제목 번호(1.1·2.3.1·- 1.2.)는 대조하지 않는다', () => {
    expect(checkNumbers('## 1.1 개요\n### 2.3 세부', [])).toEqual([]);
    expect(checkNumbers('2.3.1 추진 경과\n- 1.2. 세부 내용\n  3.4 기타', [])).toEqual([]);
  });
  it('줄 가운데의 소수와 단위가 붙은 줄머리 숫자는 그대로 대조한다', () => {
    expect(checkNumbers('평균 1.5배 늘었고\n1.2억 원이 들었다', [])).toEqual(['1.5', '1.2']);
  });
  it('두 자리 연도 날짜(26.10.21)는 대조하지 않는다', () => {
    expect(checkNumbers('작성일 26.10.21', [])).toEqual([]);
    expect(checkNumbers('작성일 26.10.21 기준, 합계 1,500.5', [1500.5])).toEqual([]);
  });
  it('달·날 범위를 벗어나면 날짜가 아니다', () => {
    expect(checkNumbers('비율 12.13.40 항목', [])).toEqual(['12.13']);
  });
});
