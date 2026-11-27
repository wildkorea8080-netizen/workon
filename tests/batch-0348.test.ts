// tests/batch-0348.test.ts
// 기관 문서 근거 기본 비서 둘(2026-11-27) — 규정 안내·업무 분장 안내. 문서 찾기를 켜고 깔며, 갱신해도 문서 찾기를 끄지 않는다
import { describe, expect, it } from 'vitest';
import { PUBLIC_SECTOR_PRESETS } from '@/lib/agent-presets';
import { mergePresetCapabilities, presetCapabilities } from '@/lib/install-presets';

describe('문서 근거 기본 비서', () => {
  const rule = PUBLIC_SECTOR_PRESETS.find((p) => p.name === '기관 규정 안내 비서')!;
  const duty = PUBLIC_SECTOR_PRESETS.find((p) => p.name === '업무 분장 안내 비서')!;
  it('둘 다 기본 비서 세트에 있고 문서 찾기를 켠다(사진 읽기도)', () => {
    expect(rule && duty).toBeTruthy();
    expect(presetCapabilities(rule)).toEqual({ image: {}, doc_search: {} });
    expect(presetCapabilities(duty)).toEqual({ image: {}, doc_search: {} });
  });
  it('갱신은 문서 찾기를 켜기만 하고, 다른 비서는 예전처럼', () => {
    expect(mergePresetCapabilities({}, rule)).toEqual({ image: {}, doc_search: {} });
    const plain = PUBLIC_SECTOR_PRESETS.find((p) => !p.docSearch && !p.connectors)!;
    expect(mergePresetCapabilities({ doc_search: {} }, plain)).toEqual({ doc_search: {}, image: {} });
    expect(presetCapabilities(plain)).toEqual({ image: {} });
  });
  it('지시문은 근거 조문·찾지 못함·개인 연락처 금지를 말한다', () => {
    expect(rule.systemPrompt).toContain('조·항·호');
    expect(rule.systemPrompt).toContain('찾지 못했다');
    expect(duty.systemPrompt).toContain('개인 휴대전화는 안내하지 않습니다');
  });
});

describe('대시보드 새 기본 비서·앱 띠', () => {
  it('대시보드에 띠가 있고, 아직 깔지 않은 것(missing)만 세며 없으면 그리지 않는다', async () => {
    const { readFileSync } = await import('fs');
    expect(readFileSync('src/app/admin/page.tsx', 'utf8')).toContain('<NewPresetsBanner />');
    const banner = readFileSync('src/components/admin/NewPresetsBanner.tsx', 'utf8');
    expect(banner).toContain("i.state === 'missing'");
    expect(banner).toContain('if (!missing || missing.length === 0) return null;');
    expect(banner).toContain('href="/admin/agents"');
  });
});
