import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_THEME_COLOR,
  DEFAULT_THEME_VARS,
  MIN_CONTRAST,
  THEME_PRESETS,
  contrastRatio,
  hexToChannels,
  normalizeHex,
  themeColorProblem,
  themeStyle,
  themeVars,
} from '@/lib/theme-color';

/** 기관 테마 색(0067, 2026-11-06) — 색 하나만 저장하고 나머지 색은 계산, 흰 단추 글이 읽히는 색만 */
const read = (p: string) => readFileSync(p, 'utf8');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('테마 색 계산', () => {
  it('색 꼴 — # 여섯 자리만, 소문자로', () => {
    expect(normalizeHex('#ABCDEF')).toBe('#abcdef');
    expect(normalizeHex(' 087f8c ')).toBe('#087f8c');
    expect(normalizeHex('#abc')).toBeNull();
    expect(normalizeHex('red')).toBeNull();
    expect(normalizeHex(null)).toBeNull();
    expect(normalizeHex('#08 7f8c')).toBeNull();
  });

  it('너무 밝은 색(흰 글 4.5:1 미만)은 거절, 진한 색은 받음', () => {
    expect(themeColorProblem('#ffff00')).toMatch(/너무 밝은 색/);
    expect(themeColorProblem('#22c55e')).toMatch(/너무 밝은 색/);
    expect(themeColorProblem('zz')).toMatch(/16진수 여섯 자리/);
    expect(themeColorProblem('#003087')).toBeNull();
    expect(themeColorProblem(DEFAULT_THEME_COLOR)).toBeNull();
  });

  it('고르기 쉬운 색은 모두 받을 수 있고 겹치지 않는다(첫째가 기본)', () => {
    expect(THEME_PRESETS[0].color).toBe(DEFAULT_THEME_COLOR);
    expect(new Set(THEME_PRESETS.map((p) => p.color)).size).toBe(THEME_PRESETS.length);
    for (const p of THEME_PRESETS) expect(themeColorProblem(p.color)).toBeNull();
  });

  it('비었거나 잘못됐거나 기본 색이면 손으로 고른 기본 청록 그대로', () => {
    expect(themeVars(null)).toBe(DEFAULT_THEME_VARS);
    expect(themeVars('#ffff00')).toBe(DEFAULT_THEME_VARS);
    expect(themeVars('nope')).toBe(DEFAULT_THEME_VARS);
    expect(themeVars('#087F8C')).toBe(DEFAULT_THEME_VARS);
  });

  it('기관 색 — 단추 흰 글·연한 바탕 위 글이 모두 4.5:1 이상, 누르기 색은 더 진함', () => {
    for (const { color } of THEME_PRESETS.slice(1)) {
      const v = themeVars(color);
      expect(v['--ws-accent']).toBe(color);
      expect(contrastRatio(v['--ws-accent'], '#ffffff')).toBeGreaterThanOrEqual(MIN_CONTRAST);
      expect(contrastRatio(v['--ws-accent-hover'], '#ffffff')).toBeGreaterThan(contrastRatio(color, '#ffffff'));
      expect(contrastRatio(v['--ws-accent-text'], v['--ws-accent-soft'])).toBeGreaterThanOrEqual(MIN_CONTRAST);
      expect(contrastRatio(v['--ws-accent-text'], '#ffffff')).toBeGreaterThanOrEqual(MIN_CONTRAST);
      for (const value of Object.values(v)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
    // 경계 근처 색(흰 글 4.5 남짓)도 연한 바탕 위 글은 어둡게 맞춘다
    const edge = themeVars('#b45309');
    expect(contrastRatio('#b45309', edge['--ws-accent-soft'])).toBeLessThan(MIN_CONTRAST);
    expect(contrastRatio(edge['--ws-accent-text'], edge['--ws-accent-soft'])).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });

  it('기본 청록도 대비를 지킨다', () => {
    const v = DEFAULT_THEME_VARS;
    expect(contrastRatio(v['--ws-accent'], '#ffffff')).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(contrastRatio(v['--ws-accent-text'], v['--ws-accent-soft'])).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });
});

describe('테마 색 연결', () => {
  it('CSS 변수는 RGB 세 숫자 — 기본 색이면 덮어쓰지 않음', () => {
    expect(hexToChannels('#087f8c')).toBe('8 127 140');
    expect(themeStyle(null)).toBeNull();
    expect(themeStyle(DEFAULT_THEME_COLOR)).toBeNull();
    const style = themeStyle('#003087')!;
    expect(style['--ws-accent']).toBe('0 48 135');
    for (const v of Object.values(style)) expect(v).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
  });

  it('Tailwind ws-* 색이 투명도를 받는 꼴이고 화면은 var() 꾸밈 대신 이 이름을 쓴다', () => {
    const tw = read('tailwind.config.ts');
    for (const name of Object.keys(DEFAULT_THEME_VARS)) {
      const key = name.replace('--ws-', '');
      expect(tw).toContain(`'rgb(var(${name}) / <alpha-value>)'`);
      expect(tw).toMatch(new RegExp(`'?${key}'?: 'rgb`));
    }
    const offenders = walk('src').filter((f) => /\.(tsx|ts)$/.test(f) && /\[var\(--ws-/.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('globals.css :root 기본값이 DEFAULT_THEME_VARS와 같다', () => {
    const css = read('src/app/globals.css');
    const root = [...css.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => m[1]).find((b) => b.includes('--ws-accent')) ?? '';
    for (const [name, value] of Object.entries(DEFAULT_THEME_VARS)) {
      expect(root).toContain(`${name}: ${hexToChannels(value)};`);
    }
  });

  it('화면 코드에 청록 색값을 직접 적지 않는다(CSS 변수로) — 기관 색이 일부만 바뀌지 않게', () => {
    const teal = /\[#(087f8c|066775|087581|16818c|467b82|e7f5f5|e3f3f4|d4ecee|e8f6f4|dcf0f3|d6ebec|9bc9ce|8ebfc4)\]/i;
    const offenders = walk('src').filter((f) => /\.(tsx|ts)$/.test(f) && teal.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('업무 틀이 기관 색을 CSS 변수로 덮어쓴다', () => {
    const shell = read('src/components/work/WorkShell.tsx');
    expect(shell).toContain('const { themeColor } = useBranding();');
    expect(shell).toContain('themeStyle(themeColor)');
  });

  it('브랜딩 응답 — 색이 맞을 때만 싣고, 칸이 없으면(마이그레이션 전) 옛 칸으로 다시 읽음', () => {
    const route = read('src/app/api/branding/route.ts');
    expect(route).toContain("select('name, slug, logo_url, ai_notice, theme_color')");
    expect(route).toMatch(/if \(orgError\) \{[\s\S]*select\('name, slug, logo_url, ai_notice'\)/);
    expect(route).toContain('themeColor: themeColorProblem(org?.theme_color) ? null : normalizeHex(org?.theme_color)');
    // 기관이 없는 응답도 같은 꼴(themeColor: null)
    expect(route.match(/themeColor: null/g)?.length).toBe(3);
  });

  it('기관 정보 저장 — 대비 검사·기본 색은 NULL로', () => {
    const route = read('src/app/api/admin/organization/route.ts');
    expect(route).toContain('const problem = themeColorProblem(raw);');
    expect(route).toContain('update.theme_color = hex === DEFAULT_THEME_COLOR ? null : hex;');
    expect(route).toMatch(/select\('id, name, slug, logo_url, ai_notice, theme_color, domain/);
    const ui = read('src/components/admin/OrganizationManager.tsx');
    expect(ui).toContain('theme_color: themeColor.trim() || null');
    expect(ui).toContain('resetBrandingCache();');
  });

  it('0067 — 꼴 CHECK, 추가만', () => {
    const sql = read('supabase/migrations/0067_org_theme_color.sql');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS theme_color text');
    expect(sql).toContain("CHECK (theme_color IS NULL OR theme_color ~ '^#[0-9a-f]{6}$')");
    expect(sql).not.toMatch(/DROP|DELETE|UPDATE organizations/i);
  });
});
