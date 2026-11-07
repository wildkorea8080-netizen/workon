import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { PRESET_CATEGORIES, PUBLIC_SECTOR_FORM_PRESETS, PUBLIC_SECTOR_PRESETS, presetsForOrganizationType } from '@/lib/agent-presets';
import { mergePresetCapabilities, presetCapabilities } from '@/lib/install-presets';
import { appLookupConnectors, renderAppInput, validateAppDefinition } from '@/lib/apps/definition';
import { isInputOnlyRun } from '@/lib/apps/resume';

/** 기본 입력형 앱(2026-11-07) — 기관을 만들 때(그리고 seed:agents로) 기본 비서와 함께 깔리는 입력형 앱 */

describe('기본 입력형 앱 정의', () => {
  it('여섯 개, 이름은 기본 비서와 겹치지 않고 범주는 업무 앱', () => {
    expect(PUBLIC_SECTOR_FORM_PRESETS.map((p) => p.name)).toEqual(['사업 위험 검토', '안내 메일 초안', '과업지시서 초안', '행사 안내문 초안', '질의별 답변 방향 정리', '법령 근거 조사']);
    const names = [...PUBLIC_SECTOR_PRESETS, ...PUBLIC_SECTOR_FORM_PRESETS].map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    expect(PUBLIC_SECTOR_FORM_PRESETS.every((p) => p.category === '업무 앱')).toBe(true);
    expect(PRESET_CATEGORIES).toContain('업무 앱');
  });

  it('정의는 저장 검사(validateAppDefinition)를 그대로 통과하고 꼴이 바뀌지 않는다', () => {
    for (const preset of PUBLIC_SECTOR_FORM_PRESETS) {
      const parsed = validateAppDefinition(preset.appDefinition);
      expect(parsed, preset.name).toEqual({ ok: true, value: preset.appDefinition });
    }
  });

  it('필수 항목만 채운 입력으로 실행 글이 만들어진다', () => {
    for (const preset of PUBLIC_SECTOR_FORM_PRESETS) {
      const def = preset.appDefinition!;
      const inputs = Object.fromEntries(def.fields.filter((f) => f.required).map((f) => [f.key, f.type === 'select' ? f.options![0] : '가상 입력\n둘째 줄']));
      expect(renderAppInput(def, inputs).ok, preset.name).toBe(true);
    }
  });

  it('질의별 답변 방향 정리는 질의 목록의 줄마다 반복한다', () => {
    const def = PUBLIC_SECTOR_FORM_PRESETS.find((p) => p.name === '질의별 답변 방향 정리')!.appDefinition!;
    expect(def.steps?.[0].repeat).toEqual({ field: 'questions' });
    expect(def.fields.find((f) => f.key === 'questions')?.type).toBe('textarea');
  });

  it('기관 유형과 상관없이 세트에 들어간다', () => {
    for (const type of [null, '공공기관', '지방자치단체']) expect(presetsForOrganizationType(type).filter((p) => p.appDefinition)).toHaveLength(6);
  });
});

describe('설치 행', () => {
  it('입력형 앱은 능력이 비어 이어 실행 대상이 된다(사진 읽기를 켜지 않음)', () => {
    for (const preset of PUBLIC_SECTOR_FORM_PRESETS.filter((p) => !p.connectors)) {
      expect(presetCapabilities(preset)).toEqual({});
      expect(isInputOnlyRun(Object.keys(presetCapabilities(preset)), 0)).toBe(true);
    }
    expect(presetCapabilities(PUBLIC_SECTOR_PRESETS[0])).toEqual({ image: {} });
  });

  it('--update에서도 입력형 앱에 사진 읽기를 더하지 않는다', () => {
    const app = PUBLIC_SECTOR_FORM_PRESETS[0];
    expect(mergePresetCapabilities({}, app)).toEqual({});
    expect(mergePresetCapabilities({ doc_search: {} }, app)).toEqual({ doc_search: {} });
  });

  it('설치·갱신 모두 app_definition을 싣는다', () => {
    const src = readFileSync('src/lib/install-presets.ts', 'utf8');
    // 설치 행(buildRow)·갱신 값(presetSettingsPatch — 스크립트 --update와 관리자 화면 갱신이 함께 씀)
    expect(src.match(/\.\.\.\(preset\.appDefinition \? \{ app_definition: preset\.appDefinition \} : \{\}\)/g)).toHaveLength(2);
    expect(src).toContain("saveAgentSettings(existing.id, existing.version, presetSettingsPatch(preset, existing.capabilities), null, 'preset_update')");
  });
});

describe('법령 근거 조사 — 조회 단계로 근거를 먼저 가져온다', () => {
  const law = PUBLIC_SECTOR_FORM_PRESETS.find((p) => p.name === '법령 근거 조사')!;
  it('법령 검색 → 법령 이름을 넣었을 때만 조문 본문 → 정리', () => {
    const steps = law.appDefinition!.steps!;
    expect(steps.map((s) => s.lookup?.tool ?? 'ai')).toEqual(['law_search', 'law_article', 'ai']);
    expect(steps[1].when).toEqual({ all: [{ field: 'law_name', op: 'filled' }] });
    expect(steps[1].lookup).toEqual({ tool: 'law_article', query: '{{law_name}}', article: '{{article}}' });
  });
  it('조회 단계가 쓰는 커넥터(law)만 공공 데이터 능력으로 켜고 사진 읽기는 없다 — 갱신에서도', () => {
    expect(presetCapabilities(law)).toEqual({ public_data: { connectors: ['law'] } });
    expect(mergePresetCapabilities({ doc_search: {} }, law)).toEqual({ doc_search: {}, public_data: { connectors: ['law'] } });
    expect(appLookupConnectors(law.appDefinition)).toEqual(['law']);
  });
});
