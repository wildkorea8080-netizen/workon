import { describe, it, expect } from 'vitest';
import {
  assessEvidence,
  foreignIssuerOf,
  normalizeDate,
  numberEvidence,
  parseEnforcedDate,
  sameLocalGovernment,
  type RawEvidence,
} from '@/lib/work/workflows/regulations/evidence';
import { memoFieldValues, settleFindings, kstDate } from '@/lib/work/workflows/regulations/memo';
import { gatherEvidence, parseLawSearch, pickArticles, splitArticles, type RegulationProviders } from '@/lib/work/workflows/regulations/gather';
import { parseDraft, parsePlan, mockRegulationModel } from '@/lib/work/workflows/regulations/model';
import { regulationReviewItems } from '@/lib/work/runs/executor';
import { WorkError } from '@/lib/work/types';

/**
 * 규정·지침 확인(regulations) — 순수 규칙. 카탈로그 validationRules:
 * 기관·지역·효력일·별표·예외 / 충돌·근거 부족 유보 / 실제 확인한 원문 위치만. 시나리오 A16(구규정·최신 규정·타 기관 규정).
 */
const raw = (over: Partial<RawEvidence>): RawEvidence => ({
  kind: 'law',
  title: '공무원 여비 규정',
  location: '제17조(숙박비)',
  effectiveDate: '2026-01-01',
  editionYear: null,
  issuer: null,
  text: '숙박비는 상한액 범위에서 실비로 지급한다.',
  url: null,
  ...over,
});
const ctx = { basisDate: '2026-10-27', organizationName: '가나시청' };

describe('근거 적용 판정', () => {
  it('날짜 꼴을 하나로 맞추고 못 읽으면 짐작하지 않는다', () => {
    expect(normalizeDate('20260101')).toBe('2026-01-01');
    expect(normalizeDate('2026. 1. 5.')).toBe('2026-01-05');
    expect(normalizeDate('2026-13-01')).toBeNull();
    expect(normalizeDate('내년 초')).toBeNull();
    expect(parseEnforcedDate('공무원 여비 규정 (시행 2026-01-01)')).toBe('2026-01-01');
    expect(parseEnforcedDate('시행일 없음')).toBeNull();
  });

  it('A16 — 시행일이 기준일 뒤인 법령은 근거로 쓰지 않는다(이유와 함께)', () => {
    const r = assessEvidence(raw({ effectiveDate: '2027-01-01' }), ctx);
    expect(r.applicability).toBe('after_basis');
    expect(r.note).toContain('2027-01-01');
    expect(assessEvidence(raw({ effectiveDate: '2026-10-27' }), ctx).applicability).toBe('applicable');
  });

  it('A16 — 다른 지자체 자치법규는 제외, 같은 지자체(가나시청 ↔ 가나시)는 쓴다', () => {
    expect(assessEvidence(raw({ kind: 'ordinance', issuer: '다라시' }), ctx).applicability).toBe('other_org');
    expect(assessEvidence(raw({ kind: 'ordinance', issuer: '가나시' }), ctx).applicability).toBe('applicable');
    expect(assessEvidence(raw({ kind: 'ordinance', issuer: null }), ctx).applicability).toBe('other_org');
    expect(sameLocalGovernment('가나시청(시험)', '가나시')).toBe(true);
    expect(sameLocalGovernment('가나시청', '가나군')).toBe(false);
  });

  it('A16 — 머리에 다른 기관 이름이 있고 이 기관 이름이 없는 추가 자료는 다른 기관 자료로 본다', () => {
    expect(foreignIssuerOf('다라공단 여비 지급 규정\n제1조 …', '가나시청')).toBe('다라공단');
    // 이 기관 규정이 다른 기관을 인용하는 것은 다른 기관 자료가 아니다
    expect(foreignIssuerOf('다라공단과의 협약에 따라 가나시 직원의 여비를 …', '가나시청')).toBeNull();
    expect(assessEvidence(raw({ kind: 'upload', effectiveDate: null, text: '다라공단 여비 지급 규정' }), ctx).applicability).toBe('other_org');
  });

  it('시행일을 모르는 기관 문서는 쓰되 확인 필요, 공통 기준은 판 연도로 본다', () => {
    expect(assessEvidence(raw({ kind: 'org_doc', effectiveDate: null }), ctx)).toMatchObject({ applicability: 'date_unknown' });
    expect(assessEvidence(raw({ kind: 'common', effectiveDate: null, editionYear: 2026 }), ctx).applicability).toBe('applicable');
    expect(assessEvidence(raw({ kind: 'common', effectiveDate: null, editionYear: 2027 }), ctx).applicability).toBe('after_basis');
  });

  it('번호는 E1부터, 원문은 1,500자에서 자른다', () => {
    const n = numberEvidence([raw({}), raw({ text: 'x'.repeat(3000) })], ctx);
    expect(n.map((e) => e.id)).toEqual(['E1', 'E2']);
    expect(n[1].text.length).toBe(1500);
  });
});

