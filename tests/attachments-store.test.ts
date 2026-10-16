// tests/attachments-store.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

/**
 * 첨부 저장소. supabaseAdmin은 메모리 표로 흉내 낸다 — 주인·대화·상태 조건이
 * 실제로 걸러 내는지를 봐야 하므로 호출 기록만으로는 부족하다.
 */

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = { chat_attachments: [], conversations: [] };
const objects = new Map<string, Buffer>();
const removed: string[][] = [];
const uploads: { path: string; opts: unknown }[] = [];
const state = {
  insertError: null as null | { message: string },
  signError: null as null | { message: string },
  removeError: null as null | { message: string },
  removeThrows: false,
  selectError: null as null | { message: string },
  uploadError: null as null | { message: string },
  infoSize: null as null | number,
  readThrows: false,
};

function matches(row: Row, filters: ((r: Row) => boolean)[]) {
  return filters.every((f) => f(row));
}

function query(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let op: 'select' | 'update' | 'delete' = 'select';
  let patch: Row = {};
  let returning = false;
  let headCount = false;
  let orderBy: { col: string; asc: boolean } | null = null;

  const run = () => {
    if (state.selectError && op === 'select') return { data: null, error: state.selectError, count: null };
    const rows = db[table] ?? (db[table] = []);
    const hit = rows.filter((r) => matches(r, filters));
    if (op === 'update') {
      for (const r of hit) Object.assign(r, patch);
    }
    if (op === 'delete') {
      db[table] = rows.filter((r) => !hit.includes(r));
    }
    let out = hit.map((r) => ({ ...r }));
    if (orderBy) {
      const { col, asc } = orderBy;
      out = out.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
    }
    if (headCount) return { data: null, error: null, count: hit.length };
    if (op !== 'select' && !returning) return { data: null, error: null };
    return { data: out, error: null, count: null };
  };

  const q: Record<string, unknown> = {
    select(_cols?: string, opts?: { count?: string; head?: boolean }) {
      if (op !== 'select') returning = true;
      if (opts?.head) headCount = true;
      return q;
    },
    update(p: Row) {
      op = 'update';
      patch = p;
      return q;
    },
    delete() {
      op = 'delete';
      return q;
    },
    eq(col: string, v: unknown) {
      filters.push((r) => r[col] === v);
      return q;
    },
    is(col: string, v: unknown) {
      filters.push((r) => (r[col] ?? null) === v);
      return q;
    },
    in(col: string, vs: unknown[]) {
      filters.push((r) => vs.includes(r[col]));
      return q;
    },
    lt(col: string, v: string) {
      filters.push((r) => String(r[col]) < v);
      return q;
    },
    order(col: string, opts?: { ascending?: boolean }) {
      orderBy = { col, asc: opts?.ascending !== false };
      return q;
    },
    maybeSingle() {
      const res = run() as { data: Row[] | null; error: unknown };
      return Promise.resolve({ data: res.data?.[0] ?? null, error: res.error });
    },
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(run()).then(resolve, reject);
    },
  };
  return q;
}

vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from(table: string) {
      return {
        ...query(table),
        insert(row: Row) {
          if (state.insertError) return Promise.resolve({ error: state.insertError });
          (db[table] ?? (db[table] = [])).push({ created_at: new Date().toISOString(), conversation_id: null, ...row });
          return Promise.resolve({ error: null });
        },
      };
    },
    storage: {
      from() {
        return {
          createSignedUploadUrl(path: string) {
            if (state.signError) return Promise.resolve({ data: null, error: state.signError });
            return Promise.resolve({ data: { signedUrl: `https://s/${path}?token=tok`, token: 'tok', path }, error: null });
          },
          upload(path: string, body: Buffer, opts: unknown) {
            uploads.push({ path, opts });
            if (state.uploadError) return Promise.resolve({ data: null, error: state.uploadError });
            objects.set(path, Buffer.from(body));
            return Promise.resolve({ data: { path }, error: null });
          },
          info(path: string) {
            const b = objects.get(path);
            if (!b) return Promise.resolve({ data: null, error: { message: 'not found' } });
            return Promise.resolve({ data: { size: state.infoSize ?? b.length }, error: null });
          },
          download(path: string) {
            const b = objects.get(path);
            if (!b) return Promise.resolve({ data: null, error: { message: 'not found' } });
            return Promise.resolve({ data: new Blob([b]), error: null });
          },
          remove(paths: string[]) {
            removed.push(paths);
            if (state.removeThrows) return Promise.reject(new Error('network down'));
            if (state.removeError) return Promise.resolve({ data: null, error: state.removeError });
            for (const p of paths) objects.delete(p);
            return Promise.resolve({ data: [], error: null });
          },
        };
      },
    },
  },
}));

