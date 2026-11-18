import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-18 — 기관 업무 관리(`/api/admin/work-installations`·`work-templates`·`work-overview`, `src/lib/work/admin.ts`).
 * 업무 켜고 끄기와 기관 양식은 기관의 모든 직원에게 걸리는데 하위 부서 관리자도 바꿀 수 있었고,
 * 업무 현황은 하위 부서 관리자에게도 기관 전체의 수를 보였다.
 */

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));

import * as admin from '@/lib/work/admin';
import { createSupabaseWorkStore } from '@/lib/work/store/supabase';
import type { WorkContext } from '@/lib/work/context';
import type { WorkActor } from '@/lib/work/types';

const rootAdmin: WorkActor = { userId: 'a1', organizationId: 'org1', departmentId: 'd-root', isAdmin: true, managedDepartmentIds: ['d-root', 'd-sub'], managesWholeOrganization: true };
const subAdmin: WorkActor = { userId: 'a2', organizationId: 'org1', departmentId: 'd-sub', isAdmin: true, managedDepartmentIds: ['d-sub'], managesWholeOrganization: false };
/** 표시가 없는 요청자(옛 꼴) — 아닌 것으로 본다 */
const unmarkedAdmin: WorkActor = { userId: 'a3', organizationId: 'org1', departmentId: 'd-root', isAdmin: true, managedDepartmentIds: ['d-root'] };
const staff: WorkActor = { userId: 'u1', organizationId: 'org1', departmentId: 'd-sub', isAdmin: false, managedDepartmentIds: [] };

function fakeCtx() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const note = (name: string) => (...args: unknown[]) => { calls.push({ name, args }); };
  const store = {
    listOrgTemplatesAdmin: async (...args: unknown[]) => { note('listOrgTemplatesAdmin')(...args); return []; },
    listOrgAgentTemplates: async (...args: unknown[]) => { note('listOrgAgentTemplates')(...args); return [{ id: 't1', name: '다른 부서 양식', file_name: 'a.hwpx', storage_path: 'p', agent_name: '다른 부서 비서' }]; },
    listInstallations: async (...args: unknown[]) => { note('listInstallations')(...args); return []; },
    upsertInstallation: async (...args: unknown[]) => { note('upsertInstallation')(...args); },
    insertEvent: async (...args: unknown[]) => { note('insertEvent')(...args); },
    getTemplateVersion: async (...args: unknown[]) => { note('getTemplateVersion')(...args); return null; },
    updateTemplateVersion: async (...args: unknown[]) => { note('updateTemplateVersion')(...args); return null; },
    insertTemplateVersion: async (...args: unknown[]) => { note('insertTemplateVersion')(...args); return null; },
    workStats: async (...args: unknown[]) => { note('workStats')(...args); return [{ workflow_key: 'meeting', tasks: 2, completed: 1, needs_review: 0, failed_runs_30d: 0, top_error: null }]; },
  };
  const files = { put: async (...args: unknown[]) => { note('files.put')(...args); }, get: async () => null, remove: async () => undefined };
  const ctx = { store, files, now: () => new Date('2026-11-18T00:00:00Z'), log: async () => undefined } as unknown as WorkContext;
  return { ctx, calls, named: (name: string) => calls.filter((c) => c.name === name) };
}