describe('의견 확정 — 근거 없는 판단은 유보', () => {
  const evidence = numberEvidence(
    [raw({}), raw({ kind: 'org_doc', title: '가나시 여비 지침', location: 'p.3', effectiveDate: null }), raw({ effectiveDate: '2027-03-01', title: '개정 여비 규정' })],
    ctx
  );

  it('쓸 수 있는 근거가 있는 문장만 의견으로 남고, 없는 번호·제외 근거·번호 없음은 유보로 간다', () => {
    const o = settleFindings(
      {
        findings: [
          { text: '숙박비는 상한액 범위의 실비 [E1]', evidenceIds: ['E1'] },
          { text: '지침상 사전 승인이 필요함', evidenceIds: ['E2'] },
          { text: '개정 규정상 정액 지급', evidenceIds: ['E3'] },
          { text: '초과분은 지급 가능함', evidenceIds: [] },
          { text: '없는 번호', evidenceIds: ['E9'] },
        ],
        reservations: [{ text: '두 지침이 서로 다름' }],
      },
      evidence
    );
    expect(o.findings.map((f) => f.text)).toEqual(['숙박비는 상한액 범위의 실비', '지침상 사전 승인이 필요함']);
    expect(o.findings[1].dateCheck).toBe(true);
    expect(o.reservations.map((r) => r.text)).toEqual(['개정 규정상 정액 지급', '초과분은 지급 가능함', '없는 번호', '두 지침이 서로 다름']);
    expect(o.reservations[0].reason).toContain('기준일 뒤');
  });

  it('메모의 위치·시행일은 찾은 자료 정보로만 쓰고, 제외 근거는 이유와 함께 목록에 남긴다', () => {
    const outcome = settleFindings({ findings: [{ text: '실비 지급', evidenceIds: ['E1'] }], reservations: [] }, evidence);
    const m = memoFieldValues({ title: '여비 검토', question: '숙박비 초과분?', basisDate: '2026-10-27', scope: '국내 출장', departmentName: '총무과', today: '2026. 10. 27.', evidence, outcome, unavailable: ['기관 문서: 키 없음'] });
    expect(m.opinion).toBe('○ 실비 지급 [E1]');
    expect(m.system['근거']).toContain('[E1] 공무원 여비 규정 · 제17조(숙박비) (법령, 시행 2026-01-01)');
    expect(m.system['근거']).toContain('[E2] 가나시 여비 지침 · p.3 (기관 문서, 시행일 확인 필요) — 찾았으나 의견에 쓰지 않음');
    expect(m.system['근거']).toMatch(/\[E3\] 개정 여비 규정 .* — 제외: 시행일\(2027-03-01\)/);
    expect(m.system['검토 범위']).toContain('법률적 최종 판단이 아닙니다');
    expect(m.system['검토 범위']).toContain('- 기관 문서: 키 없음');
    expect(m.system['유보·확인 필요']).toBe('없음');
  });

  it('의견이 하나도 없으면 빈 칸이 아니라 판단 유보라고 적는다', () => {
    const m = memoFieldValues({ title: 't', question: 'q', basisDate: '2026-10-27', scope: 's', departmentName: null, today: kstDate(new Date('2026-10-26T20:00:00Z')), evidence: [], outcome: { findings: [], reservations: [] }, unavailable: [] });
    expect(m.opinion).toContain('유보');
    expect(m.system['작성일']).toBe('2026. 10. 27.');
    expect(m.system['근거']).toBe('확인한 근거 없음');
    expect('작성부서' in m.system).toBe(false);
  });

  it('확인 사항 — 유보·제외·시행일 미확인·찾지 못한 범위', () => {
    const outcome = settleFindings({ findings: [{ text: '지침상 승인', evidenceIds: ['E2'] }, { text: '근거 없음', evidenceIds: [] }], reservations: [] }, evidence);
    const items = regulationReviewItems({ evidence, outcome, unavailable: ['국가법령정보: 연결 없음'] }, (l) => (l === '검토 의견' ? 's4' : l === '유보·확인 필요' ? 's6' : null));
    expect(items.map((i) => i.code)).toEqual(['RESERVED', 'EFFECTIVE_DATE_UNKNOWN', 'EVIDENCE_EXCLUDED', 'SOURCE_LIMITED']);
    expect(items.find((i) => i.code === 'RESERVED')!.field_ids).toEqual(['s6']);
    expect(items.every((i) => i.severity !== 'blocking')).toBe(true);
  });
});