const logged: unknown[] = [];
vi.mock('@/lib/logger', () => ({ logSystem: (p: unknown) => { logged.push(p); return Promise.resolve(); } }));

const usage: Record<string, unknown>[] = [];
vi.mock('@/lib/assistant/persist', () => ({
  writeUsageLog: (row: Record<string, unknown>) => { usage.push(row); return Promise.resolve(); },
}));

vi.mock('@/lib/attachments/reader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/attachments/reader')>();
  return {
    ...actual,
    readAttachment: (bytes: Buffer, name: string) => {
      if (state.readThrows) throw new RangeError('Invalid array length');
      return actual.readAttachment(bytes, name);
    },
  };
});

import {
  attachmentPaths,
  createUpload,
  confirmUpload,
  isConfirmExpired,
  listConversationAttachments,
  bindAttachments,
  loadExtract,
  deleteAttachment,
  deleteConversationAttachments,
  purgeOrphans,
} from '@/lib/attachments/store';
import { MAX_ATTACHMENT_BYTES, CONFIRM_WINDOW_MS, ORPHAN_TTL_MS } from '@/lib/attachments/limits';

const actor = { userId: 'u1', departmentId: 'd1', organizationId: 'o1' };
const CSV = Buffer.from('부서,예산\n총무과,100\n기획과,200\n', 'utf8');

beforeEach(() => {
  db.chat_attachments = [];
  db.conversations = [];
  objects.clear();
  removed.length = 0;
  uploads.length = 0;
  logged.length = 0;
  usage.length = 0;
  Object.assign(state, {
    insertError: null, signError: null, removeError: null, removeThrows: false, selectError: null,
    uploadError: null, infoSize: null, readThrows: false,
  });
});

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

let seq = 0;
function seed(over: Partial<Row>): Row {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  const row: Row = {
    id, user_id: 'u1', department_id: 'd1', conversation_id: null, file_name: `f${seq}.csv`,
    mime_type: 'text/csv', size_bytes: 10, status: 'ready', summary: null, error: null,
    storage_path: `chat-uploads/o1/u1/${id}.csv`, extract_path: `chat-uploads/o1/u1/${id}.json`,
    created_at: ago(1000), ...over,
  };
  db.chat_attachments.push(row);
  return row;
}

async function uploaded(fileName: string, bytes: Buffer) {
  const res = await createUpload(actor, { fileName, size: bytes.length });
  if (!res.ok) throw new Error(res.message);
  objects.set(res.path, bytes);
  return res;
}

describe('경로', () => {
  it('경로에 파일 이름이 들어가지 않는다', () => {
    expect(attachmentPaths('o', 'u', 'i', 'xlsx')).toEqual({
      storage: 'chat-uploads/o/u/i.xlsx',
      extract: 'chat-uploads/o/u/i.json',
    });
  });

  it('확장자·경로 조각이 이상하면 던진다', () => {
    expect(() => attachmentPaths('o', 'u', 'i', '../x')).toThrow();
    expect(() => attachmentPaths('o/..', 'u', 'i', 'csv')).toThrow();
    expect(() => attachmentPaths('o', '', 'i', 'csv')).toThrow();
  });
});

