import { describe, it, expect } from 'vitest';
import { describeSpec } from '@/lib/table-engine/describe';

const NAMES = { a1: '예산.xlsx', a2: '현황.xlsx' };

describe('describeSpec', () => {
  it('지시를 문장으로', () => {
    expect(
      describeSpec(
        {
          sources: [
            { file: 'a1', table: 't1' },
            { file: 'a2', table: 't1' },
          ],
          filter: [{ column: '구분', op: '=', value: '사업비' }],
          group_by: ['부서'],
          aggregate: [{ column: '예산(천원)', fn: 'sum' }],
          sort: [{ column: '예산(천원)', desc: true }],
          total_row: true,
        },
        NAMES
      )
    ).toEqual(['원천: 예산.xlsx(t1), 현황.xlsx(t1)', '거르기: 구분 = 사업비', '부서 기준으로 묶어 예산(천원) 합계', '정렬: 예산(천원) 내림차순', '맨 아래 합계 행']);
  });

  it('원천 옵션·여러 조건·이름 붙인 집계·작은 순·출처 열', () => {
    expect(
      describeSpec(
        {
          sources: [
            {
              file: 'a1',
              table: 't2',
              header_rows: [1, 2],
              rename: { 금액: '예산' },
              scale: { 예산: 0.001 },
              skip_rows_matching: ['기타'],
            },
            { file: 'a9', table: 't1' },
          ],
          filter: [
            { column: '예산', op: '>=', value: 100 },
            { column: '구분', op: 'contains', value: '사업' },
            { column: '부서', op: '!=', value: '총무과' },
          ],
          group_by: ['부서', '연도'],
          aggregate: [
            { column: '예산', fn: 'sum', as: '총예산' },
            { column: '예산', fn: 'count' },
            { column: '집행률', fn: 'avg' },
          ],
          sort: [{ column: '부서' }],
          add_source_column: true,
        },
        NAMES
      )
    ).toEqual([
      '원천: 예산.xlsx(t2), a9(t1)',
      '예산.xlsx(t2): 머리글 1~2행',
      '예산.xlsx(t2): 열 이름 바꿈 금액 → 예산',
      '예산.xlsx(t2): 예산 × 0.001',
      '예산.xlsx(t2): 첫 칸이 기타인 행 뺌',
      '출처 열을 붙임',
      '거르기: 예산 ≥ 100, 구분에 "사업" 포함, 부서 ≠ 총무과',
      '부서·연도 기준으로 묶어 예산 합계("총예산"), 예산 개수, 집행률 평균',
      '정렬: 부서 오름차순',
    ]);
  });

  it('묶기만, 집계만', () => {
    expect(describeSpec({ sources: [{ file: 'a1', table: 't1' }], group_by: ['부서'] }, NAMES)).toEqual([
      '원천: 예산.xlsx(t1)',
      '부서 기준으로 묶음',
    ]);
    expect(
      describeSpec({ sources: [{ file: 'a1', table: 't1' }], aggregate: [{ column: '예산', fn: 'max' }] }, NAMES)
    ).toEqual(['원천: 예산.xlsx(t1)', '전체 예산 최대']);
  });
});