describe('법제처 결과 읽기', () => {
  // connectors/law.ts search()의 글 꼴
  const searchText = `[법령] "여비" 검색 결과 2건 (전체 12건)

1. 공무원 여비 규정
   법령구분: 대통령령 / 소관부처: 인사혁신처
   시행일자: 2026-01-01 / 공포일자: 2025-12-20
   id: 271234

2. 지방공무원 여비 규정
   법령구분: 대통령령 / 소관부처: 행정안전부
   시행일자: 2027-01-01 / 공포일자: 2026-10-01
   id: 280001`;

  it('검색 결과에서 제목·id·시행일을 읽는다', () => {
    expect(parseLawSearch(searchText)).toEqual([
      { title: '공무원 여비 규정', id: '271234', effectiveDate: '2026-01-01', issuer: null },
      { title: '지방공무원 여비 규정', id: '280001', effectiveDate: '2027-01-01', issuer: null },
    ]);
    expect(parseLawSearch('"없음"에 해당하는 법령을(를) 찾지 못했습니다.')).toEqual([]);
    const ordin = parseLawSearch('1. 다라시 공무원 여비 조례\n   지자체: 다라시 / 종류: 조례\n   시행일자: 2025-03-01 / 분야: 행정\n   id: 99');
    expect(ordin[0].issuer).toBe('다라시');
  });

  it('본문을 조문으로 자르고 핵심어가 맞는 조문만 고른다(안 맞으면 고르지 않음)', () => {
    const content = '공무원 여비 규정 (시행 2026-01-01)\n\n제1조(목적) 이 영은 여비 지급에 관하여 규정한다.\n\n제17조(숙박비) 숙박비는 상한액 범위에서 실비로 지급한다.\n  1. 상한을 넘으면 …\n\n제17조의2(숙박비의 예외) 출장지 사정으로 …';
    const { enforced, articles } = splitArticles(content);
    expect(enforced).toBe('2026-01-01');
    expect(articles.map((a) => a.heading)).toEqual(['제1조(목적)', '제17조(숙박비)', '제17조의2(숙박비의 예외)']);
    expect(pickArticles(articles, ['숙박비', '상한'], 2).map((a) => a.heading)).toEqual(['제17조(숙박비)', '제17조의2(숙박비의 예외)']);
    expect(pickArticles(articles, ['연가'], 2)).toEqual([]);
    expect(pickArticles(articles, [], 2)).toEqual([]);
  });
});

describe('근거 모으기·모델 출력', () => {
  const plan = { searchQuery: 'q', lawQueries: ['여비'], keywords: ['숙박비'] };
  const scope = { organizationId: 'o', organizationName: '가나시청', departmentId: 'd' };

  it('설정 안 된 제공자는 범위 안내로 넘기고, 실패한 제공자는 다시 시도할 오류로 던진다(근거 일부만으로 조용히 만들지 않음)', async () => {
    const ok: RegulationProviders = {
      orgDocuments: async () => ({ status: 'unavailable', reason: '키 없음' }),
      common: async () => ({ status: 'ok', items: [raw({ kind: 'common', editionYear: 2026 })] }),
      laws: async () => ({ status: 'ok', items: [raw({})] }),
    };
    const g = await gatherEvidence(ok, scope, plan, [{ id: 's1', name: '내부 지침.hwpx', text: '본문' }, { id: 's2', name: '빈.txt', text: '  ' }]);
    expect(g.raw.map((e) => e.kind)).toEqual(['common', 'law', 'upload']);
    expect(g.unavailable).toEqual(['기관 문서: 키 없음']);
    const broken: RegulationProviders = { ...ok, laws: async () => { throw new Error('timeout'); } };
    await expect(gatherEvidence(broken, scope, plan, [])).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    await expect(gatherEvidence(broken, scope, plan, [])).rejects.toBeInstanceOf(WorkError);
  });

  it('모델 출력의 없는 근거 번호는 버리고, 형식이 틀리면 다시 시도할 오류', () => {
    const d = parseDraft('설명 {"findings":[{"text":"a","evidence":["E1","E7"]},{"text":3}],"reservations":["b",{"text":"c"}]}', ['E1', 'E2']);
    expect(d).toEqual({ findings: [{ text: 'a', evidenceIds: ['E1'] }], reservations: [{ text: 'b' }, { text: 'c' }] });
    expect(() => parseDraft('그냥 글', ['E1'])).toThrow(WorkError);
    const p = parsePlan('{"searchQuery":"","lawQueries":["여비","a","b","c"],"keywords":[1,"숙박비"]}', { question: '원래 질문', scope: 's', basisDate: 'd', organizationName: null });
    expect(p).toEqual({ searchQuery: '원래 질문', lawQueries: ['여비', 'a', 'b'], keywords: ['숙박비'] });
  });

  it('시험 모드 모델은 쓸 수 있는 근거만 인용하고 시험 모드 표시를 남긴다', async () => {
    const evidence = numberEvidence([raw({}), raw({ effectiveDate: '2027-01-01' })], ctx);
    const r = await mockRegulationModel.review({ question: 'q', scope: 's', basisDate: '2026-10-27', organizationName: null, evidence }, { model: 'm' });
    expect(r.draft.findings.map((f) => f.evidenceIds)).toEqual([['E1']]);
    expect(r.draft.findings[0].text).toContain('[시험 모드]');
    expect(r.usage).toBeNull();
  });
});