describe('업로드 주소 발급', () => {
  it('형식·크기 밖이면 발급하지 않는다', async () => {
    const exe = await createUpload(actor, { fileName: 'a.exe', size: 10 });
    expect(exe).toMatchObject({ ok: false, status: 400 });

    const big = await createUpload(actor, { fileName: 'a.xlsx', size: 11 * 1024 * 1024 });
    expect(big).toMatchObject({ ok: false, status: 413 });

    const xls = await createUpload(actor, { fileName: '예산.xls', size: 10 });
    expect(xls).toMatchObject({ ok: false, status: 400 });
    expect(!xls.ok && xls.message).toContain('XLSX');

    for (const size of [0, -1, Number.NaN, 1.5]) {
      expect(await createUpload(actor, { fileName: 'a.csv', size })).toMatchObject({ ok: false, status: 400 });
    }
    expect(await createUpload(actor, { fileName: 'x'.repeat(252) + '.csv', size: 1 })).toMatchObject({ ok: false, status: 400 });
    expect(db.chat_attachments).toEqual([]);
  });

  it('pending 행을 먼저 넣고 같은 id 경로로 서명 주소를 준다', async () => {
    const res = await createUpload(actor, { fileName: '2026 예산.XLSX', size: 1234 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.token).toBe('tok');
    expect(res.path).toBe(`chat-uploads/o1/u1/${res.id}.xlsx`);
    const row = db.chat_attachments.find((r) => r.id === res.id)!;
    expect(row).toMatchObject({
      user_id: 'u1', department_id: 'd1', file_name: '2026 예산.XLSX', size_bytes: 1234,
      status: 'pending', storage_path: res.path, conversation_id: null,
    });
    expect(row).not.toHaveProperty('organization_id'); // 트리거가 채운다
    expect(row.extract_path ?? null).toBeNull();
  });

  it('서명 주소를 못 받으면 넣은 행을 지운다', async () => {
    state.signError = { message: 'boom' };
    const res = await createUpload(actor, { fileName: 'a.csv', size: 10 });
    expect(res).toMatchObject({ ok: false, status: 500 });
    expect(db.chat_attachments).toEqual([]);
  });
});

describe('확인', () => {
  it('isConfirmExpired는 10분 경계와 깨진 시각을 거부 쪽으로 본다', () => {
    const now = Date.parse('2026-10-17T00:10:00.000Z');
    expect(isConfirmExpired('2026-10-17T00:00:00.000Z', now)).toBe(false);
    expect(isConfirmExpired('2026-10-17T00:00:00.000Z', now + 1)).toBe(true);
    expect(isConfirmExpired('엉터리', now)).toBe(true);
  });

  it('발급 후 10분 지난 확인은 거부하고 객체를 지운다', async () => {
    const up = await uploaded('a.csv', CSV);
    db.chat_attachments[0].created_at = ago(CONFIRM_WINDOW_MS + 1000);
    const res = await confirmUpload(actor, up.id);
    expect(res).toMatchObject({ ok: false, status: 410, message: '업로드 시간이 지났습니다. 다시 올려 주세요.' });
    expect(removed.flat()).toContain(up.path);
    expect(db.chat_attachments).toEqual([]);
  });

  it('실제 크기가 상한을 넘으면 거부하고 지운다', async () => {
    // 신고는 작게, 실제로는 크게 — 서명 주소는 크기를 강제하지 않는다
    const res0 = await createUpload(actor, { fileName: 'a.csv', size: 10 });
    if (!res0.ok) throw new Error();
    objects.set(res0.path, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x61));
    // 저장소 정보가 비거나 틀려도 내려받은 실제 길이로 거른다
    state.infoSize = 10;
    const res = await confirmUpload(actor, res0.id);
    expect(res).toMatchObject({ ok: false, status: 413 });
    expect(removed.flat()).toContain(res0.path);
    expect(objects.has(res0.path)).toBe(false);
    expect(db.chat_attachments).toEqual([]);
  });

  it('저장소 정보가 이미 상한을 넘으면 내려받지 않고 거부한다', async () => {
    const up = await uploaded('a.csv', CSV);
    state.infoSize = MAX_ATTACHMENT_BYTES + 1;
    const res = await confirmUpload(actor, up.id);
    expect(res).toMatchObject({ ok: false, status: 413 });
    expect(db.chat_attachments).toEqual([]);
  });

  it('읽기 성공: 읽은 내용 JSON을 같은 자리에 두고 ready·요약을 돌려준다', async () => {
    const up = await uploaded('예산.csv', CSV);
    const res = await confirmUpload(actor, up.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const extractPath = `chat-uploads/o1/u1/${up.id}.json`;
    expect(res.attachment).toMatchObject({ id: up.id, status: 'ready', file_name: '예산.csv', size_bytes: CSV.length });
    expect(res.attachment.summary?.tables.length).toBe(1);
    expect(db.chat_attachments[0].extract_path).toBe(extractPath);
    expect(objects.has(up.path)).toBe(true); // 원본은 남긴다
    const extract = JSON.parse(objects.get(extractPath)!.toString('utf8'));
    expect(extract.tables[0].columns).toEqual(['부서', '예산']);
    // 응답에 저장소 경로를 싣지 않는다
    expect(JSON.stringify(res.attachment)).not.toContain('chat-uploads');

    expect(await loadExtract({ id: up.id, user_id: 'u1' }, 'o1')).toMatchObject({ kind: 'spreadsheet' });
  });

  it('읽기 실패는 failed + 이유, 원본 객체는 지운다', async () => {
    const up = await uploaded('깨진.xlsx', Buffer.from('this is not a zip'));
    const res = await confirmUpload(actor, up.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.attachment.status).toBe('failed');
    expect(res.attachment.error).toMatch(/읽지 못했습니다/);
    expect(res.attachment.summary).toBeNull();
    expect(objects.has(up.path)).toBe(false);
    expect(db.chat_attachments[0].extract_path ?? null).toBeNull();
    expect(usage[0]).toMatchObject({ action: 'file_attached', details: { status: 'failed', tables: 0 } });
  });

  it('예상 못 한 예외는 ready를 남기지 않고 pending으로 둔 채 500', async () => {
    const up = await uploaded('a.csv', CSV);
    state.readThrows = true;
    const res = await confirmUpload(actor, up.id);
    expect(res).toMatchObject({ ok: false, status: 500 });
    expect(db.chat_attachments[0].status).toBe('pending');
  });

  it('읽은 내용을 저장하지 못하면 pending으로 둔 채 500', async () => {
    const up = await uploaded('a.csv', CSV);
    state.uploadError = { message: 'full' };
    const res = await confirmUpload(actor, up.id);
    expect(res).toMatchObject({ ok: false, status: 500 });
    expect(db.chat_attachments[0].status).toBe('pending');
  });

  it('남의 첨부·없는 id·uuid 아닌 id는 404', async () => {
    const up = await uploaded('a.csv', CSV);
    expect(await confirmUpload({ ...actor, userId: 'u2' }, up.id)).toMatchObject({ ok: false, status: 404 });
    expect(await confirmUpload(actor, '00000000-0000-4000-8000-ffffffffffff')).toMatchObject({ ok: false, status: 404 });
    expect(await confirmUpload(actor, '../etc')).toMatchObject({ ok: false, status: 404 });
    expect(db.chat_attachments[0].status).toBe('pending');
  });

  it('올리지 않은 채 확인하면 거부하고 pending으로 둔다', async () => {
    const res0 = await createUpload(actor, { fileName: 'a.csv', size: 10 });
    if (!res0.ok) throw new Error();
    const res = await confirmUpload(actor, res0.id);
    expect(res).toMatchObject({ ok: false, status: 400 });
    expect(db.chat_attachments[0].status).toBe('pending');
  });

  it('이미 확인한 첨부는 다시 읽지 않고 그대로 돌려준다', async () => {
    const up = await uploaded('a.csv', CSV);
    await confirmUpload(actor, up.id);
    usage.length = 0;
    const again = await confirmUpload(actor, up.id);
    expect(again).toMatchObject({ ok: true, attachment: { status: 'ready' } });
    expect(usage).toEqual([]);
  });

  it('사용 기록에 파일 이름이 없다', async () => {
    const up = await uploaded('비밀 인사 명단.csv', CSV);
    await confirmUpload(actor, up.id);
    expect(usage).toHaveLength(1);
    const row = usage[0];
    expect(row).toMatchObject({
      departmentId: 'd1', userId: 'u1', action: 'file_attached', resourceId: up.id,
      details: { format: 'csv', size_bytes: CSV.length, tables: 1, status: 'ready' },
    });
    const details = row.details as Record<string, unknown>;
    expect(details).not.toHaveProperty('file_name');
    expect(JSON.stringify(row)).not.toContain('명단');
  });
});

describe('대화에 묶기', () => {
  const conv = 'c0000000-0000-4000-8000-000000000001';
  const other = 'c0000000-0000-4000-8000-000000000002';
  beforeEach(() => {
    db.conversations.push({ id: conv, user_id: 'u1' }, { id: other, user_id: 'u1' });
  });

  it('자기 ready 첨부(미연결·이 대화)는 묶는다', async () => {
    const a = seed({});
    const b = seed({ conversation_id: conv });
    const res = await bindAttachments('u1', conv, [a.id as string, b.id as string]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(db.chat_attachments.every((r) => r.conversation_id === conv)).toBe(true);
  });

  it('다른 사람·다른 대화·failed·pending 첨부는 묶지 않는다', async () => {
    const mine = seed({});
    const cases = [
      seed({ user_id: 'u2' }),
      seed({ conversation_id: other }),
      seed({ status: 'failed' }),
      seed({ status: 'pending' }),
    ];
    for (const bad of cases) {
      const res = await bindAttachments('u1', conv, [mine.id as string, bad.id as string]);
      expect(res.ok, String(bad.id)).toBe(false);
    }
    // 하나라도 거부되면 아무것도 묶지 않는다
    expect(db.chat_attachments.find((r) => r.id === mine.id)!.conversation_id).toBeNull();
    expect(await bindAttachments('u1', conv, ['00000000-0000-4000-8000-ffffffffffff'])).toMatchObject({ ok: false });
    expect(await bindAttachments('u1', conv, ['not-a-uuid'])).toMatchObject({ ok: false });
  });

  it('남의 대화에는 묶지 않는다', async () => {
    db.conversations.push({ id: 'c0000000-0000-4000-8000-000000000003', user_id: 'u2' });
    const mine = seed({});
    const res = await bindAttachments('u1', 'c0000000-0000-4000-8000-000000000003', [mine.id as string]);
    expect(res.ok).toBe(false);
    expect(db.chat_attachments[0].conversation_id).toBeNull();
  });

  it('대화당 30개를 넘으면 묶지 않는다', async () => {
    for (let i = 0; i < 29; i += 1) seed({ conversation_id: conv });
    const a = seed({});
    const b = seed({});
    expect((await bindAttachments('u1', conv, [a.id as string, b.id as string])).ok).toBe(false);
    expect(db.chat_attachments.filter((r) => r.conversation_id === conv)).toHaveLength(29);
    expect((await bindAttachments('u1', conv, [a.id as string])).ok).toBe(true);
    expect(db.chat_attachments.filter((r) => r.conversation_id === conv)).toHaveLength(30);
  });

  it('빈 목록은 그대로 통과한다', async () => {
    expect(await bindAttachments('u1', conv, [])).toEqual({ ok: true, rows: [] });
  });
});

describe('목록·지우기', () => {
  const conv = 'c0000000-0000-4000-8000-000000000001';

  it('이 사용자·이 대화의 ready만 만든 순으로', async () => {
    const second = seed({ conversation_id: conv, created_at: ago(1000) });
    const first = seed({ conversation_id: conv, created_at: ago(5000) });
    seed({ conversation_id: conv, status: 'failed' });
    seed({ conversation_id: conv, user_id: 'u2' });
    seed({});
    const rows = await listConversationAttachments('u1', conv);
    expect(rows.map((r) => r.id)).toEqual([first.id, second.id]);
    expect(JSON.stringify(rows)).not.toContain('chat-uploads');
  });

  it('지우기는 묶이지 않은 자기 첨부만', async () => {
    const free = seed({});
    const bound = seed({ conversation_id: conv });
    const others = seed({ user_id: 'u2' });
    expect(await deleteAttachment('u1', bound.id as string)).toBe(false);
    expect(await deleteAttachment('u1', others.id as string)).toBe(false);
    expect(await deleteAttachment('u1', 'nope')).toBe(false);
    expect(await deleteAttachment('u1', free.id as string)).toBe(true);
    expect(db.chat_attachments.map((r) => r.id)).toEqual([bound.id, others.id]);
    expect(removed.flat()).toEqual([free.storage_path, free.extract_path]);
  });
});

describe('정리', () => {
  it('24시간 지난 pending·미연결 첨부를 정리한다', async () => {
    const now = Date.now();
    const stalePending = seed({ status: 'pending', extract_path: null, created_at: ago(ORPHAN_TTL_MS + 1000) });
    const staleReady = seed({ created_at: ago(ORPHAN_TTL_MS + 1000) });
    const fresh = seed({ status: 'pending', created_at: ago(1000) });
    const bound = seed({ conversation_id: 'c1', created_at: ago(ORPHAN_TTL_MS + 1000) });
    const others = seed({ user_id: 'u2', created_at: ago(ORPHAN_TTL_MS + 1000) });

    await purgeOrphans('u1', now);
    expect(db.chat_attachments.map((r) => r.id).sort()).toEqual([fresh.id, bound.id, others.id].sort());
    const paths = removed.flat();
    expect(paths).toEqual(expect.arrayContaining([stalePending.storage_path, staleReady.storage_path, staleReady.extract_path]));
    expect(paths).not.toContain(null);
    expect(paths).not.toContain(bound.storage_path);
    expect(paths).not.toContain(others.storage_path);
  });

  it('발급할 때 정리를 함께 돈다', async () => {
    const stale = seed({ status: 'pending', created_at: ago(ORPHAN_TTL_MS + 1000) });
    await createUpload(actor, { fileName: 'a.csv', size: 10 });
    expect(db.chat_attachments.some((r) => r.id === stale.id)).toBe(false);
  });

  it('정리가 실패해도 발급은 된다', async () => {
    seed({ status: 'pending', created_at: ago(ORPHAN_TTL_MS + 1000) });
    state.removeThrows = true;
    const res = await createUpload(actor, { fileName: 'a.csv', size: 10 });
    expect(res.ok).toBe(true);
    expect(logged.length).toBeGreaterThan(0);
  });
});

describe('대화 삭제 때', () => {
  it('그 대화의 원본·읽은 내용을 지운다', async () => {
    const a = seed({ conversation_id: 'c1' });
    const f = seed({ conversation_id: 'c1', status: 'failed', extract_path: null });
    seed({ conversation_id: 'c2' });
    await deleteConversationAttachments('c1');
    expect(removed.flat().sort()).toEqual([a.storage_path, a.extract_path, f.storage_path].sort());
    expect(logged).toEqual([]);
  });

  it('대화 삭제 정리는 실패해도 던지지 않는다', async () => {
    seed({ conversation_id: 'c1' });
    state.removeError = { message: 'denied' };
    await expect(deleteConversationAttachments('c1')).resolves.toBeUndefined();
    expect(JSON.stringify(logged)).toContain('chat-uploads/o1/u1/');

    logged.length = 0;
    state.removeError = null;
    state.removeThrows = true;
    await expect(deleteConversationAttachments('c1')).resolves.toBeUndefined();
    expect(logged.length).toBe(1);

    logged.length = 0;
    state.removeThrows = false;
    state.selectError = { message: 'down' };
    await expect(deleteConversationAttachments('c1')).resolves.toBeUndefined();
    expect(logged.length).toBe(1);
  });

  it('대화 삭제 라우트가 대화를 지우기 전에 부른다', () => {
    const src = readFileSync('src/app/api/conversations/[id]/route.ts', 'utf8');
    const del = src.slice(src.indexOf('export async function DELETE'));
    const callAt = del.indexOf('deleteConversationAttachments(');
    const deleteAt = del.search(/\.from\('conversations'\)\s*\.delete\(\)/);
    expect(callAt).toBeGreaterThan(-1);
    expect(callAt).toBeLessThan(deleteAt);
  });
});

describe('라우트', () => {
  it('확인 라우트는 60초까지 돈다', () => {
    const src = readFileSync('src/app/api/attachments/route.ts', 'utf8');
    expect(src).toMatch(/export const maxDuration = 60/);
  });

  it('감사 화면이 활동 코드를 한국어로 보인다', () => {
    const src = readFileSync('src/app/api/admin/audit-logs/route.ts', 'utf8');
    expect(src).toMatch(/file_attached:\s*'파일 첨부'/);
  });
});
