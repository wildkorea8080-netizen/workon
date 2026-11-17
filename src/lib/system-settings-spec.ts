/**
 * 슈퍼관리자 '시스템 설정'에서 고칠 수 있는 값(2026-11-17) — 아무것도 import하지 않는다(화면도 읽는다).
 *
 * 예전 화면은 0010이 넣은 열 개 값을 모두 고치게 했지만, 실제로 서비스가 읽는 것은 점검 모드 둘뿐이었다.
 * '로그인 실패 허용 횟수'·'허용 IP 목록'·'세션 유지 시간'·'최대 파일 크기'·'신규 기관 기본 플랜'은 바꿔도 아무 일도 없었는데
 * 화면은 그 값이 걸린 것처럼 보였다(로그인 잠금은 코드에 정한 계정 30분 5번·IP 30번, 슈퍼관리자 IP 제한은 없다).
 * 저장 API도 아무 열쇠나 받아 `noda_events_cursor`·`critical_log_alert` 같은 실행기 자리까지 덮어쓸 수 있었다.
 * 이제 아래 열쇠만 받고, 값 꼴을 보고, 바꿀 때마다 `super_admin_logs`에 전·후 값을 남긴다.
 */

export type SettingKind = 'bool' | 'text' | 'url' | 'email';

export interface SettingSpec {
  label: string;
  kind: SettingKind;
  /** 글자 수 상한 */
  max: number;
  /** 비워 둘 수 있는가 */
  optional: boolean;
  /** 서비스가 실제로 읽는가 — 거짓이면 화면에 '보관만'이라 밝힌다 */
  used: boolean;
}

export const EDITABLE_SETTINGS: Record<string, SettingSpec> = {
  maintenance_mode: { label: '점검 모드', kind: 'bool', max: 5, optional: false, used: true },
  maintenance_message: { label: '점검 안내 메시지', kind: 'text', max: 500, optional: false, used: true },
  service_name: { label: '서비스명', kind: 'text', max: 60, optional: true, used: false },
  service_url: { label: '서비스 URL', kind: 'url', max: 200, optional: true, used: false },
  support_email: { label: '고객지원 이메일', kind: 'email', max: 120, optional: true, used: false },
};

export const EDITABLE_SETTING_KEYS = Object.keys(EDITABLE_SETTINGS);

/** 기본 설정 탭 위의 안내 — 보관만 하는 값이라는 것을 밝힌다 */
export const STORED_SETTINGS_NOTICE =
  '아래 값은 보관만 합니다 — 지금은 서비스 화면·동작에 쓰지 않습니다. 화면의 서비스 이름·로고는 기관 브랜딩과 배포 설정(NEXT_PUBLIC_APP_NAME)을 씁니다.';

/** 보안 탭에 보이는 실제 규칙 — 코드에 정한 값이라 화면에서 바꾸지 않는다(`sign-in-throttle.ts`와 맞는지 시험이 본다) */
export const SIGN_IN_RULES = [
  '한 계정이 30분 안에 5번 틀리면 그 계정의 로그인을 30분 막습니다(직원·슈퍼관리자 같음).',
  '한 인터넷 주소(IP)에서 30분 안에 30번 틀리면 그 주소의 로그인을 30분 막습니다.',
  '계정 잠금은 기관 관리자 \'사용자 관리\'나 이 포털 \'계정 관리\'에서, IP 잠금은 \'계정 관리\' 위 \'IP 로그인 잠금\'에서 풉니다.',
  '슈퍼관리자 포털에 접속 IP 제한은 없습니다 — 기관마다 접속 허용 IP는 기관 관리자 \'기관 정보\'에서 정합니다.',
];

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export type SettingCheck = { ok: true; key: string; value: string } | { ok: false; message: string };

/** 저장할 열쇠·값을 검사한다. 글은 앞뒤 공백을 뗀다(점검 안내 메시지의 줄바꿈은 둔다) */
export function checkSettingValue(key: unknown, value: unknown): SettingCheck {
  if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(EDITABLE_SETTINGS, key)) {
    return { ok: false, message: '이 화면에서 바꿀 수 없는 설정입니다.' };
  }
  const spec = EDITABLE_SETTINGS[key];
  if (spec.kind === 'bool') {
    if (value === true || value === 'true') return { ok: true, key, value: 'true' };
    if (value === false || value === 'false') return { ok: true, key, value: 'false' };
    return { ok: false, message: `${spec.label}은(는) 켜기·끄기만 됩니다.` };
  }
  if (typeof value !== 'string') return { ok: false, message: `${spec.label} 값이 글이 아닙니다.` };
  const v = value.trim();
  if (!v) return spec.optional ? { ok: true, key, value: '' } : { ok: false, message: `${spec.label}을(를) 비울 수 없습니다.` };
  if (v.length > spec.max) return { ok: false, message: `${spec.label}은(는) ${spec.max}자까지입니다.` };
  if (CONTROL.test(v) || (spec.kind !== 'text' && /\s/.test(v))) return { ok: false, message: `${spec.label}에 쓸 수 없는 글자가 있습니다.` };
  if (spec.kind === 'url') {
    let ok = false;
    try { ok = /^https?:$/.test(new URL(v).protocol); } catch { ok = false; }
    if (!ok) return { ok: false, message: `${spec.label}은(는) http:// 또는 https://로 시작하는 주소여야 합니다.` };
  }
  if (spec.kind === 'email' && !/^[^@]+@[^@]+\.[^@]+$/.test(v)) return { ok: false, message: `${spec.label} 꼴이 아닙니다.` };
  return { ok: true, key, value: v };
}
