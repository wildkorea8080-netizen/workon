import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';

/** 예약의 올린 파일(0073) — 사본 복사·실행 때 새 첨부·뺀 파일과 지운 예약의 사본 정리, 남의 첨부는 못 가져옴 */
type Result = { data?: unknown; error?: { message: string } | null; count?: number | null };
const state = vi.hoisted(() => ({
  results: {} as Record<string, Result[]>, calls: [] as unknown[][],
  copies: [] as [string, string][], copyFailAt: -1, removed: [] as string[][],
}));
vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => ({ user: { id: 'me', role: 'USER', departmentId: 'dept' } }) }));
vi.mock('@/lib/actor-scope', () => ({
  getActorScope: async () => ({ userId: 'me', isAdmin: false, organizationId: 'org', departmentId: 'dept', visibleDepartmentIds: ['dept'], managedDepartmentIds: [], managesWholeOrganization: false }),
}));
vi.mock('@/lib/logger', () => ({ logSystem: async () => undefined }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const method of ['select', 'insert', 'update', 'delete', 'eq', 'is', 'in', 'lte', 'or', 'order', 'limit']) {
        q[method] = (...args: unknown[]) => { state.calls.push([table, method, ...args]); return q; };
      }
      const next = () => Promise.resolve({ data: null, error: null, count: null, ...(state.results[table]?.shift() ?? {}) });
      q.maybeSingle = () => next();
      q.single = () => next();
      q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => next().then(resolve, reject);
      return q;
    },
    storage: {
      from: () => ({
        copy: async (from: string, to: string) => {
          if (state.copies.length === state.copyFailAt) return { error: { message: 'copy failed' } };
          state.copies.push([from, to]); return { error: null };
        },
        remove: async (paths: string[]) => { state.removed.push(paths); return { error: null }; },
      }),
    },
  },
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/apps/schedules/route';
import { DELETE, PUT } from '@/app/api/apps/schedules/[id]/route';
import { keptFiles, parseIdList, scheduleFilesOf, scheduleFilePath } from '@/lib/apps/schedule-file-spec';
import { attachScheduleFiles, copyAttachmentsForSchedule, type ScheduleFileIo } from '@/lib/apps/schedule-files';
import { executeSchedule, type AppScheduleRow } from '@/lib/apps/schedules';
import { scheduleView } from '@/lib/apps/schedule-spec';

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SCHEDULE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const F1 = '33333333-3333-4333-8333-333333333333';
const F2 = '44444444-4444-4444-8444-444444444444';
const file = (id: string, name = '자료.xlsx') => ({ id, name, size: 2048, path: scheduleFilePath('org', 'me', id, 'xlsx') });
const definition = (attachments: Record<string, unknown> | undefined = { required: true }) => ({ schemaVersion: 1, fields: [{ key: 'title', label: '제목', type: 'text', required: true }], output: 'paragraphs', ...(attachments ? { attachments } : {}) });
const agentRow = (attachments?: Record<string, unknown>) => ({
  id: AGENT, tier: 'department', department_id: 'dept', organization_id: 'org', visibility: 'organization', owner_id: 'me', created_by: 'me',
  is_active: true, is_published: true, deleted_at: null, approval_status: 'approved', version: 3, approval_version: null, name: '주간 보고 앱', app_definition: definition(attachments),
});
const scheduleRow = (patch: Record<string, unknown> = {}) => ({
  id: SCHEDULE, agent_id: AGENT, app_version: 3, inputs: { title: '주간 보고' }, frequency: 'daily', weekday: null, month_day: null, run_hour: 9, run_minute: 0,
  status: 'active', paused_reason: null, next_run_at: '2026-11-09T00:00:00.000Z', last_run_at: null, last_status: null, last_error: null, last_conversation_id: null,
  consecutive_failures: 0, run_count: 0, created_at: '2026-11-08T00:00:00.000Z', ...patch,
});
const valid = { agent_id: AGENT, app_version: 3, inputs: { title: '주간 보고' }, frequency: 'daily', hour: 9, minute: 0 };
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/apps/schedules', { method: 'POST', body: JSON.stringify(body) }));
const put = (body: unknown) => PUT(new NextRequest(`http://localhost/api/apps/schedules/${SCHEDULE}`, { method: 'PUT', body: JSON.stringify(body) }), { params: { id: SCHEDULE } });
const attachmentRows = [
  { id: A1, file_name: '자료.xlsx', size_bytes: 2048, storage_path: 'chat-uploads/org/me/a1.xlsx' },
  { id: A2, file_name: '명단.csv', size_bytes: 100, storage_path: 'chat-uploads/org/me/a2.csv' },
];
const insertOf = () => state.calls.find(c => c[0] === 'app_schedules' && c[1] === 'insert')?.[2] as Record<string, unknown> | undefined;
const updateOf = () => state.calls.find(c => c[0] === 'app_schedules' && c[1] === 'update')?.[2] as Record<string, unknown> | undefined;

