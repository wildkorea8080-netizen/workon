import { describe, it, expect } from 'vitest';
import { buildTable, captionAbove, columnNames, detectHeader } from '@/lib/attachments/header';
import {
  ATTACHMENT_ACCEPT,
  attachmentExtension,
  refusedFormatMessage,
} from '@/lib/attachments/limits';

describe('머리글 추정', () => {
  it('2단 머리글을 잇는다', () => {
    const cells = [
      ['구분', '예산', null],
      [null, '본예산', '추경'],
      ['총무과', 100, 20],
    ];
    const merges = [
      { row: 0, col: 0, rows: 2, cols: 1 },
      { row: 0, col: 1, rows: 1, cols: 2 },
    ];
    const header = detectHeader(cells, merges);
    expect(header).toEqual({ from: 0, to: 1 });
    expect(columnNames(cells, merges, header)).toEqual(['구분', '예산 / 본예산', '예산 / 추경']);
  });

  it('제목 줄 아래의 머리글을 찾는다', () => {
    const cells = [
      ['2026년 예산 현황', null, null],
      [null, null, null],
      ['부서', '예산', '비고'],
      ['총무과', 1, null],
    ];
    expect(detectHeader(cells, [])).toEqual({ from: 2, to: 2 });
  });

  it('숫자뿐인 줄은 머리글이 아니다 — CSV처럼 숫자가 글자로 와도', () => {
    const cells = [
      ['부서', '예산'],
      ['총무과', '100'],
    ];
    expect(detectHeader(cells, [])).toEqual({ from: 0, to: 0 });
    // 첫 줄이 값뿐이면 다음 글자 줄을 머리글로 본다
    expect(detectHeader([['1', '2'], ['부서', '예산']], [])).toEqual({ from: 1, to: 1 });
  });

  it('머리글이 3줄을 넘지 않는다', () => {
    const cells = [['가', '나', null], ['다', null, null], ['라', null, null], ['마', null, null], ['바', 1, 2]];
    const merges = [0, 1, 2, 3].map((row) => ({ row, col: 0, rows: 1, cols: 2 }));
    expect(detectHeader(cells, merges)).toEqual({ from: 0, to: 2 });
  });

  it('머리글처럼 보이는 줄이 없으면 첫 줄', () => {
    expect(detectHeader([[1, 2], [3, 4]], [])).toEqual({ from: 0, to: 0 });
  });
});

describe('열 이름', () => {
  it('빈 이름과 겹치는 이름', () => {
    expect(columnNames([['금액', null, '금액']], [], { from: 0, to: 0 })).toEqual([
      '금액',
      '열 2',
      '금액 (2)',
    ]);
  });

  it('머리글 밖으로 번지는 세로 병합은 머리글 안에서만 채운다', () => {
    const cells = [['구분', '값'], [null, 'a'], [null, 1]];
    const merges = [{ row: 0, col: 0, rows: 3, cols: 1 }];
    expect(columnNames(cells, merges, { from: 0, to: 0 })).toEqual(['구분', '값']);
  });
});

describe('캡션', () => {
  it('바로 위 비지 않은 줄', () => {
    expect(captionAbove(['먼 제목', '', '  2026년 집행 현황  ', ''])).toBe('2026년 집행 현황');
    expect(captionAbove(['', ' '])).toBeUndefined();
    expect(captionAbove([])).toBeUndefined();
  });
});

describe('buildTable', () => {
  it('id·머리글·열 이름을 한 번에 정한다', () => {
    const t = buildTable(3, '시트1', [['부서', '예산'], ['총무과', 1]], [], '단위: 천원', { rows: 30000 });
    expect(t.id).toBe('t3');
    expect(t.header).toEqual({ from: 0, to: 0 });
    expect(t.columns).toEqual(['부서', '예산']);
    expect(t.caption).toBe('단위: 천원');
    expect(t.truncated).toEqual({ rows: 30000 });
  });

  it('캡션·잘림이 없으면 키를 만들지 않는다', () => {
    const t = buildTable(1, '표 1', [['가', '나']], []);
    expect('caption' in t).toBe(false);
    expect('truncated' in t).toBe(false);
  });
});

describe('첨부 형식', () => {
  it('허용 확장자는 소문자·점 없이, 밖이면 null', () => {
    expect(attachmentExtension('예산.XLSX')).toBe('xlsx');
    expect(attachmentExtension('a.b.hwpx')).toBe('hwpx');
    expect(attachmentExtension('옛.xls')).toBeNull();
    expect(attachmentExtension('noext')).toBeNull();
    expect(ATTACHMENT_ACCEPT).toBe('.xlsx,.xlsm,.csv,.hwpx,.hwp,.docx,.pdf,.pptx,.txt');
  });

  it('옛 형식은 저장 방법을 안내한다', () => {
    expect(refusedFormatMessage('a.XLS')).toContain('XLSX로 저장');
    expect(refusedFormatMessage('a.ppt')).toContain('PPTX로 저장');
    expect(refusedFormatMessage('a.doc')).toContain('DOCX로 저장');
    expect(refusedFormatMessage('a.docx')).toBeNull();
  });
});

