import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/** 월별 도입 현황 보고서(0056) — 달 계산·지표 줄·표기·CSV와 관리자 라우트(DB는 가짜) */

const state = vi.hoisted(() => ({ admin: true, managed: ['d1', 'd2'] as string[], rpc: [] as unknown[][], result: {} as Record<string, unknown>, error: null as null | { message: string } }));
vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => ({ user: { id: 'u1' } }), isAdminSession: () => state.admin }));
vi.mock('@/lib/actor-scope', () => ({ getActorScope: async () => ({ userId: 'u1', departmentId: 'd1', organizationId: 'o1', managedDepartmentIds: state.managed }) }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { rpc: async (name: string, args: Record<string, unknown>) => { state.rpc.push([name, args]); return { data: state.error ? null : state.result, error: state.error }; } },
}));

import {
  adoptionCsv, adoptionRows, currentMonth, formatAdoptionChange, formatAdoptionValue, monthRange, parseMonth, previousMonth,
  readAdoptionStats, recentMonths, type AdoptionStats,
} from '@/lib/adoption-report';
import { GET } from '@/app/api/admin/adoption-report/route';

const stats = (over: Partial<AdoptionStats> = {}): AdoptionStats => readAdoptionStats({
  registered_users: 40, active_users: 25, regular_users: 10, chat_messages: 600, conversations: 200, app_runs: 30, apps_used: 4,
  documents_generated: 12, cost_krw: 125000, tasks_created: 20, tasks_completed: 8, artifacts: 15, edit_versions: 6, revision_requests: 3, completed_versions: 12, ...over,
});

describe('달', () => {
  it('한국 시간 달의 시작·끝(UTC), 전월·이번 달·최근 달', () => {
    expect(monthRange('2026-11')).toEqual({ from: '2026-10-31T15:00:00.000Z', to: '2026-11-30T15:00:00.000Z' });
    expect(monthRange('2026-12')).toEqual({ from: '2026-11-30T15:00:00.000Z', to: '2026-12-31T15:00:00.000Z' });
    expect([previousMonth('2026-11'), previousMonth('2026-01')]).toEqual(['2026-10', '2025-12']);
    // 11월 30일 15:00Z = 12월 1일 00:00 KST
    expect(currentMonth(Date.parse('2026-11-30T14:59:59Z'))).toBe('2026-11');
    expect(currentMonth(Date.parse('2026-11-30T15:00:00Z'))).toBe('2026-12');
    expect(recentMonths(Date.parse('2026-02-10T00:00:00Z'), 4)).toEqual(['2026-02', '2026-01', '2025-12', '2025-11']);
    expect([parseMonth('2026-11'), parseMonth('2026-13'), parseMonth('26-11'), parseMonth(202611)]).toEqual(['2026-11', null, null, null]);
  });
});

