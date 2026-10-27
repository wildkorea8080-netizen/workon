import { describe, it, expect, beforeAll } from 'vitest';
import { readAttachment } from '@/lib/attachments/reader';
import { aggregateCollection, fieldKind, fieldStem, parseDecisions, type CollectionSourceInput } from '@/lib/work/workflows/collection/aggregate';
import { fixture, fixtureWorkbooks } from './helpers/quarterly-fixture';

/**
 * 자료 취합 엔진 — 가상 분기 실적 과제(08 문서 '분기 실적 통합 과제' 2~6, A14·A15).
 * 원자료는 실제 XLSX를 만들어 실제 첨부 읽기로 읽는다.
 */
const FIELDS = ['예산액', '집행액', '참여자 수', '집행률'];

describe('자료 취합(collection) 엔진', () => {
  let sources: CollectionSourceInput[];

  beforeAll(async () => {
    const files = await fixtureWorkbooks();
    sources = [];
    for (const f of files) {
      const ex = await readAttachment(f.bytes, f.fileName);
      sources.push({ id: f.id, name: f.fileName, sha256: f.sha256, text: ex.text, tables: ex.tables, truncated: ex.tables.some((t) => Boolean(t.truncated)) });
    }
  });

  it('항목 이름의 종류·핵심어', () => {
    expect(FIELDS.map(fieldKind)).toEqual(['money', 'money', 'count', 'rate']);
    expect(fieldStem('부서별 예산액')).toBe('예산');
    expect(fieldStem('참여자 수')).toBe('참여자');
  });

  it('확인 전 — 미제출 부서 때문에 막고, 중복 사본은 더하지 않으며, 원·천원을 맞추고 소계를 뺀다', () => {
    const r = aggregateCollection({ sources, expectedDepartments: fixture.expectedDepartments, fieldNames: FIELDS });
    const codes = r.review.map((i) => i.code);
    expect(codes).toContain('MISSING_DEPARTMENT');
    expect(r.review.find((i) => i.code === 'MISSING_DEPARTMENT')!.severity).toBe('blocking');
    expect(r.review.find((i) => i.code === 'MISSING_DEPARTMENT')!.message).toContain('운영팀');
    expect(codes).toContain('DUPLICATE_CANDIDATE');
    expect(codes).toContain('UNIT_CONVERTED');
    expect(codes).toContain('SUMMARY_ROWS_EXCLUDED');
    expect(r.sources.find((s) => s.id === 'planning-duplicate')).toMatchObject({ status: 'duplicate', duplicateOf: 'planning-original' });
    expect(r.provisional).toBe(true);
    // 잠정이어도 숫자는 낸다 — 미제출 부서는 0이 아니라 빈 값
    expect(r.totals['예산액']).toBe(fixture.expectedAfterReview.budgetKrw);
    expect(r.departments.find((d) => d.name === '운영팀')).toMatchObject({ status: 'missing', values: { 예산액: null } });
  });

  it('확인 후(잠정 집계 승인) — 기대 수치와 같다: 예산 2,600,000원·집행 1,850,000원·참여 62명·집행률 71.15', () => {
    const r = aggregateCollection({ sources, expectedDepartments: fixture.expectedDepartments, fieldNames: FIELDS, decisions: { allowProvisional: true } });
    const e = fixture.expectedAfterReview;
    expect(r.totals['예산액']).toBe(e.budgetKrw);
    expect(r.totals['집행액']).toBe(e.spentKrw);
    expect(r.totals['참여자 수']).toBe(e.participants);
    expect(r.totals['집행률']!.toFixed(2)).toBe(e.executionRatePercentDisplay);
    expect(r.departments.filter((d) => d.status === 'missing').map((d) => d.name)).toEqual(e.missingDepartments);
    expect(r.review.filter((i) => i.severity === 'blocking')).toEqual([]);
    expect(r.review.find((i) => i.code === 'PROVISIONAL')).toBeTruthy();
    // 원·천원: 기획팀 700천원 → 700,000원
    expect(r.departments.find((d) => d.name === '기획팀')!.values['예산액']).toBe(1_200_000);
    expect(r.departments.find((d) => d.name === '교육팀')!.values['예산액']).toBe(600_000);
  });

  it('원본 대응 — 값마다 원천 파일·표·추출 행, 소계 행은 대응에 없다', () => {
    const r = aggregateCollection({ sources, expectedDepartments: fixture.expectedDepartments, fieldNames: FIELDS, decisions: { allowProvisional: true } });
    const planning = r.trace.filter((t) => t.department === '기획팀' && t.field === '예산액');
    expect(planning.map((t) => [t.rawValue, t.unit, t.value])).toEqual([
      [700, '천원', 700_000],
      [500, '천원', 500_000],
    ]);
    expect(planning.every((t) => t.sourceId === 'planning-original' && t.table === 't1' && t.extractedRow > 0)).toBe(true);
    expect(r.skippedRows.some((s) => s.text.startsWith('소계'))).toBe(true);
    // 셈 항목(참여자 수)에는 표 위 글의 돈 단위를 붙이지 않는다
    expect(r.trace.find((t) => t.field === '참여자 수')!.unit).toBeNull();
    // 원자료의 합 = 결과
    expect(r.trace.filter((t) => t.field === '예산액').reduce((a, t) => a + t.value, 0)).toBe(r.totals['예산액']);
  });

  it('직원이 사본을 다른 자료라고 넣으면 더한다(두 번 들어감을 직원이 정한 것) · 단위를 천원으로', () => {
    const r = aggregateCollection({
      sources,
      expectedDepartments: fixture.expectedDepartments,
      fieldNames: FIELDS,
      decisions: { allowProvisional: true, includedSourceIds: ['planning-duplicate'], outputUnit: '천원' },
    });
    expect(r.totals['예산액']).toBe(3800); // (1200 + 1200 + 800 + 600)천원
    expect(r.review.map((i) => i.code)).toContain('MULTIPLE_SUBMISSIONS');
  });

  it('A15 — 일부만 읽힌 표는 전체 완료를 막는다', () => {
    const truncated = sources.map((s) => (s.id === 'business-original' ? { ...s, truncated: true } : s));
    const r = aggregateCollection({ sources: truncated, expectedDepartments: fixture.expectedDepartments, fieldNames: FIELDS, decisions: { allowProvisional: true } });
    expect(r.review.find((i) => i.code === 'SOURCE_TRUNCATED')?.severity).toBe('blocking');
  });

  it('단위를 모르는 돈 열은 짐작해 더하지 않는다', () => {
    const noUnit = sources.map((s) => (s.id === 'business-original' ? { ...s, tables: s.tables.map((t) => ({ ...t, caption: undefined })) } : s));
    const r = aggregateCollection({ sources: noUnit, expectedDepartments: fixture.expectedDepartments, fieldNames: FIELDS, decisions: { allowProvisional: true } });
    expect(r.review.find((i) => i.code === 'UNIT_UNKNOWN')?.severity).toBe('blocking');
    expect(r.departments.find((d) => d.name === '사업팀')!.values['예산액']).toBeNull();
  });

  it('결정 값은 다시 검사한다 — 모르는 원자료 id·부서는 버린다', () => {
    expect(parseDecisions({ excludedSourceIds: ['x', 'a'], outputUnit: '억원', departmentOverrides: { a: '없는팀', b: '기획팀' } }, ['a', 'b'], ['기획팀'])).toEqual({
      excludedSourceIds: ['a'],
      includedSourceIds: [],
      outputUnit: '원',
      allowProvisional: false,
      departmentOverrides: { b: '기획팀' },
    });
  });
});
