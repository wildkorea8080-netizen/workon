import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/logger', () => ({ logSystem: async () => {} }));

import { EDITABLE_SETTINGS, EDITABLE_SETTING_KEYS, SIGN_IN_RULES, STORED_SETTINGS_NOTICE, checkSettingValue } from '@/lib/system-settings-spec';
import { IP_FAILURES, LOCK_FAILURES, LOCK_WINDOW_MS } from '@/lib/sign-in-throttle';

/**
 * 2026-11-17 — 슈퍼관리자 '시스템 설정'을 사실대로. 예전엔 열 개 값을 고치게 했지만 서비스가 읽는 것은 점검 모드 둘뿐이었고
 * ('로그인 실패 허용 횟수'·'허용 IP 목록'은 아무것도 막지 않았다), 저장 API는 아무 열쇠나 받아 실행기 자리까지 덮어쓸 수 있었으며,
 * 점검 모드 말고는 바꾼 기록이 남지 않았다.
 */

describe('고칠 수 있는 열쇠·값 검사', () => {
  it('정해 둔 다섯 열쇠만 — 실행기 자리·쓰이지 않던 열쇠는 거절', () => {
    expect(EDITABLE_SETTING_KEYS.sort()).toEqual(['maintenance_message', 'maintenance_mode', 'service_name', 'service_url', 'support_email']);
    for (const k of ['noda_events_cursor', 'critical_log_alert', 'max_login_attempts', 'allowed_ips', 'session_timeout_hours', 'max_file_size_mb', 'new_org_default_plan', '__proto__', 'constructor', '', null, 5]) {
      expect(checkSettingValue(k, 'x').ok).toBe(false);
    }
  });
  it('서비스가 읽는 것은 점검 모드 둘뿐', () => {
    expect(EDITABLE_SETTING_KEYS.filter((k) => EDITABLE_SETTINGS[k].used).sort()).toEqual(['maintenance_message', 'maintenance_mode']);
  });
  it('점검 모드는 켜기·끄기만', () => {
    expect(checkSettingValue('maintenance_mode', 'true')).toEqual({ ok: true, key: 'maintenance_mode', value: 'true' });
    expect(checkSettingValue('maintenance_mode', false)).toEqual({ ok: true, key: 'maintenance_mode', value: 'false' });
    for (const v of ['yes', '1', 'TRUE', '', null]) expect(checkSettingValue('maintenance_mode', v).ok).toBe(false);
  });
  it('안내 메시지 — 비울 수 없고 500자까지, 줄바꿈은 둠, 제어 글자는 거절', () => {
    expect(checkSettingValue('maintenance_message', '  점검 중\n잠시 뒤  ')).toEqual({ ok: true, key: 'maintenance_message', value: '점검 중\n잠시 뒤' });
    expect(checkSettingValue('maintenance_message', '   ').ok).toBe(false);
    expect(checkSettingValue('maintenance_message', 'a'.repeat(501)).ok).toBe(false);
    expect(checkSettingValue('maintenance_message', '점검\u0000').ok).toBe(false);
    expect(checkSettingValue('maintenance_message', 5).ok).toBe(false);
  });
  it('주소·메일 꼴, 보관만 하는 값은 비울 수 있음', () => {
    expect(checkSettingValue('service_url', 'https://workon-ai.vercel.app').ok).toBe(true);
    for (const v of ['javascript:alert(1)', 'ftp://x.kr', 'workon.kr', 'https://a b.kr']) expect(checkSettingValue('service_url', v).ok).toBe(false);
    expect(checkSettingValue('support_email', 'help@workon.kr').ok).toBe(true);
    expect(checkSettingValue('support_email', 'help').ok).toBe(false);
    expect(checkSettingValue('support_email', '')).toEqual({ ok: true, key: 'support_email', value: '' });
    expect(checkSettingValue('service_name', 'x'.repeat(61)).ok).toBe(false);
  });
});

describe('보안 탭 안내가 실제 규칙과 같다', () => {
  it('계정 30분 5번·IP 30분 30번', () => {
    expect([LOCK_FAILURES, IP_FAILURES, LOCK_WINDOW_MS]).toEqual([5, 30, 30 * 60_000]);
    expect(SIGN_IN_RULES[0]).toContain('30분 안에 5번');
    expect(SIGN_IN_RULES[1]).toContain('30분 안에 30번');
    expect(SIGN_IN_RULES.join(' ')).toContain('접속 IP 제한은 없습니다');
    expect(STORED_SETTINGS_NOTICE).toContain('보관만');
  });
});

describe('라우트·화면(원본)', () => {
  const route = readFileSync('src/app/api/super/settings/route.ts', 'utf8');
  const page = readFileSync('src/app/super/settings/page.tsx', 'utf8');
  it('읽기는 고칠 수 있는 열쇠만, 못 읽으면 503(빈 목록으로 답하지 않음)', () => {
    expect(route).toContain(".in('key', EDITABLE_SETTING_KEYS)");
    expect(route).toContain('{ status: 503 }');
    expect(route).not.toContain("select('*')");
    expect(route).not.toContain('data: [] })');
  });
  it('저장은 검사를 거치고 바꿀 때마다 전·후 값을 감사 기록에, 오류 원문은 내보내지 않음', () => {
    expect(route).toContain('checkSettingValue(body?.key, body?.value)');
    expect(route).toContain("action: 'system_setting_changed'");
    expect(route).toContain('before_data: { key, value: before.data?.value ?? null }');
    expect(route).not.toContain('err.message');
    expect(route).not.toContain('error.message');
  });
  it('화면에 쓰이지 않던 칸·바깥 IP 조회가 없고, 못 읽으면 기본값 대신 안내', () => {
    for (const k of ['max_login_attempts', 'allowed_ips', 'session_timeout_hours', 'max_file_size_mb', 'new_org_default_plan', 'ipify']) {
      expect(page).not.toContain(k);
    }
    expect(page).toContain('{STORED_SETTINGS_NOTICE}');
    expect(page).toContain('SIGN_IN_RULES.map');
    expect(page).toContain(') : loadError ? (');
    // 저장이 성공했을 때만 알림·편집 닫기 — 예전엔 결과를 보기 전에 '활성화됐습니다'를 띄웠다
    expect(page).not.toContain("onToast('점검 모드가");
    expect(page).toContain('if (await onSave(settingKey, val)) setEditing(false);');
  });
});