beforeEach(() => { state.results = {}; state.calls = []; state.copies = []; state.copyFailAt = -1; state.removed = []; });

describe('예약 파일 꼴(순수)', () => {
  it('DB 칸은 꼴이 맞고 예약 경로 안의 원소만 — 화면 보기는 경로를 뗀다', () => {
    const ok = file(F1);
    expect(scheduleFilesOf([ok, { ...ok, path: 'chat-uploads/x' }, { ...ok, path: 'app-schedule-files/../x' }, { ...ok, id: 'x' }, null, 'a'])).toEqual([ok]);
    expect(scheduleFilesOf(null)).toEqual([]);
    const view = scheduleView({ ...scheduleRow(), files: [ok] } as never, '앱', Date.now());
    expect(view.files).toEqual([{ id: F1, name: '자료.xlsx', size: 2048 }]);
    expect(JSON.stringify(view)).not.toContain('app-schedule-files');
  });
  it('id 목록·남길 파일 — 없으면 모두 남김, 예약에 없는 id면 null', () => {
    expect(parseIdList(undefined)).toEqual([]);
    expect(parseIdList([A1.toUpperCase(), A1])).toEqual([A1]);
    expect(parseIdList(['x'])).toBeNull();
    expect(parseIdList([A1, A2, F1, F2])).toBeNull();
    const current = [file(F1), file(F2)];
    expect(keptFiles(current, undefined)).toEqual(current);
    expect(keptFiles(current, [F2])).toEqual([current[1]]);
    expect(keptFiles(current, [])).toEqual([]);
    expect(keptFiles(current, [A1])).toBeNull();
  });
});

describe('사본 복사(copyAttachmentsForSchedule)', () => {
  it('요청자의 읽힌 첨부만 예약 경로로 복사한다', async () => {
    state.results.chat_attachments = [{ data: attachmentRows }];
    const copied = await copyAttachmentsForSchedule({ userId: 'me', organizationId: 'org' }, [A1, A2]);
    expect(copied.ok).toBe(true);
    expect(state.calls).toContainEqual(['chat_attachments', 'eq', 'user_id', 'me']);
    expect(state.calls).toContainEqual(['chat_attachments', 'eq', 'status', 'ready']);
    expect(state.copies.map(c => c[0])).toEqual(['chat-uploads/org/me/a1.xlsx', 'chat-uploads/org/me/a2.csv']);
    for (const [, to] of state.copies) expect(to).toMatch(/^app-schedule-files\/org\/me\/[0-9a-f-]{36}\.(xlsx|csv)$/);
    if (copied.ok) expect(copied.files.map(f => f.name)).toEqual(['자료.xlsx', '명단.csv']);
  });
  it('남의 것·읽지 않은 것(조회에 안 나옴)은 400이고 복사하지 않는다 · 도중 실패면 만든 사본을 지운다', async () => {
    state.results.chat_attachments = [{ data: [attachmentRows[0]] }];
    expect(await copyAttachmentsForSchedule({ userId: 'me', organizationId: 'org' }, [A1, A2])).toMatchObject({ ok: false, status: 400 });
    expect(state.copies).toHaveLength(0);
    state.results.chat_attachments = [{ data: attachmentRows }]; state.copyFailAt = 1;
    expect(await copyAttachmentsForSchedule({ userId: 'me', organizationId: 'org' }, [A1, A2])).toMatchObject({ ok: false, status: 503 });
    expect(state.removed).toEqual([[state.copies[0][1]]]);
  });
});

