/**
 * 마지막으로 받은 기관 브랜딩을 이 브라우저에 기억(2026-11-06) — 화면을 새로 열 때마다 사이드바의 기관명·로고와
 * 테마 색(0067)이 기본값('AI 업무도우미'·청록)으로 잠깐 떴다가 바뀌던 것을 막는다.
 *
 * - **사람마다**: 그 사용자 id와 함께 둔다. 같은 PC를 다른 직원이 쓰면 맞지 않아 쓰지 않는다
 * - 기억은 표시용 첫 값일 뿐이다 — 서버 응답이 오면 언제나 그것으로 바꾼다
 * - 저장소에서 읽은 값은 믿지 않고 다시 본다(로고 주소는 우리 로고 라우트만, 색은 대비 검사를 지난 것만)
 * - 저장소를 못 쓰면 지금처럼 기본값으로 시작한다
 *
 * theme-color(잎 파일)만 가져온다
 */
import { normalizeHex, themeColorProblem } from './theme-color';

export const BRANDING_SNAPSHOT_KEY = 'workon:branding';

export interface BrandingSnapshot {
  name: string;
  logoUrl: string | null;
  slug: string | null;
  aiNotice: string;
  themeColor: string | null;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): Store | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

const LOGO_PATH = /^\/api\/branding\/logo\?org=[0-9a-f-]{36}$/i;

/** 저장소에서 온 값 → 쓸 수 있는 꼴만. 하나라도 이상하면 null */
export function cleanSnapshot(value: unknown): BrandingSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 200) return null;
  if (typeof v.aiNotice !== 'string' || v.aiNotice.length > 1000) return null;
  if (v.logoUrl !== null && !(typeof v.logoUrl === 'string' && LOGO_PATH.test(v.logoUrl))) return null;
  if (v.slug !== null && typeof v.slug !== 'string') return null;
  const themeColor = v.themeColor === null || themeColorProblem(v.themeColor) ? null : normalizeHex(v.themeColor);
  return { name: v.name, logoUrl: v.logoUrl as string | null, slug: (v.slug as string | null) ?? null, aiNotice: v.aiNotice, themeColor };
}

export function readBrandingSnapshot(userId: string, store: Store | null = storage()): BrandingSnapshot | null {
  if (!userId || !store) return null;
  try {
    const raw = store.getItem(BRANDING_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { userId?: unknown; data?: unknown };
    if (parsed?.userId !== userId) return null;
    return cleanSnapshot(parsed.data);
  } catch {
    return null;
  }
}

export function writeBrandingSnapshot(userId: string, data: BrandingSnapshot, store: Store | null = storage()): void {
  const clean = cleanSnapshot(data);
  if (!userId || !store || !clean) return;
  try {
    store.setItem(BRANDING_SNAPSHOT_KEY, JSON.stringify({ userId, data: clean }));
  } catch {
    // 기억하지 못해도 다음에 기본값으로 시작할 뿐
  }
}
