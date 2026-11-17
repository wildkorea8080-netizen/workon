import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { ipLockDeps, ipLockStatus, unlockIp } from '@/lib/sign-in-throttle';
import { maskIp, normalizeIp } from '@/lib/sign-in-lock-spec';
import { writeAuditRow } from '@/lib/audit-write';

export const dynamic = 'force-dynamic';

/**
 * IP 로그인 잠금 확인·풀기(2026-11-17, 슈퍼관리자).
 *
 * 한 IP가 30분에 30번 틀리면 그 IP의 로그인을 막는다(0091). 공공기관은 기관 전체가 바깥 IP 하나를 함께 쓰는 일이 많아 기관 전체가 30분 못 들어올 수 있는데,
 * 예전엔 풀 길이 없었다. IP는 해시로만 남아 목록은 보일 수 없고, 슈퍼관리자가 IP를 넣어 확인하고 푼다. 기록에는 가린 IP만 남긴다.
 */

const BAD_IP = 'IP 주소 꼴이 아닙니다(예: 203.0.113.5).';

export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request)) return NextResponse.json({ ok: false, error: { message: '인증 필요' } }, { status: 401 });
  const ip = normalizeIp(new URL(request.url).searchParams.get('ip'));
  if (!ip) return NextResponse.json({ ok: false, error: { message: BAD_IP } }, { status: 400 });
  try {
    const status = await ipLockStatus(ipLockDeps(), ip);
    return NextResponse.json({ ok: true, data: { ip: maskIp(ip), ...status } });
  } catch {
    return NextResponse.json({ ok: false, error: { message: '잠금 상태를 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.' } }, { status: 503 });
  }
}

export async function DELETE(request: NextRequest) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: { message: '인증 필요' } }, { status: 401 });
  const body = await request.json().catch(() => null) as { ip?: unknown } | null;
  const ip = normalizeIp(body?.ip);
  if (!ip) return NextResponse.json({ ok: false, error: { message: BAD_IP } }, { status: 400 });
  let cleared: number;
  try {
    cleared = await unlockIp(ipLockDeps(), ip);
  } catch {
    return NextResponse.json({ ok: false, error: { message: '잠금을 풀지 못했습니다. 잠시 뒤 다시 시도해 주세요.' } }, { status: 500 });
  }
  await writeAuditRow('super_admin_logs', {
    admin_user_id: admin.sub,
    action: 'sign_in_ip_unlocked',
    target_type: 'ip',
    target_id: null,
    after_data: { ip: maskIp(ip), cleared },
  }, 'sign_in_ip_unlocked');
  return NextResponse.json({ ok: true, data: { ip: maskIp(ip), cleared } });
}