describe('예약 API의 파일', () => {
  it('만들기 — 파일 필수 앱도 파일을 붙이면 예약되고 사본 목록을 저장한다. 저장이 실패하면 사본을 지운다', async () => {
    state.results.agents = [{ data: agentRow() }];
    state.results.chat_attachments = [{ data: [attachmentRows[0]] }];
    state.results.app_schedules = [{ count: 0 }, { data: scheduleRow({ files: [file(F1)] }) }];
    const res = await post({ ...valid, attachment_ids: [A1] });
    expect(res.status).toBe(201);
    expect((await res.json()).data.files).toEqual([{ id: F1, name: '자료.xlsx', size: 2048 }]);
    expect((insertOf()?.files as { path: string }[])[0].path).toBe(state.copies[0][1]);

    state.calls = []; state.copies = [];
    state.results.agents = [{ data: agentRow() }];
    state.results.chat_attachments = [{ data: [attachmentRows[0]] }];
    state.results.app_schedules = [{ count: 0 }, { error: { message: 'down' } }];
    expect((await post({ ...valid, attachment_ids: [A1] })).status).toBe(503);
    expect(state.removed).toEqual([[state.copies[0][1]]]);
  });
  it('만들기 거절 — 파일 입력이 없는 앱·파일과 문서 합쳐 3개 넘음·id 꼴 틀림, 복사하지 않는다', async () => {
    state.results.agents = [{ data: { ...agentRow(), app_definition: { schemaVersion: 1, fields: [{ key: 'title', label: '제목', type: 'text', required: true }], output: 'paragraphs' } } }];
    expect((await (await post({ ...valid, attachment_ids: [A1] })).json()).error.message).toBe('이 앱은 파일 입력을 받지 않습니다.');
    state.results.agents = [{ data: agentRow({ required: false, library: true }) }];
    expect((await post({ ...valid, attachment_ids: [A1, A2], document_ids: [F1, F2] })).status).toBe(400);
    expect((await post({ ...valid, attachment_ids: ['x'] })).status).toBe(400);
    expect(state.copies).toHaveLength(0);
    expect(insertOf()).toBeUndefined();
  });
  it('고치기 — file_ids로 남길 파일, attachment_ids로 더할 파일. 저장한 뒤 뺀 사본만 지운다 · 모르는 id는 400', async () => {
    const current = { id: SCHEDULE, agent_id: AGENT, status: 'active', paused_reason: null, consecutive_failures: 0, admin_paused_at: null, claimed_at: null, files: [file(F1), file(F2, '옛 명단.csv')] };
    state.results.app_schedules = [{ data: current }, { data: scheduleRow() }];
    state.results.agents = [{ data: agentRow() }];
    state.results.chat_attachments = [{ data: [attachmentRows[1]] }];
    expect((await put({ ...valid, file_ids: [F1], attachment_ids: [A2] })).status).toBe(200);
    const saved = updateOf()?.files as { id: string }[];
    expect(saved.map(f => f.id)).toEqual([F1, expect.any(String)]);
    expect(state.removed).toEqual([[file(F2).path]]);

    state.calls = []; state.removed = [];
    state.results.app_schedules = [{ data: current }];
    expect((await put({ ...valid, file_ids: [A1] })).status).toBe(400);
    expect(updateOf()).toBeUndefined();
    // file_ids를 보내지 않으면 모두 남긴다(옛 화면)
    state.results.app_schedules = [{ data: current }, { data: scheduleRow() }];
    state.results.agents = [{ data: agentRow() }];
    expect((await put(valid)).status).toBe(200);
    expect((updateOf()?.files as unknown[]).length).toBe(2);
    expect(state.removed).toEqual([]);
  });
  it('고치기가 그 사이 바뀌어 0행이면 새 사본을 지우고 옛 사본은 둔다', async () => {
    const current = { id: SCHEDULE, agent_id: AGENT, status: 'active', paused_reason: null, consecutive_failures: 0, admin_paused_at: null, claimed_at: null, files: [file(F1)] };
    state.results.app_schedules = [{ data: current }, { data: null }];
    state.results.agents = [{ data: agentRow() }];
    state.results.chat_attachments = [{ data: [attachmentRows[1]] }];
    expect((await put({ ...valid, file_ids: [], attachment_ids: [A2] })).status).toBe(409);
    expect(state.removed).toEqual([[state.copies[0][1]]]);
  });
  it('지우기 — 행을 지운 뒤 사본을 지운다', async () => {
    state.results.app_schedules = [{ data: [{ id: SCHEDULE, files: [file(F1)] }] }];
    const res = await DELETE(new NextRequest(`http://localhost/api/apps/schedules/${SCHEDULE}`, { method: 'DELETE' }), { params: { id: SCHEDULE } });
    expect(res.status).toBe(200);
    expect(state.removed).toEqual([[file(F1).path]]);
  });
});