describe('지표', () => {
  it('DB 결과는 숫자로만 읽는다(없거나 음수·글자는 0)', () => {
    expect(readAdoptionStats({ active_users: '7', cost_krw: -1, chat_messages: 'x' })).toMatchObject({ active_users: 7, cost_krw: 0, chat_messages: 0, registered_users: 0 });
    expect(readAdoptionStats(null).tasks_completed).toBe(0);
  });
  it('비율·평균은 분모가 0이면 —, 전월과 나란히', () => {
    const rows = adoptionRows(stats(), stats({ active_users: 20, tasks_completed: 0, completed_versions: 0, cost_krw: 100000 }));
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.adoption_rate).toMatchObject({ value: 25 / 40, previous: 20 / 40 });
    expect(by.versions_per_completed).toMatchObject({ value: 1.5, previous: null });
    expect(by.cost_per_active).toMatchObject({ value: 5000, previous: 5000 });
    expect(rows.every((r) => r.note.length > 0)).toBe(true);
    expect(new Set(rows.map((r) => r.group))).toEqual(new Set(['채택', '사용', '업무 작업', '자기 신고', '비용']));
    // 추정 시간·생산성 같은 줄은 없다
    expect(JSON.stringify(rows)).not.toMatch(/절약|시간 단축|생산성/);
  });
  it('표기 — 명·건·원·%·평균, 줄어든 것은 △(+·- 로 시작하지 않음)', () => {
    expect([formatAdoptionValue('people', 25), formatAdoptionValue('count', 1234), formatAdoptionValue('krw', 125000.4), formatAdoptionValue('percent', 0.625), formatAdoptionValue('average', 1.5), formatAdoptionValue('count', null)])
      .toEqual(['25명', '1,234건', '125,000원', '62.5%', '1.50', '—']);
    const change = (unit: 'count' | 'percent' | 'krw' | 'average', value: number | null, previous: number | null) => formatAdoptionChange({ key: 'k', group: '사용', label: 'l', unit, value, previous, note: 'n' });
    expect([change('count', 30, 20), change('count', 20, 30), change('count', 5, 5), change('krw', 1000, 2500), change('percent', 0.5, 0.625), change('average', 1.5, 1.25), change('count', null, 3)])
      .toEqual(['10', '△10', '0', '△1,500원', '△12.5%p', '0.25', '—']);
  });
  it('CSV — BOM, 달 머리, 읽는 법, 칸이 수식으로 시작하지 않음', () => {
    const csv = adoptionCsv('2026-11', '2026-10', adoptionRows(stats(), stats({ active_users: 30 })));
    expect(csv.startsWith('﻿구분,지표,2026-11,2026-10(전월),전월 대비,읽는 법')).toBe(true);
    expect(csv).toContain('채택,AI를 쓴 직원,25명,30명,△5,');
    for (const line of csv.split('\n').slice(1)) for (const cell of line.split(',')) expect(cell).not.toMatch(/^[=+\-@]/);
  });
});

const get = (q = '') => GET(new NextRequest(`http://x/api/admin/adoption-report${q}`));

describe('라우트', () => {
  beforeEach(() => { Object.assign(state, { admin: true, managed: ['d1', 'd2'], rpc: [], result: { active_users: 3, registered_users: 6 }, error: null }); });
  it('고른 달과 전월을 관리 범위·기관으로 DB 함수에 묻고 숫자 줄만 돌려준다', async () => {
    const res = await get('?month=2026-10');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(state.rpc).toEqual([
      ['adoption_report', { p_organization_id: 'o1', p_department_ids: ['d1', 'd2'], p_from: '2026-09-30T15:00:00.000Z', p_to: '2026-10-31T15:00:00.000Z' }],
      ['adoption_report', { p_organization_id: 'o1', p_department_ids: ['d1', 'd2'], p_from: '2026-08-31T15:00:00.000Z', p_to: '2026-09-30T15:00:00.000Z' }],
    ]);
    expect(body.data).toMatchObject({ month: '2026-10', previous: '2026-09', departments: 2, partial: false });
    expect(body.data.rows.find((r: { key: string }) => r.key === 'adoption_rate').value).toBe(0.5);
  });
  it('달을 비우면 이번 달(진행 중 표시), 꼴이 틀리거나 오지 않은 달은 400, 관리자 아니면 403, 집계 실패는 500', async () => {
    const now = await (await get()).json();
    expect(now.data).toMatchObject({ month: currentMonth(Date.now()), partial: true });
    expect((await get('?month=2026-13')).status).toBe(400);
    expect((await get('?month=2100-12')).status).toBe(400);
    state.admin = false;
    expect((await get()).status).toBe(403);
    state.admin = true; state.managed = [];
    expect((await get()).status).toBe(403);
    state.managed = ['d1']; state.error = { message: 'function adoption_report does not exist' };
    expect((await get('?month=2026-10')).status).toBe(500);
  });
  it('마이그레이션 — 실행 권한 service_role만, 범위는 부서 목록·기관, 1,000행 상한을 피해 DB에서 센다', () => {
    const sql = readFileSync('supabase/migrations/0056_adoption_report.sql', 'utf8');
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.adoption_report\(uuid, uuid\[\], timestamptz, timestamptz\) FROM PUBLIC, anon, authenticated/);
    expect(sql).toContain('TO service_role');
    expect(sql).toContain("AT TIME ZONE 'Asia/Seoul'");
    expect(sql).toContain('t.department_id = ANY(p_department_ids)');
    expect(sql).toContain('d.organization_id = p_organization_id');
    expect(readFileSync('src/app/admin/stats/page.tsx', 'utf8')).toContain('<AdoptionReport />');
  });
});
