import { readFileSync } from 'fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * 일괄 실행 한 번 최대 줄 수(2026-11-10, 0084) — 기관 전체 관리자만, 1~100·비우면 기본, 바꾸면 보안 로그, 만들 때 서버가 본다(못 읽으면 닫힘).
 * 결과 엑셀의 보내기·접수 번호 열(0076·0080) — 보낸 줄이 있을 때만
 */
type Result = { data?: unknown; error?: { message: string } | null };
const state = vi.hoisted(() => ({ results: {} as Record<string, Result[]>, calls: [] as unknown[][], security: [] as unknown[][] }));
vi.mock('@/lib/filter', () => ({ logSecurityEvent: async (...args: unknown[]) => { state.security.push(args); } }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'update', 'eq']) q[m] = (...args: unknown[]) => { state.calls.push([table, m, ...args]); return q; };
      const next = () => Promise.resolve({ data: null, error: null, ...(state.results[table]?.shift() ?? {}) });
      q.maybeSingle = () => next();
      q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => next().then(resolve, reject);
      return q;
    },
  },
}));

import { batchLimitView, parseBatchLimit, readBatchLimit, setBatchLimit } from '@/lib/apps/batch-limit';
import { batchWorkbook } from '@/lib/apps/batches';

const actor = (whole: boolean) => ({ userId: 'adm', isAdmin: true, organizationId: 'org', departmentId: 'dept', visibleDepartmentIds: ['dept'], managedDepartmentIds: ['dept'], managesWholeOrganization: whole });
const admin = (whole = true) => ({ scope: actor(whole) as never, userId: 'adm', impersonating: false });
beforeEach(() => { state.results = {}; state.calls = []; state.security = []; });

describe('상한 값', () => {
  it('null(기본) 또는 1~100 정수', () => {
    expect(parseBatchLimit(null)).toEqual({ ok: true, value: null });
    expect(parseBatchLimit(20)).toEqual({ ok: true, value: 20 });
    for (const bad of [0, 101, 2.5, '20', undefined]) expect(parseBatchLimit(bad).ok).toBe(false);
  });
  it('보기 — 실제 상한·바꿀 수 있는지(기관 전체 관리자만)', () => {
    expect(batchLimitView(null, actor(true) as never)).toEqual({ maxRows: null, effective: 100, canChange: true });
    expect(batchLimitView(20, actor(false) as never)).toEqual({ maxRows: 20, effective: 20, canChange: false });
  });
  it('DB 값이 이상하면 기본(null), 읽기 오류는 던진다', async () => {
    state.results.organizations = [{ data: { app_batch_max_rows: 500 } }];
    expect(await readBatchLimit('org')).toBeNull();
    state.results.organizations = [{ error: { message: 'down' } }];
    await expect(readBatchLimit('org')).rejects.toThrow('down');
  });
});

describe('바꾸기', () => {
  it('기관 전체 관리자만', async () => {
    expect(await setBatchLimit(admin(false), 20, '비용 점검 중입니다')).toMatchObject({ ok: false, status: 403 });
    expect(state.calls).toHaveLength(0);
  });
  it('바뀌면 기관 칸을 고치고 보안 로그(전후 값·사유), 같은 값이면 아무것도 안 함', async () => {
    state.results.organizations = [{ data: { app_batch_max_rows: null } }, { data: null }];
    expect(await setBatchLimit(admin(), 20, '비용 점검 중입니다')).toEqual({ ok: true, data: { maxRows: 20, effective: 20, canChange: true } });
    expect(state.calls).toContainEqual(['organizations', 'update', { app_batch_max_rows: 20 }]);
    expect(state.security[0]).toEqual(['dept', 'adm', 'app_batch_limit_changed', expect.objectContaining({ before: null, after: 20, reason: '비용 점검 중입니다' }), 'high']);
    state.calls = []; state.security = [];
    state.results.organizations = [{ data: { app_batch_max_rows: 20 } }];
    await setBatchLimit(admin(), 20, '비용 점검 중입니다');
    expect(state.calls.some((c) => c[1] === 'update')).toBe(false);
    expect(state.security).toHaveLength(0);
  });
  it('읽기·고치기 실패는 503', async () => {
    state.results.organizations = [{ error: { message: 'x' } }];
    expect(await setBatchLimit(admin(), 20, '비용 점검 중입니다')).toMatchObject({ ok: false, status: 503 });
    state.results.organizations = [{ data: { app_batch_max_rows: null } }, { error: { message: 'x' } }];
    expect(await setBatchLimit(admin(), 20, '비용 점검 중입니다')).toMatchObject({ ok: false, status: 503 });
  });
});