describe('실행 때 새 첨부(attachScheduleFiles·executeSchedule)', () => {
  const ready = (id: string) => ({ ok: true as const, attachment: { id, user_id: 'me', conversation_id: null, file_name: 'x', size_bytes: 1, status: 'ready' as const, summary: null, error: null, created_at: '' } });
  const filesIo = (results: Awaited<ReturnType<ScheduleFileIo['attach']>>[]) => {
    const discarded: string[] = [];
    const io: ScheduleFileIo = { attach: async () => results.shift()!, discard: async (_u, id) => { discarded.push(id); } };
    return { io, discarded };
  };
  const actor = { userId: 'me', departmentId: 'dept', organizationId: 'org' };

  it('사본마다 새 첨부 — 하나라도 못 하면 만든 첨부를 묘비로 지우고 이유', async () => {
    let t = filesIo([ready('n1'), ready('n2')]);
    expect(await attachScheduleFiles(actor, [file(F1), file(F2)], t.io)).toEqual({ ok: true, ids: ['n1', 'n2'] });
    t = filesIo([ready('n1'), { ok: false, status: 404, message: '원본 파일이 더 남아 있지 않습니다.' }]);
    expect(await attachScheduleFiles(actor, [file(F1), file(F2, '명단.csv')], t.io)).toEqual({ ok: false, error: "예약에 저장한 파일 '명단.csv'을 불러오지 못했습니다." });
    expect(t.discarded).toEqual(['n1']);
    t = filesIo([{ ok: true, attachment: { ...ready('n1').attachment, status: 'failed', error: '암호가 걸린 파일' } }]);
    expect(await attachScheduleFiles(actor, [file(F1)], t.io)).toEqual({ ok: false, error: "예약에 저장한 파일 '자료.xlsx'을 읽지 못했습니다(암호가 걸린 파일)." });
    t = filesIo([{ ok: false, status: 429, message: '보내지 않은 첨부가 너무 많습니다.' }]);
    expect(await attachScheduleFiles(actor, [file(F1)], t.io)).toEqual({ ok: false, error: '보내지 않은 첨부가 너무 많습니다.' });
  });

  const row = (patch: Record<string, unknown> = {}) => ({ ...scheduleRow(), user_id: 'me', department_id: 'dept', organization_id: 'org', claimed_at: null, updated_at: '', files: [file(F1)], ...patch }) as unknown as AppScheduleRow;
  const runIo = (prepared: { ok: boolean; status?: number; message?: string }, attach = [ready('n1')]) => {
    const bodies: Record<string, unknown>[] = [];
    const f = filesIo(attach);
    const io = {
      loadUser: async () => ({ id: 'me', email: null, role: 'USER', department_id: 'dept', is_active: true, deleted_at: null }),
      prepare: async (_s: unknown, body: Record<string, unknown>) => { bodies.push(body); return (prepared.ok ? { ok: true, turn: {} } : { ok: false, status: prepared.status, message: prepared.message }) as never; },
      stream: async (_t: unknown, send: (e: { event: string; data: Record<string, unknown> }) => void) => { send({ event: 'meta', data: { conversation_id: 'c1' } }); send({ event: 'done', data: {} }); },
      retitle: async () => undefined,
      files: f.io,
    };
    return { io, bodies, discarded: f.discarded };
  };

  it('실행은 새 첨부를 attachment_ids로 붙인다 · 시작 전에 거절되면 그 첨부를 지운다 · 파일을 못 올리면 실행하지 않고 실패', async () => {
    let t = runIo({ ok: true });
    expect(await executeSchedule(row(), t.io as never)).toMatchObject({ kind: 'completed', conversationId: 'c1' });
    expect(t.bodies[0]).toMatchObject({ attachment_ids: ['n1'] });
    expect(t.discarded).toEqual([]);
    t = runIo({ ok: false, status: 429, message: '한도' });
    expect(await executeSchedule(row(), t.io as never)).toMatchObject({ kind: 'failed', error: '한도' });
    expect(t.discarded).toEqual(['n1']);
    t = runIo({ ok: true }, [{ ok: false, status: 404, message: 'x' } as never]);
    expect(await executeSchedule(row(), t.io as never)).toMatchObject({ kind: 'failed', error: expect.stringContaining('불러오지 못했습니다') });
    expect(t.bodies).toHaveLength(0);
    // 파일 없는 예약은 첨부를 싣지 않는다(지금과 같음)
    t = runIo({ ok: true });
    await executeSchedule(row({ files: [] }), t.io as never);
    expect(t.bodies[0]).not.toHaveProperty('attachment_ids');
  });
});

describe('연결 (원본)', () => {
  it('탈퇴가 지운 예약의 사본을 DB 뒤에 지우고, 실행 화면이 붙인 첨부를 예약 폼에 넘긴다', () => {
    const withdrawal = readFileSync('src/lib/user-withdrawal.ts', 'utf8');
    expect(withdrawal).toContain(".from('app_schedules').delete().eq('user_id', userId).select('files')");
    expect(withdrawal.indexOf('removeScheduleFileObjects(scheduleFiles')).toBeGreaterThan(withdrawal.indexOf('// ⑤'));
    expect(readFileSync('src/app/apps/run/page.tsx', 'utf8')).toContain('attachmentIds={files.readyIds}');
    const form = readFileSync('src/components/apps/AppScheduleForm.tsx', 'utf8');
    expect(form).toContain("...(editing ? { file_ids: keepIds } : {})");
    expect(form).not.toContain('예약 실행을 걸 수 없습니다');
  });
});
