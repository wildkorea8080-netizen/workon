// tests/batch-0317.test.ts
// 과거 적용 기준일의 내린 옛 판(2026-11-26) — 업무 '규정·지침 확인'이 그날 시행 중이던 지난 판의 원본을 다시 읽어 근거를 더한다.
import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import {
  PAST_EDITION_DOCS, PAST_PASSAGE_MAX, pastEditionEvidence, pastEditionsInForce, pickPassages, queryTerms, splitPassages, type PastEditionDoc,
} from '@/lib/work/workflows/regulations/past-editions';
import { assessEvidence } from '@/lib/work/workflows/regulations/evidence';

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const doc = (n: number, over: Partial<PastEditionDoc> = {}): PastEditionDoc => ({
  id: id(n), title: `여비 규정 ${n}판`, file_name: `여비${n}.hwpx`, storage_path: `orig/${n}.hwpx`, noda_status: 'ready', replaces_id: null, effective_from: null, ...over,
});

// 1판(시행일 모름) → 2판(2025-01-01, 지난 판) → 3판(2026-01-01, 지금 판)
const chain = [
  doc(1, { noda_status: 'retired' }),
  doc(2, { noda_status: 'retired', replaces_id: id(1), effective_from: '2025-01-01' }),
  doc(3, { replaces_id: id(2), effective_from: '2026-01-01' }),
];

describe('그날 시행 중이던 지난 판 고르기', () => {
  it('판 사슬로 — 다음 판의 시행일이 그날 뒤인 지난 판만', () => {
    expect(pastEditionsInForce(chain, '2024-06-01').map((x) => [x.doc.id, x.until])).toEqual([[id(1), '2025-01-01']]);
    expect(pastEditionsInForce(chain, '2025-06-01').map((x) => [x.doc.id, x.until])).toEqual([[id(2), '2026-01-01']]);
    // 지금 판이 시행 중이면 지난 판은 고르지 않는다(NODA 찾기가 맡는다)
    expect(pastEditionsInForce(chain, '2026-03-01')).toEqual([]);
    // 시행일이 그날 뒤인 지난 판은 아니다
    expect(pastEditionsInForce(chain, '2024-06-01').some((x) => x.doc.id === id(2))).toBe(false);
  });
  it('다음 판의 시행일을 모르거나, 원본이 없거나, 지난 판이 아니면 고르지 않는다', () => {
    expect(pastEditionsInForce([doc(1, { noda_status: 'retired' }), doc(2, { replaces_id: id(1) })], '2024-01-01')).toEqual([]);
    expect(pastEditionsInForce([doc(1, { noda_status: 'retired', storage_path: null }), doc(2, { replaces_id: id(1), effective_from: '2025-01-01' })], '2024-01-01')).toEqual([]);
    expect(pastEditionsInForce([doc(1), doc(2, { replaces_id: id(1), effective_from: '2025-01-01' })], '2024-01-01')).toEqual([]);
    const many = Array.from({ length: 8 }, (_, i) => [doc(i + 1, { noda_status: 'retired' }), { ...doc(9), id: `10000000-0000-4000-8000-00000000000${i}`, replaces_id: id(i + 1), effective_from: '2030-01-01' }]).flat();
    expect(pastEditionsInForce(many, '2024-01-01')).toHaveLength(PAST_EDITION_DOCS);
  });
});

describe('낱말 맞추기', () => {
  it('질문 낱말 — 조사 떼기·2자 이상·한 번', () => {
    expect(queryTerms('출장 숙박비는 하루에 얼마까지 지급하나요? 숙박비')).toEqual(['출장', '숙박비', '하루', '얼마', '지급하나요']);
    expect(queryTerms('가 나')).toEqual([]);
  });
  it('문단 — 빈 줄로, 긴 문단은 1,500자 안에서', () => {
    expect(splitPassages('가\n\n나\n다\n\n')).toEqual(['가', '나\n다']);
    const long = Array.from({ length: 40 }, (_, i) => `${i}번째 줄 `.repeat(10)).join('\n');
    const parts = splitPassages(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= PAST_PASSAGE_MAX)).toBe(true);
  });
  it('낱말이 가장 많이 든 문단 — 셋 이상이면 둘 이상 맞아야, 원문 순서로', () => {
    const text = '제1조(목적) 이 규정은 여비 지급을 정한다.\n\n제5조(숙박비) 출장 숙박비는 하루 7만원으로 한다.\n\n제6조(식비) 하루 2만5천원.\n\n제9조(숙 박 비 정산) 숙박비 출장 증빙.';
    expect(pickPassages(text, ['출장', '숙박비', '하루'])).toEqual(['제5조(숙박비) 출장 숙박비는 하루 7만원으로 한다.', '제9조(숙 박 비 정산) 숙박비 출장 증빙.']);
    expect(pickPassages(text, ['연가', '병가', '출장'])).toEqual([]);
    expect(pickPassages(text, [])).toEqual([]);
  });
});

describe('pastEditionEvidence', () => {
  const text = '제5조(숙박비) 출장 숙박비는 하루 6만원으로 한다.\n\n제6조(식비) 하루 2만원.';
  it('그날 판의 원본을 읽어 근거로 — 위치에 지난 판·다음 판 시행일, 시행일은 그 판의 것', async () => {
    const read = vi.fn(async () => ({ ok: true as const, text }));
    const items = await pastEditionEvidence(chain, '2025-06-01', '출장 숙박비 하루 얼마', read);
    expect(read).toHaveBeenCalledWith('orig/2.hwpx', '여비2.hwpx');
    expect(items).toEqual([{
      kind: 'org_doc', documentId: id(2), title: '여비 규정 2판', location: '지난 판 · 2025-06-01에 시행 중이던 판(2026-01-01 새 판 시행 전까지) — 원문에서 찾음',
      effectiveDate: '2025-01-01', editionYear: null, issuer: null, text: '제5조(숙박비) 출장 숙박비는 하루 6만원으로 한다.', url: null,
    }]);
    // 적용 판정 — 기준일에 시행 중이던 판이라 '적용'
    expect(assessEvidence(items[0], { basisDate: '2025-06-01', organizationName: null }).applicability).toBe('applicable');
  });
  it('못 읽거나 던지면 건너뛴다, 고를 판이 없으면 읽지 않는다', async () => {
    expect(await pastEditionEvidence(chain, '2025-06-01', '출장 숙박비', async () => ({ ok: false as const }))).toEqual([]);
    expect(await pastEditionEvidence(chain, '2025-06-01', '출장 숙박비', async () => { throw new Error('x'); })).toEqual([]);
    const read = vi.fn(async () => ({ ok: true as const, text }));
    expect(await pastEditionEvidence(chain, '2026-03-01', '출장 숙박비', read)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('연결', () => {
  it('규정 확인의 기관 문서 근거 — 과거 기준일이면 지난 판 근거를 앞에, 새 판 찾기는 그대로', () => {
    const src = readFileSync('src/lib/work/workflows/regulations/providers.ts', 'utf8');
    expect(src).toContain("select('id, title, file_name, storage_path, noda_status, replaces_id, effective_from");
    expect(src).toContain('if (basis && basis < kstToday()) {');
    expect(src).toContain('pastEditionEvidence(docs, basis, query, readPastOriginal)');
    expect(src).toContain('const items: RawEvidence[] = [...past];');
    expect(src).toContain('const editionDay = editionDayFor(scope.basisDate);');
  });
});
