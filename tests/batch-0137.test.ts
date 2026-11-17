import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * 2026-11-17 — 슈퍼관리자 조작 기록(`super_admin_logs`)을 보이게. 예전엔 기관 등록·계정 삭제·비밀번호 재발급·잠금 풀기·설정 변경을
 * 이 표에 쓰기만 하고 **읽는 곳이 하나도 없었다**: 시스템 설정 '최근 슈퍼관리자 활동 이력'은 없는 주소(`/api/super/logs`)를 불러
 * 404 페이지를 받고 늘 "이력이 없습니다"였다. 계정 사용 중지·권한 변경·슈퍼관리자 추가·사용 중지는 기록조차 남지 않았다.
 * 로그 화면의 세 탭(접속·시스템·대리 접근)은 못 읽어도 빈 목록(ok)으로 꾸며 '기록 없음'과 구분되지 않았다.
 */

const state: { result: { data: unknown; count?: number; error: unknown }; calls: Array<[string, ...unknown[]]>; lookups: Record<string, unknown[]> } = {
  result: { data: [], count: 0, error: null },
  calls: [],
  lookups: {},
};

function builder(table: string) {
  const b: Record<string, unknown> = {};
  const chain = (name: string) => (...args: unknown[]) => { state.calls.push([`${table}.${name}`, ...args]); return b; };
  for (const n of ['select', 'order', 'range', 'eq']) b[n] = chain(n);
  b.in = (...args: unknown[]) => { state.calls.push([`${table}.in`, ...args]); return Promise.resolve({ data: state.lookups[table] ?? [], error: null }); };
  b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(state.result).then(ok, bad);
  return b;
}

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: { from: (t: string) => builder(t) } }));
vi.mock('@/lib/super-auth', () => ({ getSuperAdminFromRequest: (req: Request) => (req.headers.get('x-test-admin') ? { sub: 'admin-1' } : null) }));

import { ADMIN_LOG_ACTIONS, adminLogActionLabel, adminLogSummary, adminLogTargetLabel, isAdminLogAction } from '@/lib/super-admin-log-spec';
import { parseLogLink } from '@/lib/super-log-links';
import { GET } from '@/app/api/super/logs/admin/route';

const req = (q = '', admin = true) => new Request(`http://x/api/super/logs/admin${q}`, { headers: admin ? { 'x-test-admin': '1' } : {} }) as never;

beforeEach(() => {
  state.result = { data: [], count: 0, error: null };
  state.calls = [];
  state.lookups = {};
});