describe('바꾸기는 기관 전체 관리자만', () => {
  const writes: Array<[string, (ctx: WorkContext, actor: WorkActor) => Promise<unknown>]> = [
    ['업무 켜고 끄기', (ctx, actor) => admin.setInstallation(ctx, actor, 'meeting', false)],
    ['기관 양식 등록', (ctx, actor) => admin.registerOrgTemplate(ctx, actor, { name: '양식', fileName: 'a.hwpx', bytes: Buffer.from('x') })],
    ['시험 생성', (ctx, actor) => admin.testOrgTemplate(ctx, actor, 'tv1')],
    ['한글 확인 기록', (ctx, actor) => admin.attestOrgTemplate(ctx, actor, 'tv1', '한글에서 열어 확인함')],
    ['사용 중지', (ctx, actor) => admin.retireOrgTemplate(ctx, actor, 'tv1')],
    ['대화 양식 가져오기', (ctx, actor) => admin.importAgentTemplate(ctx, actor, 't1')],
  ];

  for (const [label, run] of writes) {
    it(`${label} — 하위 부서 관리자·표시 없는 요청자·직원은 403, 저장소를 건드리지 않는다`, async () => {
      for (const actor of [subAdmin, unmarkedAdmin, staff]) {
        const { ctx, calls } = fakeCtx();
        await expect(run(ctx, actor)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
        expect(calls).toHaveLength(0);
      }
      const { ctx } = fakeCtx();
      await expect(run(ctx, subAdmin)).rejects.toMatchObject({ message: admin.WORK_WHOLE_ORG_ONLY });
    });
  }

  it('기관 전체 관리자는 업무를 끌 수 있다', async () => {
    const { ctx, named } = fakeCtx();
    await admin.setInstallation(ctx, rootAdmin, 'meeting', false);
    expect(named('upsertInstallation')).toHaveLength(1);
    expect(named('upsertInstallation')[0].args.slice(0, 2)).toEqual(['org1', 'meeting']);
    expect(named('insertEvent')).toHaveLength(1);
  });
});

describe('보기는 관리자 누구나 — 범위에 맞게', () => {
  it('업무 목록은 하위 부서 관리자도 본다', async () => {
    const { ctx } = fakeCtx();
    const list = await admin.listInstallations(ctx, subAdmin);
    expect(list.length).toBeGreaterThan(0);
    await expect(admin.listInstallations(ctx, staff)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('양식 목록 — 하위 부서 관리자에게는 canManage false, 대화 비서의 양식 목록(다른 부서 비서 이름)은 읽지도 않는다', async () => {
    const sub = fakeCtx();
    const forSub = await admin.listAdminTemplates(sub.ctx, subAdmin);
    expect(forSub.canManage).toBe(false);
    expect(forSub.chatTemplates).toEqual([]);
    expect(sub.named('listOrgAgentTemplates')).toHaveLength(0);

    const root = fakeCtx();
    const forRoot = await admin.listAdminTemplates(root.ctx, rootAdmin);
    expect(forRoot.canManage).toBe(true);
    expect(forRoot.chatTemplates).toHaveLength(1);
  });

  it('업무 현황 — 기관 전체 관리자는 기관 전체(null), 그 밖의 관리자는 관리 범위 부서로', async () => {
    const root = fakeCtx();
    await admin.workOverview(root.ctx, rootAdmin);
    expect(root.named('workStats')[0].args[0]).toBe('org1');
    expect(root.named('workStats')[0].args[2]).toBeNull();

    const sub = fakeCtx();
    const rows = await admin.workOverview(sub.ctx, subAdmin);
    expect(sub.named('workStats')[0].args[2]).toEqual(['d-sub']);
    expect(rows[0]).toMatchObject({ workflow_key: 'meeting', name: '회의·위원회 정리' });

    const unmarked = fakeCtx();
    await admin.workOverview(unmarked.ctx, unmarkedAdmin);
    expect(unmarked.named('workStats')[0].args[2]).toEqual(['d-root']);
  });
});

describe('저장소 — 현황을 부서로 좁히기', () => {
  type Op = [string, unknown[]];
  function fakeDb(tasks: unknown[], runs: unknown[]) {
    const calls: Array<{ table: string; ops: Op[] }> = [];
    const db = {
      from: (table: string) => {
        const call = { table, ops: [] as Op[] };
        calls.push(call);
        const b: Record<string, unknown> = {};
        for (const n of ['select', 'eq', 'in', 'gte', 'order', 'range']) b[n] = (...args: unknown[]) => { call.ops.push([n, args]); return b; };
        b.then = (res: (v: unknown) => unknown) => {
          const rows = table === 'work_tasks' ? tasks : runs;
          return Promise.resolve({ data: rows, error: null, count: rows.length }).then(res);
        };
        return b;
      },
    };
    return { db, calls };
  }

  it('Supabase 저장소 — 부서 목록이 있으면 작업을 그 부서로 좁히고, 실패 실행은 그 작업들의 것만 센다', async () => {
    const { db, calls } = fakeDb(
      [{ id: 't1', workflow_key: 'meeting', status: 'completed' }],
      [{ task_id: 't1', error: { code: 'MODEL' } }, { task_id: 't-other-dept', error: { code: 'MODEL' } }],
    );
    const store = createSupabaseWorkStore(db as never);
    const rows = await store.workStats('org1', '2026-10-19T00:00:00Z', ['d-sub']);
    expect(rows).toEqual([{ workflow_key: 'meeting', tasks: 1, completed: 1, needs_review: 0, failed_runs_30d: 1, top_error: 'MODEL' }]);
    const taskCall = calls.find((c) => c.table === 'work_tasks')!;
    expect(taskCall.ops.some(([n, a]) => n === 'in' && JSON.stringify(a) === JSON.stringify(['department_id', ['d-sub']]))).toBe(true);
  });

  it('Supabase 저장소 — 기관 전체(null)면 부서 조건이 없고, 빈 관리 범위면 읽지 않고 빈 목록', async () => {
    const whole = fakeDb([{ id: 't1', workflow_key: 'meeting', status: 'draft' }], []);
    await createSupabaseWorkStore(whole.db as never).workStats('org1', '2026-10-19T00:00:00Z', null);
    expect(whole.calls.find((c) => c.table === 'work_tasks')!.ops.some(([n]) => n === 'in')).toBe(false);

    const empty = fakeDb([], []);
    expect(await createSupabaseWorkStore(empty.db as never).workStats('org1', '2026-10-19T00:00:00Z', [])).toEqual([]);
    expect(empty.calls).toHaveLength(0);
  });

  it('Postgres 저장소 — 작업·실패 실행 세 곳 모두 같은 부서 조건을 건다', () => {
    const src = readFileSync('src/lib/work/store/pg.ts', 'utf8');
    const body = src.slice(src.indexOf('async workStats('), src.indexOf('async listTemplateVersions('));
    expect(body.match(/\$3::uuid\[\] IS NULL OR t2?\.department_id = ANY\(\$3::uuid\[\]\)/g)).toHaveLength(3);
    expect(body).toContain('[organizationId, sinceIso, departmentIds]');
  });
});

describe('원본 확인', () => {
  it('요청자를 만들 때 기관 전체 관리자 표시를 싣는다', () => {
    expect(readFileSync('src/lib/work/server.ts', 'utf8')).toContain('managesWholeOrganization: scope.managesWholeOrganization === true');
  });

  it('바꾸는 함수 여섯은 requireWholeOrgWorkAdmin, 보는 함수 셋은 requireWorkAdmin', () => {
    const src = readFileSync('src/lib/work/admin.ts', 'utf8');
    expect(src.match(/^  requireWholeOrgWorkAdmin\(actor\);$/gm)).toHaveLength(6);
    expect(src.match(/^  requireWorkAdmin\(actor\);$/gm)).toHaveLength(4); // 목록 둘·현황 + requireWholeOrgWorkAdmin 안
  });

  it('화면은 바꿀 수 없는 관리자에게 단추를 막고 안내를 보인다', () => {
    const ui = readFileSync('src/components/admin/WorkAdmin.tsx', 'utf8');
    expect(ui).toContain('setCanManage(t.data.canManage !== false);');
    expect(ui).toContain('disabled={busy || !canManage}');
    expect(ui).toContain("{t.status !== 'retired' && canManage && (");
  });
});
