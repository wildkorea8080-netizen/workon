/**
 * 기관 테마 색(0067, 2026-11-06) — 알리웍스처럼 관리자가 업무 화면의 강조 색을 고른다.
 * 공공기관은 CI 색이 정해져 있는 곳이 많다. 색 하나(`organizations.theme_color`)만 저장하고
 * 단추·글·연한 바탕·테두리 색은 여기서 만든다 — 화면마다 따로 고르게 하면 글이 읽히지 않는 조합이 생긴다.
 *
 * - 저장 꼴: `#rrggbb` 소문자. NULL = 기본 청록(지금 화면 그대로)
 * - 흰 글이 그 색 위에서 4.5:1 이상 읽혀야 받는다(WCAG AA 본문 글) — 단추 글이 흰색이기 때문
 * - 글 색은 연한 바탕 위에서도 4.5:1이 되도록 어둡게 맞춘다
 *
 * 아무것도 import하지 않는 잎 파일 — 화면(설정·업무 틀)과 서버(저장 검사·브랜딩 응답)가 함께 쓴다.
 */

export const DEFAULT_THEME_COLOR = '#087f8c';

/** 업무 틀이 쓰는 CSS 변수 — 여기서는 #색, CSS에는 RGB 세 숫자(`themeStyle`). 기본값은 globals.css `:root`와 같아야 한다(tests/theme-color.test.ts). */
export interface ThemeVars {
  '--ws-accent': string;
  '--ws-accent-hover': string;
  '--ws-accent-text': string;
  '--ws-accent-muted': string;
  '--ws-accent-soft': string;
  '--ws-accent-line': string;
  '--ws-accent-border': string;
}

/** 기본 청록 — 개편 디자인에서 손으로 고른 값 그대로(계산하지 않음) */
export const DEFAULT_THEME_VARS: ThemeVars = {
  '--ws-accent': '#087f8c',
  '--ws-accent-hover': '#066775',
  '--ws-accent-text': '#087581',
  '--ws-accent-muted': '#467b82',
  '--ws-accent-soft': '#e7f5f5',
  '--ws-accent-line': '#d6ebec',
  '--ws-accent-border': '#9bc9ce',
};

/** 고르기 쉬운 색 — 모두 흰 글 4.5:1 이상 */
export const THEME_PRESETS: { color: string; label: string }[] = [
  { color: '#087f8c', label: '청록(기본)' },
  { color: '#003087', label: '남색' },
  { color: '#1d4ed8', label: '파랑' },
  { color: '#1f7a4d', label: '초록' },
  { color: '#6d28d9', label: '보라' },
  { color: '#9d174d', label: '자주' },
  { color: '#b45309', label: '갈색' },
  { color: '#475569', label: '회색' },
];

export const MIN_CONTRAST = 4.5;

const HEX = /^#?([0-9a-fA-F]{6})$/;

/** `#ABCDEF`·`abcdef` → `#abcdef`. 꼴이 다르면 null(세 자리 줄임 꼴은 받지 않음) */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = HEX.exec(value.trim());
  return m ? `#${m[1].toLowerCase()}` : null;
}

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
}

/** a를 b 쪽으로 t만큼(0~1) 섞는다 */
function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return toHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as [number, number, number]);
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 두 색의 대비(1~21) */
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** 저장 전 검사 — 문제가 없으면 null, 있으면 한국어 이유 */
export function themeColorProblem(value: unknown): string | null {
  const hex = normalizeHex(value);
  if (!hex) return '색은 #과 16진수 여섯 자리로 적어 주세요(예: #087f8c).';
  if (contrastRatio(hex, '#ffffff') < MIN_CONTRAST) {
    return '너무 밝은 색이라 단추의 흰 글자가 잘 읽히지 않습니다. 더 진한 색을 골라 주세요.';
  }
  return null;
}

/** 저장된 색 → 업무 틀 CSS 변수. 비었거나 잘못된 값이면 기본 청록 */
export function themeVars(value: unknown): ThemeVars {
  const hex = normalizeHex(value);
  if (!hex || hex === DEFAULT_THEME_COLOR || themeColorProblem(hex)) return DEFAULT_THEME_VARS;
  const soft = mix(hex, '#ffffff', 0.9);
  // 연한 바탕 위의 글(선택된 메뉴 등)도 4.5:1이 되게 조금씩 어둡게
  let text = hex;
  for (let t = 0.05; contrastRatio(text, soft) < MIN_CONTRAST && t <= 0.6; t += 0.05) text = mix(hex, '#000000', t);
  return {
    '--ws-accent': hex,
    '--ws-accent-hover': mix(hex, '#000000', 0.2),
    '--ws-accent-text': text,
    '--ws-accent-muted': text,
    '--ws-accent-soft': soft,
    '--ws-accent-line': mix(hex, '#ffffff', 0.8),
    '--ws-accent-border': mix(hex, '#ffffff', 0.5),
  };
}

/** `#087f8c` → `8 127 140` — CSS 변수는 RGB 세 숫자로 둔다(Tailwind `ws-*` 색이 `/10` 같은 투명도를 붙이게) */
export function hexToChannels(hex: string): string {
  return rgb(hex).join(' ');
}

/** 업무 틀에 덮어쓸 CSS 변수(RGB 세 숫자). 기본 청록이면 null — globals.css `:root` 값을 그대로 쓴다 */
export function themeStyle(value: unknown): Record<keyof ThemeVars, string> | null {
  const vars = themeVars(value);
  if (vars === DEFAULT_THEME_VARS) return null;
  return Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, hexToChannels(v)])) as Record<keyof ThemeVars, string>;
}
