import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { describeAppCalls, estimateAppCalls } from '@/lib/apps/call-estimate';
import type { AppDefinition } from '@/lib/apps/definition';
import { PUBLIC_SECTOR_FORM_PRESETS } from '@/lib/agent-presets';

/** 입력형 앱 실행 전 예상 AI 호출 수(2026-11-07) — 실행기와 같은 규칙으로 센다 */

const fields = [
  { key: 'items', label: '목록', type: 'textarea' as const, required: true },
  { key: 'kind', label: '종류', type: 'select' as const, required: true, options: ['민원', '질의'] },
];
const def = (steps: NonNullable<AppDefinition['steps']>): AppDefinition => ({ schemaVersion: 1, fields, output: 'paragraphs', steps });

describe('estimateAppCalls', () => {
  it('단계가 없으면 한 번, 중간 단계 + 마지막 단계', () => {
    expect(estimateAppCalls({ schemaVersion: 1, fields, output: 'paragraphs' }, {}, 0)).toEqual({ min: 1, max: 1, lookups: 0, mayDigest: false });
    expect(estimateAppCalls(def([{ name: 'a', instruction: 'x' }, { name: 'b', instruction: 'y' }]), {}, 0)).toMatchObject({ min: 2, max: 2 });
  });

  it('줄마다 반복은 지금 입력의 줄 수, 파일마다 반복은 붙인 파일 수', () => {
    const lines = def([{ name: 'a', instruction: 'x', repeat: { field: 'items' } }, { name: 'b', instruction: 'y' }]);
    expect(estimateAppCalls(lines, { items: '하나\n\n둘\n셋 ' }, 0)).toMatchObject({ min: 4, max: 4 });
    const files: AppDefinition = { ...def([{ name: 'a', instruction: 'x', repeat: { files: true } }, { name: 'b', instruction: 'y' }]), attachments: { required: true } };
    expect(estimateAppCalls(files, {}, 3)).toEqual({ min: 4, max: 4, lookups: 0, mayDigest: true });
  });

  it('조회 단계는 AI가 아니라 조회로 센다, 입력만 보는 조건은 지금 입력으로 판정', () => {
    const d = def([
      { name: '찾기', instruction: '', lookup: { tool: 'law_search', query: '{{items}}' } },
      { name: '민원만', instruction: 'x', when: { all: [{ field: 'kind', op: 'equals', value: '민원' }] } },
      { name: '끝', instruction: 'y' },
    ]);
    expect(estimateAppCalls(d, { kind: '민원' }, 0)).toEqual({ min: 2, max: 2, lookups: 1, mayDigest: false });
    expect(estimateAppCalls(d, { kind: '질의' }, 0)).toEqual({ min: 1, max: 1, lookups: 1, mayDigest: false });
  });

  it('앞 분류 결과(@N)로 갈리는 단계는 미리 알 수 없어 많으면에만 넣는다', () => {
    const d = def([
      { name: '분류', instruction: '가르기', classify: { options: ['예', '아니오'] } },
      { name: '예일 때', instruction: 'x', when: { all: [{ field: '@1', op: 'equals', value: '예' }] } },
      { name: '끝', instruction: 'y' },
    ]);
    expect(estimateAppCalls(d, {}, 0)).toMatchObject({ min: 2, max: 3 });
  });

  it('기본 입력형 앱 — 질의 세 줄이면 4번, 법령 근거 조사는 법령 이름을 넣으면 조회 2번', () => {
    const qa = PUBLIC_SECTOR_FORM_PRESETS.find((p) => p.name === '질의별 답변 방향 정리')!.appDefinition!;
    expect(estimateAppCalls(qa, { questions: '가\n나\n다', kind: '민원' }, 0)).toMatchObject({ min: 4, max: 4 });
    const law = PUBLIC_SECTOR_FORM_PRESETS.find((p) => p.name === '법령 근거 조사')!.appDefinition!;
    expect(estimateAppCalls(law, { question: 'q', keyword: '여비' }, 0)).toEqual({ min: 1, max: 1, lookups: 1, mayDigest: false });
    expect(estimateAppCalls(law, { question: 'q', keyword: '여비', law_name: '공무원 여비 규정' }, 0)).toMatchObject({ lookups: 2 });
  });
});

describe('describeAppCalls·화면', () => {
  it('한 줄 문구', () => {
    expect(describeAppCalls({ min: 3, max: 3, lookups: 0, mayDigest: false })).toBe('예상 AI 호출 3번');
    expect(describeAppCalls({ min: 2, max: 4, lookups: 1, mayDigest: true })).toBe('예상 AI 호출 2~4번 · 공공 데이터 조회 1번(AI 사용량 없음) · 첨부가 길면 조각마다 추리는 호출이 더 듭니다');
  });
  it('실행 화면이 지금 입력·붙인 파일 수로 보인다', () => {
    const page = readFileSync('src/app/apps/run/page.tsx', 'utf8');
    expect(page).toContain("describeAppCalls(estimateAppCalls(definition, values, files.chips.filter(chip => chip.stage !== 'failed').length + pickedDocs.length))");
  });
});
