// src/lib/organization-audit.ts
// 기관 정보 저장에서 **실제로 달라진 것**을 가른다(2026-11-18) — 아무것도 import하지 않는다.
//
// 기관 정보 화면은 저장할 때마다 모든 칸을 보낸다. 받은 값을 그대로 '바뀜'으로 보면 이름만 고쳐도 모델 정책 이력이 한 줄씩 쌓이고,
// 접속 허용 IP가 바뀌지 않았는데도 바뀐 것처럼 남는다. 접속 허용 IP는 기관 전체의 접속을 막는 보안 통제인데
// 바꾸거나 없애도 어디에도 남지 않았다(모델 정책은 `model_policy_logs`에 남았다).

const MAX_LOGGED_IPS = 50;

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** 두 목록이 같은 묶음인가 — 순서·겹침은 보지 않는다. null·빈 배열은 같다('정하지 않음') */
export function sameList(a: unknown, b: unknown): boolean {
  const x = new Set(list(a));
  const y = new Set(list(b));
  if (x.size !== y.size) return false;
  for (const v of x) if (!y.has(v)) return false;
  return true;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export interface OrganizationChanges {
  /** 접속 허용 IP가 달라졌으면 전후 목록(각 50개까지)과 개수 */
  ips: { from_ips: string[]; to_ips: string[]; from_ip_count: number; to_ip_count: number } | null;
  /** 기관명·로그인 경로·AI 고지 문구·테마 색·로고 중 달라진 것 */
  info: Record<string, unknown> | null;
}

/**
 * 고치기 전 행(`before`)과 저장할 값(`update` — 바꾸려는 칸만)을 맞대 달라진 것만 돌려준다.
 * 허용 모델은 여기서 보지 않는다(`model_policy_logs`에 따로 남긴다).
 */
export function organizationChanges(before: Record<string, unknown>, update: Record<string, unknown>): OrganizationChanges {
  let ips: OrganizationChanges['ips'] = null;
  if ('allowed_ips' in update && !sameList(before.allowed_ips, update.allowed_ips)) {
    const from = list(before.allowed_ips);
    const to = list(update.allowed_ips);
    ips = {
      from_ips: from.slice(0, MAX_LOGGED_IPS),
      to_ips: to.slice(0, MAX_LOGGED_IPS),
      from_ip_count: from.length,
      to_ip_count: to.length,
    };
  }

  const info: Record<string, unknown> = {};
  if ('name' in update && text(update.name) !== text(before.name)) {
    info.from_org_name = text(before.name);
    info.to_org_name = text(update.name);
  }
  if ('slug' in update && text(update.slug) !== text(before.slug)) {
    info.from_slug = text(before.slug);
    info.to_slug = text(update.slug);
  }
  // 글 원문(AI 고지 문구)·색 값·로고 경로는 싣지 않고 '바꿨다'만
  const changedFields: string[] = [];
  if ('ai_notice' in update && text(update.ai_notice) !== text(before.ai_notice)) changedFields.push('ai_notice');
  if ('theme_color' in update && text(update.theme_color) !== text(before.theme_color)) changedFields.push('theme_color');
  // 로고는 같은 경로에 덮어쓰므로 경로가 같아도 올렸으면 바뀐 것이다
  if ('logo_url' in update && (update.logo_url !== null || text(before.logo_url) !== null)) changedFields.push('logo');
  if (changedFields.length > 0) info.changed_fields = changedFields;

  return { ips, info: Object.keys(info).length > 0 ? info : null };
}
