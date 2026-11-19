import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import {
  orgStatusChangeNotice,
  orgStatusLabel,
  orgSuspendConfirmText,
  requestOrgStatusChange,
} from '@/lib/org-status';

/**
 * 2026-11-19 — 슈퍼관리자 기관 화면의 상태 표시·정지 단추.
 * 예전: 화면은 'suspended'만 알아 '기관 종료'한 기관을 목록·상세에서 '활성'으로 보였고(상태 거르기에도 종료가 없었다),
 * 대시보드 '정지 N개'는 종료를 세지 않았다. 정지 단추 셋 중 둘(상세 위험 구역·사용량 초과 '서비스 정지')은 응답을 보지 않고
 * '기관이 정지됐습니다'를 띄우거나 아무 말 없이 목록만 다시 읽었고, 목록의 단추는 실패하면 말이 없었다. 정지 전에 묻지도 않았다.
 */

const src = (p: string) => readFileSync(p, 'utf8');

describe('orgStatusLabel', () => {
  it('네 상태와 모르는 값', () => {
    expect(['trial', 'active', 'suspended', 'terminated'].map(orgStatusLabel)).toEqual(['체험', '활성', '정지', '종료']);
    for (const v of [undefined, null, '', 'expired', '__proto__', 'constructor', 3]) expect(orgStatusLabel(v)).toBe('알 수 없음');
  });
});

describe('orgStatusChangeNotice', () => {
  it('성공 — 상태별 문구, 계약 경고가 있으면 그것', () => {
    expect(orgStatusChangeNotice('suspended', true, { ok: true })).toEqual({ ok: true, message: '기관이 정지됐습니다.' });
    expect(orgStatusChangeNotice('terminated', true, { ok: true })).toEqual({ ok: true, message: '기관이 종료됐습니다.' });
    expect(orgStatusChangeNotice('active', true, { ok: true })).toEqual({ ok: true, message: '기관이 활성화됐습니다.' });
    expect(orgStatusChangeNotice('suspended', true, { ok: true, warning: '계약을 해지하지 못했습니다.' }))
      .toEqual({ ok: true, message: '계약을 해지하지 못했습니다.' });
  });
  it('실패 — 서버 문구, 없으면 기본 안내(성공으로 보이지 않음)', () => {
    expect(orgStatusChangeNotice('suspended', false, { ok: false, error: '기관을 찾을 수 없습니다.' }))
      .toEqual({ ok: false, message: '기관을 찾을 수 없습니다.' });
    expect(orgStatusChangeNotice('suspended', false, { ok: false, error: { message: '안 됨' } }).message).toBe('안 됨');
    for (const [httpOk, body] of [[false, null], [true, null], [true, { ok: false }], [true, 'x'], [false, { ok: true }]] as const) {
      expect(orgStatusChangeNotice('suspended', httpOk, body))
        .toEqual({ ok: false, message: '기관 상태를 바꾸지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
    }
  });
});

describe('requestOrgStatusChange', () => {
  it('PATCH로 상태를 보내고 응답을 알림으로', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect(await requestOrgStatusChange('org/1', 'suspended', fetchImpl as never)).toEqual({ ok: true, message: '기관이 정지됐습니다.' });
    expect(fetchImpl).toHaveBeenCalledWith('/api/super/organizations/org%2F1', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ status: 'suspended' }),
    }));
  });
  it('연결이 끊기거나 몸이 깨져도 던지지 않고 실패로', async () => {
    const down = vi.fn(async () => { throw new TypeError('network'); });
    expect((await requestOrgStatusChange('o', 'suspended', down as never)).ok).toBe(false);
    const broken = vi.fn(async () => new Response('<html>', { status: 502 }));
    expect((await requestOrgStatusChange('o', 'active', broken as never)).ok).toBe(false);
  });
});

describe('원본 확인 — 화면', () => {
  it('정지 전에 묻는다', () => {
    expect(orgSuspendConfirmText('가 기관')).toContain("'가 기관' 기관을 정지할까요?");
  });
  it('목록 — 종료 표시·거르기, 단추는 응답을 본다', () => {
    const s = src('src/app/super/organizations/page.tsx');
    expect(s).toContain("org.status === 'terminated'");
    expect(s).toContain('<option value="terminated">종료</option>');
    expect(s).toContain('requestOrgStatusChange(org.id, status)');
    expect(s).not.toContain('const result = await res.json();');
    // 목록을 못 읽으면 '등록된 기관이 없습니다'가 아니라 그렇다고
    expect(s).toContain("'기관 목록을 불러오지 못했습니다.'");
    expect(s).toContain(') : loadError ? (');
  });
  it('상세 — 상태 이름, 위험 구역 단추도 같은 길', () => {
    const s = src('src/app/super/organizations/[id]/page.tsx');
    expect(s).toContain('orgStatusLabel(org.status)');
    expect(s).toContain('onClick={onSuspend}');
    expect(s).not.toMatch(/onToast\('기관이 정지됐습니다\.'\)/);
  });
  it("사용량 '서비스 정지'는 응답을 본다", () => {
    const s = src('src/app/super/usage/page.tsx');
    expect(s).toContain("requestOrgStatusChange(a.orgId, 'suspended')");
    expect(s).not.toMatch(/body: JSON\.stringify\(\{status:'suspended'\}\) \}\)\.then\(/);
  });
  it('대시보드 — 정지·종료를 함께 센다', () => {
    expect(src('src/app/api/super/dashboard/route.ts')).toContain(".in('status', [...STOPPED_ORG_STATUSES])");
    expect(src('src/app/super/page.tsx')).toContain('정지·종료 ${o.suspended ?? 0}개');
  });
});