describe('머리글 보정 (1차 수정)', () => {
  it('연도 머리글을 머리글로 본다', () => {
    const cells = [['구분', 2024, 2025], ['총무과', 100, 50], ['기획과', 50, 20]];
    const header = detectHeader(cells, []);
    expect(header).toEqual({ from: 0, to: 0 });
    expect(columnNames(cells, [], header)).toEqual(['구분', '2024', '2025']);
  });

  it('연도·월·분기 꼴 글도 머리글 칸이다', () => {
    expect(detectHeader([['구분', '2024년', '1분기'], ['가', 1, 2]], [])).toEqual({ from: 0, to: 0 });
    expect(detectHeader([['구분', '3월', '2025년도'], ['가', 1, 2]], [])).toEqual({ from: 0, to: 0 });
  });

  it('가로 병합 아래 줄에 숫자가 있으면 그 줄은 데이터다', () => {
    const cells = [['부서', '비고', null], ['총무과', 100, 200]];
    const merges = [{ row: 0, col: 1, rows: 1, cols: 2 }];
    expect(detectHeader(cells, merges)).toEqual({ from: 0, to: 0 });
  });

  it('병합 칸 아래가 비어 있으면 하위 머리글이 아니다', () => {
    const cells = [['부서', '비고', null], ['총무과', null, null]];
    const merges = [{ row: 0, col: 1, rows: 1, cols: 2 }];
    expect(detectHeader(cells, merges)).toEqual({ from: 0, to: 0 });
  });

  it('하위 머리글 줄의 연도는 숫자로 세지 않는다', () => {
    const cells = [['구분', '예산', null], [null, 2024, 2025], ['총무과', 100, 20]];
    const merges = [{ row: 0, col: 1, rows: 1, cols: 2 }];
    expect(detectHeader(cells, merges)).toEqual({ from: 0, to: 1 });
  });
});

describe('머리글이 첫 데이터 행을 삼키지 않는다 (최종 수정)', () => {
  const merged = [{ row: 0, col: 1, rows: 1, cols: 2 }];

  it('가로 병합 밖 칸에 글이 있는 아래 줄은 데이터다 — 연도꼴 숫자만 있어도', () => {
    const cells = [['구분', '인원', null], ['총무과', 2000, 2010], ['기획과', 300, 400]];
    const header = detectHeader(cells, merged);
    expect(header).toEqual({ from: 0, to: 0 });
    expect(columnNames(cells, merged, header)).toEqual(['구분', '인원', '인원 (2)']);
  });

  it('△ 음수가 든 아래 줄도 데이터다', () => {
    const cells = [['구분', '인원', null], ['총무과', '△100', '△50'], ['기획과', 300, 400]];
    expect(detectHeader(cells, merged)).toEqual({ from: 0, to: 0 });
  });

  it('세로 병합된 항목 칸 아래의 하위 머리글은 그대로 잇는다', () => {
    const cells = [['구분', '예산', null], [null, '본예산', '추경'], ['총무과', 100, 20]];
    const merges = [{ row: 0, col: 0, rows: 2, cols: 1 }, ...merged];
    expect(detectHeader(cells, merges)).toEqual({ from: 0, to: 1 });
  });

  it('기준연도 같은 메타 줄은 머리글이 아니다 — 연도꼴은 한 줄에 2개 이상일 때만 머리글 근거', () => {
    expect(detectHeader([['기준연도', 2025], ['부서', '예산'], ['총무과', 100]], [])).toEqual({ from: 1, to: 1 });
    expect(detectHeader([['단위', '2026년'], ['부서', '예산'], ['총무과', 100]], [])).toEqual({ from: 1, to: 1 });
  });

  it('숫자 판정: △▲·괄호 음수·단위 접미사·홀로 쓴 줄표는 값이다', () => {
    for (const v of ['△100', '▲ 1,200', '(1,234)', '1,000원', '30천원', '5백만원', '2억원', '12.5%', '30명', '4건', '7개', '2,000톤', '-', '—']) {
      // 값 칸이 섞인 줄은 머리글로 뽑히지 않는다
      expect(detectHeader([['총무과', v, v], ['부서', '예산', '집행']], []), v).toEqual({ from: 1, to: 1 });
    }
    // 글자 머리글은 그대로
    expect(detectHeader([['구분', '원가', '비율(%)'], ['가', 1, 2]], [])).toEqual({ from: 0, to: 0 });
  });
});