describe('기록 글로 옮기기', () => {
  it('종류·대상 이름 — 모르는 값은 그대로', () => {
    expect(adminLogActionLabel('user_deleted')).toBe('계정 삭제(탈퇴 처리)');
    expect(adminLogActionLabel('something_new')).toBe('something_new');
    expect(adminLogTargetLabel('organization')).toBe('기관');
    expect(adminLogTargetLabel(null)).toBe('—');
    expect(adminLogTargetLabel('weird')).toBe('weird');
  });
  it('거르기 값은 영문 소문자·밑줄만', () => {
    expect(isAdminLogAction('org_created')).toBe(true);
    for (const v of ['', 'DROP', "x' or 1=1", 'a,b', 'a'.repeat(41), null, undefined]) expect(isAdminLogAction(v)).toBe(false);
  });
  it('요약 — 설정 변경·공통 문서·IP·비밀번호 재발급', () => {
    expect(adminLogSummary('system_setting_changed', { key: 'maintenance_mode', value: 'false' }, { key: 'maintenance_mode', value: 'true' })).toBe('maintenance_mode: false → true');
    expect(adminLogSummary('system_setting_changed', null, { key: 'service_name', value: 'X' })).toBe('service_name: (없음) → X');
    expect(adminLogSummary('common_document_uploaded', null, { title: '예산편성기준', edition_year: 2026 })).toBe('예산편성기준(2026)');
    expect(adminLogSummary('sign_in_ip_unlocked', null, { ip: '203.0.113.x', cleared: 31 })).toBe('203.0.113.x · 실패 기록 31건 지움');
    expect(adminLogSummary('password_reset', null, { email_sent: false, sessions_kept: false })).toBe('메일 안 보냄 — 화면으로 전달');
  });
  it('요약 — 계정·기관 변경은 전 → 후', () => {
    expect(adminLogSummary('user_updated', { is_active: true }, { is_active: false })).toBe('사용 → 사용 중지');
    expect(adminLogSummary('user_updated', { role: 'USER' }, { role: 'ADMIN' })).toBe('권한 USER → ADMIN');
    expect(adminLogSummary('org_updated', { status: 'active', plan: 'basic' }, { status: 'suspended', updated_at: 'x' })).toBe('상태 active → suspended');
    expect(adminLogSummary('org_created', null, { name: '협회', plan: 'basic', adminEmail: 'a@b.kr' })).toBe('협회 · 요금제 basic');
    expect(adminLogSummary('user_deleted', { email: 'gone@x.kr', name: '홍' }, null)).toBe('gone@x.kr');
    expect(adminLogSummary('work_settings_changed', {}, { homeEnabled: true, newTasksEnabled: false })).toBe('업무 홈 켬 · 새 작업 끔');
    expect(adminLogSummary('sign_in_unlocked', null, null)).toBe('');
  });
  it('요약은 짧게 — 줄바꿈·제어 글자 없음, 160자', () => {
    const s = adminLogSummary('system_setting_changed', { key: 'maintenance_message', value: '첫줄\n둘째\u0007' }, { key: 'maintenance_message', value: 'x'.repeat(500) });
    expect(s).not.toMatch(/[\n\u0007]/);
    expect(s.length).toBeLessThanOrEqual(161);
    expect(adminLogSummary('org_created', null, { name: { nested: 'x'.repeat(300) } }).length).toBeLessThanOrEqual(161);
  });
  it('잎 파일 — 아무것도 import하지 않음', () => {
    expect(readFileSync('src/lib/super-admin-log-spec.ts', 'utf8')).not.toMatch(/^import /m);
  });
  it('src가 남기는 모든 종류에 화면 이름이 있다', () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) files.push(p); } };
    walk('src');
    const seen = new Set<string>();
    for (const f of files) {
      const s = readFileSync(f, 'utf8');
      if (!s.includes("'super_admin_logs'")) continue;
      for (const m of s.matchAll(/writeAuditRow\('super_admin_logs',\s*\{[\s\S]*?\n\s*\}(?:,\s*[^)]*)?\)/g)) {
        // action: 칸의 값(삼항이면 갈래 모두)만
        const act = m[0].match(/action:\s*([^\n]+)/);
        for (const a of (act?.[1] ?? '').matchAll(/'([a-z_]+)'/g)) if (!['suspended', 'terminated', 'cancelled'].includes(a[1])) seen.add(a[1]);
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(14);
    for (const a of seen) expect(ADMIN_LOG_ACTIONS[a], a).toBeTruthy();
  });
});

