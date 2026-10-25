import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  commonNodaFilename,
  commonTenant,
  isOrgType,
  ORG_TYPE_KEYS,
  ORG_TYPES,
  orgTypeFromCommonTenant,
  type OrgType,
} from '@/lib/org-types';

describe('org-types', () => {
  it('유형 → 공통 보관함', () => {
    expect(commonTenant('지방자치단체')).toBe('workon-c-local');
    expect(() => commonTenant('민간' as OrgType)).toThrow();
    expect(orgTypeFromCommonTenant('workon-c-assoc')).toBe('협회단체');
    expect(orgTypeFromCommonTenant('workon-c-x')).toBeNull();
    expect(orgTypeFromCommonTenant('workon-a11111111222243338444555555555555')).toBeNull();
  });

  it('유형 표 — 여섯 유형과 열쇠, 판별', () => {
    expect(ORG_TYPES).toEqual(['중앙행정기관', '지방자치단체', '공공기관', '교육기관', '협회단체', '일반기업']);
    expect(ORG_TYPES.map(t => ORG_TYPE_KEYS[t])).toEqual(['central', 'local', 'public', 'edu', 'assoc', 'company']);
    expect(isOrgType('공공기관')).toBe(true);
    expect(isOrgType('민간')).toBe(false);
    expect(isOrgType(undefined)).toBe(false);
    // 객체 기본 속성 이름으로 통과하지 않는다
    expect(isOrgType('constructor')).toBe(false);
    expect(orgTypeFromCommonTenant('workon-c-constructor')).toBeNull();
  });

  it('NODA 파일 이름 — 다듬은 이름(연도) + 원래 확장자 하나', () => {
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    expect(commonNodaFilename({ id, title: '예산편성기준', editionYear: 2026, fileName: '기준.PDF' })).toBe(`${id}__예산편성기준(2026).PDF`);
    expect(commonNodaFilename({ id, title: '지침/2:개정?', editionYear: 2025, fileName: 'a.hwpx' })).toBe(`${id}__지침2개정(2025).hwpx`);
    const long = commonNodaFilename({ id, title: '가'.repeat(200), editionYear: 2026, fileName: 'a.pdf' });
    expect(long).toBe(`${id}__${'가'.repeat(80)}(2026).pdf`);
    // Review Focus 3 — 이름 속 확장자·마침표는 그대로 글로 남고, 끝은 원래 확장자 하나
    expect(commonNodaFilename({ id, title: '예산편성기준.pdf 최종본', editionYear: 2026, fileName: 'x.docx' }))
      .toBe(`${id}__예산편성기준.pdf 최종본(2026).docx`);
    expect(commonNodaFilename({ id, title: '‮기준\u0007', editionYear: 2026, fileName: 'x.pdf' })).toBe(`${id}__기준(2026).pdf`);
  });

  it('NODA 파일 이름 — 빈 이름은 문서, 확장자 없으면 붙이지 않음', () => {
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const bs = String.fromCharCode(92);
    expect(commonNodaFilename({ id, title: `기${bs}준|"<>*`, editionYear: 2026, fileName: 'a.pdf' })).toBe(`${id}__기준(2026).pdf`);
    expect(commonNodaFilename({ id, title: ' /:? ', editionYear: 2026, fileName: 'a.pdf' })).toBe(`${id}__문서(2026).pdf`);
    expect(commonNodaFilename({ id, title: '기준', editionYear: 2026, fileName: 'README' })).toBe(`${id}__기준(2026)`);
    // 확장자는 마지막 마침표 뒤
    expect(commonNodaFilename({ id, title: '기준', editionYear: 2026, fileName: 'a.b.hwp' })).toBe(`${id}__기준(2026).hwp`);
  });

  it('organizations 화면이 같은 유형 목록을 쓴다', () => {
    expect(readFileSync('src/app/super/organizations/page.tsx', 'utf8')).toContain("from '@/lib/org-types'");
  });
});
