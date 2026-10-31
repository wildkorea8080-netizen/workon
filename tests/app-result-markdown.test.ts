import { describe, expect, it } from 'vitest';
import { markdownToDocumentBlocks, markdownToDocumentText } from '@/lib/apps/markdown-text';

describe('markdownToDocumentText — 내보낼 답의 마크다운 표시만 걷어낸다', () => {
  it('제목 기호·굵게·인용·구분선을 걷어내고 글은 그대로 둔다', () => {
    const md = [
      '## 가나시청 시민 강좌 개강식 안내문 — 최종 초안',
      '---',
      '**가나시청 시민 강좌 개강식 안내**',
      '아래와 같이 개최하오니 참석하여 주시기 바랍니다.',
      '',
      '- **행사명:** 가나시청 시민 강좌 개강식',
      '- **다과비:** 1인당 8,000원 → [확인 필요]',
      '***',
      '> ※ 이 문서는 초안입니다.',
    ].join('\n');
    expect(markdownToDocumentText(md)).toBe([
      '가나시청 시민 강좌 개강식 안내문 — 최종 초안',
      '',
      '가나시청 시민 강좌 개강식 안내',
      '아래와 같이 개최하오니 참석하여 주시기 바랍니다.',
      '',
      '- 행사명: 가나시청 시민 강좌 개강식',
      '- 다과비: 1인당 8,000원 → [확인 필요]',
      '',
      '※ 이 문서는 초안입니다.',
    ].join('\n'));
  });
  it('글머리 *·+는 -로, 들여쓰기와 번호 목록은 그대로', () => {
    expect(markdownToDocumentText('* 하나\n  + 둘\n1. 셋\n   2) 넷')).toBe('- 하나\n  - 둘\n1. 셋\n   2) 넷');
  });
  it('링크는 글(주소), 코드 표시는 글자만, 코드 울타리 줄은 뺀다', () => {
    expect(markdownToDocumentText('[법제처](https://law.go.kr) 참고\n```\n`a1` 값\n```')).toBe('법제처(https://law.go.kr) 참고\na1 값');
  });
  it('표는 구분 줄을 빼고 칸을 " | "로 잇는다', () => {
    expect(markdownToDocumentText('| 부서 | 예산 |\n|---|---:|\n| 총무과 | 1,200 |')).toBe('부서 | 예산\n총무과 | 1,200');
  });
  it('짝이 없는 별표·곱셈·각주 표시는 건드리지 않는다', () => {
    expect(markdownToDocumentText('3 * 4 = 12\n* 표시는 각주\n주의* 사항')).toBe('3 * 4 = 12\n- 표시는 각주\n주의* 사항');
    expect(markdownToDocumentText('2**10 계산')).toBe('2**10 계산');
  });
  it('빈 줄이 겹치면 하나로, 앞뒤 빈 줄은 없앤다', () => {
    expect(markdownToDocumentText('\n\n가\n\n\n---\n\n나\n\n')).toBe('가\n\n나');
  });
  it('마크다운이 없는 글은 그대로', () => {
    const plain = '가상 행사: 30명\n새빛회의실 & 검토 <필요>\n- 확정일은 미정입니다.';
    expect(markdownToDocumentText(plain)).toBe(plain);
  });
});

describe('markdownToDocumentBlocks — 구분 줄이 있는 표만 표 묶음으로 가른다', () => {
  it('머리글·구분 줄·행을 표 하나로, 앞뒤 글은 글 묶음으로', () => {
    const md = '## 예산 현황\n\n| 부서 | 예산 |\n|---|---:|\n| **총무과** | 1,200 |\n| `기획과` | 800 |\n\n※ 단위: 천원';
    expect(markdownToDocumentBlocks(md)).toEqual([
      { kind: 'text', text: '예산 현황\n' },
      { kind: 'table', header: ['부서', '예산'], rows: [['총무과', '1,200'], ['기획과', '800']] },
      { kind: 'text', text: '\n※ 단위: 천원' },
    ]);
  });
  it('바깥 세로줄이 없는 표·칸 수가 다른 행·이스케이프한 세로줄', () => {
    expect(markdownToDocumentBlocks('구분 | 값\n--- | ---\n가 | 1 | 덧붙임\n나\\|다 |')).toEqual([
      { kind: 'table', header: ['구분', '값'], rows: [['가', '1', '덧붙임'], ['나|다']] },
    ]);
  });
  it('구분 줄이 없는 세로줄 글은 표가 아니라 글이다', () => {
    expect(markdownToDocumentBlocks('| 가 | 나 |\n| 다 | 라 |')).toEqual([{ kind: 'text', text: '가 | 나\n다 | 라' }]);
  });
  it('빈 줄에서 표가 끝나고, 표 두 개는 따로 묶인다', () => {
    const blocks = markdownToDocumentBlocks('| a | b |\n|--|--|\n| 1 | 2 |\n\n| c |\n|--|\n| 3 |');
    expect(blocks.map(b => b.kind)).toEqual(['table', 'text', 'table']);
  });
  it('글로 이으면 markdownToDocumentText와 같다', () => {
    const md = '# 제목\n| 부서 | 예산 |\n|---|---:|\n| 총무과 | 1,200 |\n끝';
    const joined = markdownToDocumentBlocks(md).map(b => b.kind === 'text' ? b.text : [b.header, ...b.rows].map(r => r.join(' | ')).join('\n')).join('\n');
    expect(joined).toBe(markdownToDocumentText(md));
  });
});