describe('GET /api/super/logs/admin', () => {
  it('슈퍼관리자가 아니면 401, 표를 부르지 않음', async () => {
    const res = await GET(req('', false));
    expect(res.status).toBe(401);
    expect(state.calls).toEqual([]);
  });
  it('못 읽으면 503 — 빈 목록으로 꾸미지 않고 원문도 싣지 않음', async () => {
    state.result = { data: null, error: { code: '42P01', message: 'relation "super_admin_logs" does not exist' } };
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/relation|42P01/);
  });
  it('최근 것부터·쪽 나누기·상한 100·거르기는 꼴이 맞을 때만', async () => {
    await GET(req('?page=3&limit=500&action=user_deleted'));
    expect(state.calls).toContainEqual(['super_admin_logs.order', 'created_at', { ascending: false }]);
    expect(state.calls).toContainEqual(['super_admin_logs.range', 200, 299]);
    expect(state.calls).toContainEqual(['super_admin_logs.eq', 'action', 'user_deleted']);
    state.calls = [];
    await GET(req("?action=x' or 1=1&page=abc&limit=-5"));
    expect(state.calls.some((c) => c[0] === 'super_admin_logs.eq')).toBe(false);
    expect(state.calls).toContainEqual(['super_admin_logs.range', 0, 0]);
  });
  it('한 줄 — 종류 이름·대상 이름(기관·계정)·요약·한 사람', async () => {
    state.result = {
      count: 3,
      error: null,
      data: [
        { id: '1', action: 'org_suspended', target_type: 'organization', target_id: '11111111-1111-1111-1111-111111111111', before_data: { status: 'active' }, after_data: { status: 'suspended' }, ip_address: null, created_at: '2026-11-17T08:00:00Z', users: { email: 'sa@x.kr', full_name: '운영자' } },
        { id: '2', action: 'user_updated', target_type: 'user', target_id: '22222222-2222-2222-2222-222222222222', before_data: { is_active: true }, after_data: { is_active: false }, ip_address: null, created_at: '2026-11-17T07:00:00Z', users: [{ email: 'sa@x.kr', full_name: null }] },
        { id: '3', action: 'sign_in_ip_unlocked', target_type: 'ip', target_id: null, before_data: null, after_data: { ip: '203.0.113.x', cleared: 30 }, ip_address: null, created_at: '2026-11-17T06:00:00Z', users: null },
      ],
    };
    state.lookups = {
      organizations: [{ id: '11111111-1111-1111-1111-111111111111', name: '협회' }],
      users: [{ id: '22222222-2222-2222-2222-222222222222', email: 'kim@x.kr', full_name: '김' }],
    };
    const body = await (await GET(req())).json();
    expect(body.meta).toEqual({ total: 3, page: 1, limit: 50 });
    expect(body.data[0]).toMatchObject({ actionLabel: '기관 정지', targetLabel: '기관', targetName: '협회', summary: '상태 active → suspended', adminEmail: 'sa@x.kr', adminName: '운영자' });
    expect(body.data[1]).toMatchObject({ actionLabel: '계정 사용·권한 변경', targetName: '김 (kim@x.kr)', summary: '사용 → 사용 중지', adminName: '—' });
    expect(body.data[2]).toMatchObject({ targetLabel: 'IP', targetName: null, adminEmail: '—', summary: '203.0.113.x · 실패 기록 30건 지움' });
    // jsonb 원문은 내보내지 않음
    expect(body.data[0]).not.toHaveProperty('before_data');
    expect(body.data[0]).not.toHaveProperty('after_data');
  });
  it('대상을 못 찾으면 id 앞부분', async () => {
    state.result = { count: 1, error: null, data: [{ id: '1', action: 'user_deleted', target_type: 'user', target_id: '33333333-3333-3333-3333-333333333333', before_data: null, after_data: null, ip_address: null, created_at: '2026-11-17T08:00:00Z', users: null }] };
    const body = await (await GET(req())).json();
    expect(body.data[0].targetName).toBe('33333333…');
  });
});

describe('화면·기록 잇기', () => {
  it('시스템 설정은 새 주소를 부르고 못 읽음을 보인다(옛 없는 주소 안 씀)', () => {
    const s = readFileSync('src/app/super/settings/page.tsx', 'utf8');
    expect(s).toContain("/api/super/logs/admin?limit=10");
    expect(s).not.toMatch(/['`]\/api\/super\/logs\?/);
    expect(s).toContain('조작 기록을 불러오지 못했습니다');
  });
  it("로그 화면 '관리자 조작' 탭 — 주소 ?tab=admin", () => {
    expect(parseLogLink('?tab=admin').tab).toBe('admin');
    const s = readFileSync('src/app/super/logs/page.tsx', 'utf8');
    expect(s).toContain("['admin','관리자 조작']");
    expect(s).toContain('/api/super/logs/admin?');
  });
  it('세 로그 API는 못 읽으면 빈 목록(ok)이 아니라 503', () => {
    for (const f of ['access', 'system', 'impersonation']) {
      const s = readFileSync(`src/app/api/super/logs/${f}/route.ts`, 'utf8');
      const tail = s.slice(s.lastIndexOf('catch'));
      expect(tail, f).toContain('status: 503');
      expect(tail, f).not.toContain('ok: true');
    }
    const page = readFileSync('src/app/super/logs/page.tsx', 'utf8');
    expect(page.match(/<LoadError message=\{loadError\} \/>/g)?.length).toBe(4);
  });
  it('계정 사용 중지·권한·슈퍼관리자 추가·사용 중지도 기록한다', () => {
    const u = readFileSync('src/app/api/super/accounts/users/[id]/route.ts', 'utf8');
    expect(u).toContain("action: 'user_updated'");
    const sa = readFileSync('src/app/api/super/accounts/super-admins/route.ts', 'utf8');
    expect(sa).toContain("action: 'super_admin_created'");
    // 임시 비밀번호는 기록에 싣지 않음
    expect(sa.slice(sa.indexOf("action: 'super_admin_created'"), sa.indexOf("'super_admin_created');"))).not.toMatch(/tempPassword|password/i);
    const sb = readFileSync('src/app/api/super/accounts/super-admins/[id]/route.ts', 'utf8');
    expect(sb).toContain("action: 'super_admin_updated'");
  });
});
