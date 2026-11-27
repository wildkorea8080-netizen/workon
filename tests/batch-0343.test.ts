// tests/batch-0343.test.ts
// 지방공기업 기본 앱 세트(2026-11-27) — 기관 유형이 '지방공기업'인 기관에만 입력형 앱 5개를 더 깐다.
// 설계 docs/superpowers/specs/2026-11-27-local-public-enterprise-presets-design.md
import { describe, expect, it } from 'vitest';
import { LOCAL_PUBLIC_ENTERPRISE_PRESETS, PRESET_CATEGORIES, PUBLIC_SECTOR_FORM_PRESETS, PUBLIC_SECTOR_PRESETS, presetsForOrganizationType } from '@/lib/agent-presets';
import { presetCapabilities } from '@/lib/install-presets';
import { appLookupConnectors, renderAppInput, validateAppDefinition } from '@/lib/apps/definition';

const NAMES = ['경영평가 실적 문안', '계약 방법 검토', '위험성평가·안전점검 정리', '시설 이용 민원 답변', '이사회 안건 작성'];

describe('지방공기업 기본 앱 세트', () => {
  it('다섯 개·범주 지방공기업·이름은 다른 기본 비서·앱과 겹치지 않음', () => {
    expect(LOCAL_PUBLIC_ENTERPRISE_PRESETS.map((p) => p.name)).toEqual(NAMES);
    expect(LOCAL_PUBLIC_ENTERPRISE_PRESETS.every((p) => p.category === '지방공기업')).toBe(true);
    expect(PRESET_CATEGORIES).toContain('지방공기업');
    const all = [...PUBLIC_SECTOR_PRESETS, ...PUBLIC_SECTOR_FORM_PRESETS, ...LOCAL_PUBLIC_ENTERPRISE_PRESETS].map((p) => p.name);
    expect(new Set(all).size).toBe(all.length);
  });

  it('정의는 저장 검사를 그대로 통과하고, 필수만 채워도 실행 글이 만들어진다', () => {
    for (const preset of LOCAL_PUBLIC_ENTERPRISE_PRESETS) {
      expect(validateAppDefinition(preset.appDefinition), preset.name).toEqual({ ok: true, value: preset.appDefinition });
      const def = preset.appDefinition!;
      const inputs = Object.fromEntries(def.fields.filter((f) => f.required).map((f) => [f.key, f.type === 'select' ? f.options![0] : f.type === 'number' ? '1000' : '가상 입력\n둘째 줄']));
      expect(renderAppInput(def, inputs).ok, preset.name).toBe(true);
    }
  });

  it('계약 방법 검토만 법령 조회 단계를 쓰고 커넥터 law를 켠다 — 나머지는 입력만 쓰는 앱', () => {
    for (const preset of LOCAL_PUBLIC_ENTERPRISE_PRESETS) {
      if (preset.name === '계약 방법 검토') {
        expect(preset.connectors).toEqual(['law']);
        expect(appLookupConnectors(preset.appDefinition!)).toContain('law');
      } else {
        expect(preset.connectors, preset.name).toBeUndefined();
        expect(presetCapabilities(preset), preset.name).toEqual({});
      }
    }
  });

  it('지방공기업 기관에만 더해진다', () => {
    const base = presetsForOrganizationType('공공기관').length;
    expect(presetsForOrganizationType('지방공기업').map((p) => p.name)).toEqual(expect.arrayContaining(NAMES));
    expect(presetsForOrganizationType('지방공기업')).toHaveLength(base + 5);
    for (const type of [null, undefined, '공공기관', '지방자치단체', '협회단체']) {
      expect(presetsForOrganizationType(type).some((p) => NAMES.includes(p.name)), String(type)).toBe(false);
    }
  });
});
