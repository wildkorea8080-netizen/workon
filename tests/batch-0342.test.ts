// tests/batch-0342.test.ts
// 관리자 포털 디자인을 직원 화면에 맞추기(2026-11-27) — 짙은 남색 사이드바·박힌 남색/파랑 대신
// 직원 화면(업무 틀)과 같은 밝은 사이드바·기관 테마 색(ws-*). 설계 docs/superpowers/specs/2026-11-27-admin-portal-redesign-design.md
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

describe('관리자 틀', () => {
  const layout = read('src/app/admin/layout.tsx');
  const side = read('src/components/admin/AdminSidebar.tsx');
  it('레이아웃 — 짙은 남색 사이드바 대신 AdminSidebar, 기관 테마 색을 바깥 틀에', () => {
    expect(layout).not.toMatch(/1C2B4A/i);
    expect(layout).toContain('<AdminSidebar');
    expect(layout).toContain('themeStyle(');
    expect(layout).toContain("select('name, logo_url, theme_color')");
    expect(layout).toContain('bg-[#F7F8FC]');
  });
  it('사이드바 — 직원 화면과 같은 고른 메뉴 색·접기 기억·작은 화면 탭·로고 없으면 첫 글자', () => {
    expect(side).toContain('hidden md:flex');
    expect(side).toContain('md:hidden');
    expect(side).toContain('bg-ws-accent-soft text-ws-accent-text');
    expect(side).toContain('readSidebarCollapsed');
    expect(side).toContain('writeSidebarCollapsed');
    expect(side).toContain('brandInitial');
    expect(side).toContain('aria-current');
    expect(side).toContain('aria-label={collapsed ? item.label');
    expect(side).toContain('대리 접근 중');
  });
  it('메뉴 목록은 한 곳(ADMIN_NAV)', () => {
    expect(read('src/components/admin/AdminNav.tsx')).toContain('export const ADMIN_NAV');
    expect(side).toContain('ADMIN_NAV');
  });
});

describe('안쪽 화면 강조색', () => {
  it('관리자 화면 파일에 박힌 남색·파랑·brand 색이 없다(기관 테마 색 ws-*를 쓴다)', () => {
    const bad: string[] = [];
    for (const f of [...files('src/app/admin'), ...files('src/components/admin')]) {
      const src = read(f);
      const m = src.match(/#003087|#002070|#1C2B4A|\b(?:[a-z-]+-)?(?:brand|blue)-\d{2,3}\b/gi);
      if (m) bad.push(`${f}: ${[...new Set(m)].join(', ')}`);
    }
    expect(bad).toEqual([]);
  });
});
