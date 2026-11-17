import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSystem } from '@/lib/logger';
import { writeAuditRow } from '@/lib/audit-write';
import { EDITABLE_SETTING_KEYS, checkSettingValue } from '@/lib/system-settings-spec';

export const dynamic = 'force-dynamic';

/**
 * 시스템 설정(2026-11-17 고침) — 고칠 수 있는 열쇠만 읽고 쓴다(`system-settings-spec.ts`).
 * 예전엔 아무 열쇠나 저장했고(실행기 자리까지), 읽기 실패를 빈 목록으로 답해 화면이 기본값을 실제 값처럼 보였으며,
 * 점검 모드 말고는 누가 무엇을 바꿨는지 남지 않았다.
 */

export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: { message: '인증 필요' } }, { status: 401 });

  const { data, error } = await supabaseAdmin
    .from('system_settings').select('key, value, updated_at').in('key', EDITABLE_SETTING_KEYS).order('key');

  if (error) {
    console.warn('[super/settings GET]', error.code);
    return NextResponse.json({ ok: false, error: { message: '설정을 읽지 못했습니다. 잠시 뒤 다시 열어 주세요.' } }, { status: 503 });
  }
  return NextResponse.json({ ok: true, data: data ?? [] });
}

export async function PATCH(request: NextRequest) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: { message: '인증 필요' } }, { status: 401 });

  let body: { key?: unknown; value?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: { message: '요청 형식이 올바르지 않습니다.' } }, { status: 400 });
  }
  const checked = checkSettingValue(body?.key, body?.value);
  if (!checked.ok) return NextResponse.json({ ok: false, error: { message: checked.message, code: 'BAD_SETTING' } }, { status: 400 });
  const { key, value } = checked;

  const before = await supabaseAdmin.from('system_settings').select('value').eq('key', key).maybeSingle();
  if (before.error) {
    console.error('[super/settings PATCH] read', before.error.code);
    return NextResponse.json({ ok: false, error: { message: '설정을 읽지 못해 저장하지 않았습니다. 잠시 뒤 다시 시도해 주세요.' } }, { status: 503 });
  }

  const { data, error } = await supabaseAdmin
    .from('system_settings')
    .upsert({ key, value, updated_by: admin.sub, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    .select('key, value, updated_at').single();
  if (error) {
    console.error('[super/settings PATCH]', error.code);
    return NextResponse.json({ ok: false, error: { message: '설정을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' } }, { status: 500 });
  }

  // 누가 무엇을 바꿨는지 — 값은 공개 설정이라 그대로 남긴다(비밀값은 이 표에 두지 않는다)
  await writeAuditRow('super_admin_logs', {
    admin_user_id: admin.sub,
    action: 'system_setting_changed',
    target_type: 'system_setting',
    before_data: { key, value: before.data?.value ?? null },
    after_data: { key, value },
  }, 'system_setting_changed');

  if (key === 'maintenance_mode' && (before.data?.value ?? 'false') !== value) {
    await logSystem({ level: 'critical', category: 'admin',
      message: `점검 모드 ${value === 'true' ? '활성화' : '해제'}`,
      details: { changedBy: admin.sub } });
  }
  return NextResponse.json({ ok: true, data });
}
