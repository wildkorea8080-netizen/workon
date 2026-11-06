import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { normalizeHex, themeColorProblem } from '@/lib/theme-color';

/**
 * 기관 전용 로그인(/signin/{slug})의 테마 색(0067)을 서버에서 읽는다(2026-11-06) — 화면이 남색으로 떴다가
 * 브랜딩 응답 뒤 기관 색으로 바뀌지 않게 첫 그림부터 그 색으로 그린다.
 *
 * 브랜딩 응답과 같이 공개 정보(색 하나)만 돌려준다. 없는 기관·잘못된 경로·읽기 실패(칸이 없는 0067 전 포함)는 null = 기본 남색.
 * 경로 꼴이 로그인 경로 규칙(영문 소문자·숫자·하이픈 3~40자)이 아니면 DB를 부르지 않는다.
 */
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export async function themeColorForSlug(slug: string): Promise<string | null> {
  if (!SLUG.test(slug)) return null;
  try {
    const { data, error } = await supabaseAdmin.from('organizations').select('theme_color').eq('slug', slug).maybeSingle();
    if (error || !data) return null;
    return themeColorProblem(data.theme_color) ? null : normalizeHex(data.theme_color);
  } catch {
    return null;
  }
}