describe('결과 엑셀의 보내기 열', () => {
  const ExcelJS = async () => (await import('exceljs')).default;
  const read = async (buf: Buffer) => { const wb = new (await ExcelJS()).Workbook(); await wb.xlsx.load(buf); return wb.getWorksheet('결과')!; };
  const item = (position: number, delivery: unknown) => ({ position, status: 'done' as const, error: null, conversationId: null, inputs: { topic: 'x' }, result: '결과', delivery: delivery as never });
  it('보낸 줄이 있으면 보내기·접수 번호 열(접수 번호는 수식 주입 막음)', async () => {
    const sheet = await read(await batchWorkbook({ name: '묶음', origin: 'https://x', fields: [{ key: 'topic', label: '주제' }], items: [item(1, { status: 'sent', receiptRef: '=HYPERLINK(1)' }), item(2, null)] }));
    expect(sheet.getRow(1).values).toEqual([undefined, '번호', '주제', '상태', '결과', '오류', '대화', '보내기', '접수 번호']);
    expect(sheet.getRow(2).getCell(7).value).toBe('보냄');
    expect(sheet.getRow(2).getCell(8).value).toBe("'=HYPERLINK(1)");
    expect(sheet.getRow(3).getCell(7).value ?? '').toBe('');
  });
  it('보낸 줄이 없으면 열이 없다(옛 꼴)', async () => {
    const sheet = await read(await batchWorkbook({ name: '묶음', origin: 'https://x', fields: [{ key: 'topic', label: '주제' }], items: [item(1, null)] }));
    expect(sheet.getRow(1).values).toEqual([undefined, '번호', '주제', '상태', '결과', '오류', '대화']);
  });
});

describe('연결', () => {
  it('만들 때 기관 상한을 보고(못 읽으면 닫힘), 관리 화면·감사 이름·엑셀 라우트가 잇는다', () => {
    const lib = readFileSync('src/lib/apps/batches.ts', 'utf8');
    expect(lib).toContain('try { orgLimit = await readBatchLimit(actor.organizationId); } catch { return { ok: false, status: 503');
    expect(lib).toContain('if (orgLimit !== null && inputs.length > orgLimit)');
    expect(lib).toContain(".eq('user_id', userId).in('message_id', rows.map((r) => r.message_id))");
    expect(readFileSync('src/app/api/apps/batches/[id]/export/route.ts', 'utf8')).toContain('loadBatchDeliveries(session.user.id, params.id)');
    expect(readFileSync('src/app/api/admin/app-automations/batch-limit/route.ts', 'utf8')).toContain('isAdminSession(session)');
    expect(readFileSync('src/lib/apps/automation-admin.ts', 'utf8')).toContain('batchLimit: await batchLimitPromise');
    expect(readFileSync('src/app/api/admin/audit-logs/route.ts', 'utf8')).toContain("app_batch_limit_changed: '앱 일괄 실행 상한 바꾸기(관리자)'");
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('0084 (시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('다시 적용해도 안전, 1~100만', async () => {
    const sql = readFileSync('supabase/migrations/0084_app_batch_max_rows.sql', 'utf8');
    await db.query(sql);
    await db.query(sql);
    await db.query('BEGIN');
    try {
      const org = (await db.query("INSERT INTO organizations (name, app_batch_max_rows) VALUES ('상한 시험', 20) RETURNING id")).rows[0].id;
      await expect(db.query('UPDATE organizations SET app_batch_max_rows = 0 WHERE id = $1', [org])).rejects.toMatchObject({ code: '23514' });
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
