import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';

/** 기관 전용 로그인의 테마 색(2026-11-06) — 서버에서 먼저 읽어 첫 그림부터 그 색, 정하지 않은 기관·공용 /login은 남색 그대로 */
const calls: string[] = [];
let row: { theme_color: unknown } | null = null;
let fail = false;

vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: (cols: string) => ({
        eq: (col: string, value: string) => ({
          maybeSingle: async () => {
            calls.push(`${table}.${cols}.${col}=${value}`);
            if (fail) return { data: null, error: { code: '42703' } };
            return { data: row, error: null };
          },
        }),
      }),
    }),
  },
}));

import { themeColorForSlug } from '@/lib/org-theme';

const read = (p: string) => readFileSync(p, 'utf8');

beforeEach(() => {
  calls.length = 0;
  row = null;
  fail = false;
});

describe('기관 전용 로그인 테마 색', () => {
  it('맞는 색만 돌려주고, 없거나 밝거나 읽기 실패(0067 전)면 null', async () => {
    row = { theme_color: '#003087' };
    expect(await themeColorForSlug('my-agency')).toBe('#003087');
    expect(calls).toEqual(['organizations.theme_color.slug=my-agency']);
    row = { theme_color: '#ffff00' };
    expect(await themeColorForSlug('my-agency')).toBeNull();
    row = { theme_color: null };
    expect(await themeColorForSlug('my-agency')).toBeNull();
    row = null;
    expect(await themeColorForSlug('my-agency')).toBeNull();
    fail = true;
    expect(await themeColorForSlug('my-agency')).toBeNull();
  });

  it('로그인 경로 꼴이 아니면 DB를 부르지 않는다', async () => {
    for (const slug of ['', 'A-B', 'a', '-abc', 'abc-', "x' or 1=1", 'a'.repeat(41), '한글']) {
      expect(await themeColorForSlug(slug)).toBeNull();
    }
    expect(calls).toEqual([]);
  });

  it('화면 — 기관 경로에서만 기관 색, 서버 값이 먼저, 공용 /login은 남색', () => {
    const form = read('src/components/auth/LoginForm.tsx');
    expect(form).toContain('const theme = slug ? themeStyle(themeColor !== undefined ? themeColor : branding.themeColor) : null;');
    expect(form).toContain("bg: 'from-[#001a5c] via-[#003087] to-[#0066CC]'");
    expect(form).toContain('${c.button}');
    const page = read('src/app/signin/[slug]/page.tsx');
    expect(page).toContain('const themeColor = await themeColorForSlug(params.slug);');
    expect(page).toContain('<LoginForm slug={params.slug} themeColor={themeColor} />');
    expect(read('src/app/login/page.tsx')).not.toContain('themeColor');
  });
});
