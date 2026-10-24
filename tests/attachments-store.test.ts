// tests/attachments-store.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { NextRequest } from 'next/server';

/**
 * 첨부 저장소. supabaseAdmin은 메모리 표로 흉내 낸다 — 주인·대화·상태 조건이
 * 실제로 걸러 내는지를 봐야 하므로 호출 기록만으로는 부족하다.
 * 0030의 CHECK((status='ready') = (extract_path IS NOT NULL))도 흉내 낸다 —
 * 코드가 두 칸을 같은 변경에서 맞추는지 모든 테스트가 함께 본다.
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
  updateError: null as null | { message: string },
  infoSize: null as null | number,
  readThrows: false,
  /** 읽기가 이 오류를 던진다(예: 스캔 경로의 AttachmentReadError) */
  readFails: null as null | Error,
  /** 확인 중 상태 변경 직전에 끼어드는 다른 요청 */
  beforeUpdate: null as null | (() => void),
  session: null as null | { user: { id: string } },
};

function violatesExtractCheck(r: Row): boolean {
  return (r.status === 'ready') !== (r.extract_path != null);
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
    if (op === 'update' && table === 'chat_attachments') {
      const hook = state.beforeUpdate;
      state.beforeUpdate = null;
      hook?.();
      if (state.updateError) return { data: null, error: state.updateError };
    }
    const rows = db[table] ?? (db[table] = []);
    const hit = rows.filter((r) => filters.every((f) => f(r)));
    if (op === 'update') {
      if (table === 'chat_attachments' && hit.some((r) => violatesExtractCheck({ ...r, ...patch }))) {
        return { data: null, error: { message: 'violates check constraint (23514)' } };
      }
      for (const r of hit) Object.assign(r, patch);
    }
    if (op === 'delete') db[table] = rows.filter((r) => !hit.includes(r));
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
    update(p: Row) { op = 'update'; patch = p; return q; },
    delete() { op = 'delete'; return q; },
    eq(col: string, v: unknown) { filters.push((r) => r[col] === v); return q; },
    is(col: string, v: unknown) { filters.push((r) => (r[col] ?? null) === v); return q; },
    in(col: string, vs: unknown[]) { filters.push((r) => vs.includes(r[col])); return q; },
    lt(col: string, v: string) { filters.push((r) => String(r[col]) < v); return q; },
    gte(col: string, v: string) { filters.push((r) => String(r[col]) >= v); return q; },
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
          const full = { created_at: new Date().toISOString(), conversation_id: null, extract_path: null, ...row };
          if (table === 'chat_attachments' && violatesExtractCheck(full)) {
            return Promise.resolve({ error: { message: 'violates check constraint (23514)' } });
          }
          (db[table] ?? (db[table] = [])).push(full);
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
      if (state.readFails) throw state.readFails;
      return actual.readAttachment(bytes, name);
    },
  };
});

vi.mock('@/lib/auth', () => ({
  getServerAuthSession: () => Promise.resolve(state.session),
  isAdminSession: () => false,
}));

import {
  attachmentPaths,
  createUpload,
  confirmUpload,
  isConfirmExpired,
  listConversationAttachments,
  bindAttachments,
  checkAttachable,
  loadExtract,
  deleteAttachment,
  deleteConversationAttachments,
  purgeOrphans,
} from '@/lib/attachments/store';
import { AttachmentReadError } from '@/lib/attachments/reader';
import { NodaError } from '@/lib/noda';
import {
  MAX_ATTACHMENT_BYTES,
  CONFIRM_WINDOW_MS,
  ORPHAN_TTL_MS,
  TOMBSTONE_WINDOW_MS,
  MAX_PENDING_ATTACHMENTS,
} from '@/lib/attachments/limits';
import { GET as listRoute } from '@/app/api/attachments/route';

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
    uploadError: null, updateError: null, infoSize: null, readThrows: false, readFails: null, beforeUpdate: null, session: null,
  });
});

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

let seq = 0;
function seed(over: Partial<Row>): Row {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  const status = (over.status as string | undefined) ?? 'ready';
  const row: Row = {
    id, user_id: 'u1', department_id: 'd1', conversation_id: null, file_name: `f${seq}.csv`,
    mime_type: 'text/csv', size_bytes: 10, status, summary: null, error: null,
    storage_path: `chat-uploads/o1/u1/${id}.csv`,
    extract_path: status === 'ready' ? `chat-uploads/o1/u1/${id}.json` : null,
    created_at: ago(1000), ...over,
  };
  db.chat_attachments.push(row);
  return row;
}

const sibling = (r: Row) => String(r.storage_path).replace(/\.[a-z0-9]+$/, '.json');

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

  it('파일 이름의 제어·방향·폭 없는 글자를 빼고 공백을 줄여 저장한다', async () => {
    const res = await createUpload(actor, {
      fileName: '  2026​  예산‮\t\u0007\u0085⁦표⁩‏﻿.csv ',
      size: 10,
    });
    expect(res.ok).toBe(true);
    expect(db.chat_attachments[0].file_name).toBe('2026 예산표.csv');

    for (const bad of ['​‮\u0085', ' \u0000 ', '']) {
      expect(await createUpload(actor, { fileName: bad, size: 10 })).toMatchObject({
        ok: false, status: 400, message: '파일 이름이 올바르지 않습니다.',
      });
    }
    // 방향 글자로 숨긴 진짜 확장자가 드러난다
    expect(await createUpload(actor, { fileName: '보고서‮xcod.exe', size: 10 })).toMatchObject({ ok: false, status: 400 });
  });

  it('서식 글자 전부(태그 문자·아랍 글자 표시·단어 잇기·약한 하이픈)와 [ ]를 뺀다', async () => {
    const tag = String.fromCodePoint(0xe0049) + String.fromCodePoint(0xe0067) + String.fromCodePoint(0xe007f);
    const res = await createUpload(actor, { fileName: `[예산]${tag}\u061C\u2060\u00AD표.csv`, size: 10 });
    expect(res.ok).toBe(true);
    expect(db.chat_attachments[0].file_name).toBe('예산표.csv');
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
      status: 'pending', storage_path: res.path, conversation_id: null, extract_path: null,
    });
    expect(row).not.toHaveProperty('organization_id'); // 트리거가 채운다
  });

  it('서명 주소를 못 받으면 넣은 행을 지운다', async () => {
    state.signError = { message: 'boom' };
    const res = await createUpload(actor, { fileName: 'a.csv', size: 10 });
    expect(res).toMatchObject({ ok: false, status: 500 });
    expect(db.chat_attachments).toEqual([]);
  });

  it('보내지 않은 첨부가 상한이면 429 — 상태와 무관하게 24시간 안의 미연결만 센다', async () => {
    expect(MAX_PENDING_ATTACHMENTS).toBe(20);
    const statuses = ['pending', 'ready', 'failed'];
    for (let i = 0; i < MAX_PENDING_ATTACHMENTS - 1; i += 1) seed({ status: statuses[i % 3] });
    seed({ conversation_id: 'c1' }); // 묶인 것은 세지 않는다
    seed({ user_id: 'u2' }); // 남의 것은 세지 않는다
    // 묶인 failed·남의 failed도 — 오래된 것이든 서명 주소 시한 안이든
    for (const created_at of [ago(1000), ago(TOMBSTONE_WINDOW_MS + 60_000)]) {
      seed({ status: 'failed', conversation_id: 'c1', created_at });
      seed({ status: 'failed', user_id: 'u2', storage_path: 'chat-uploads/o1/u2/x.csv', created_at });
    }
    seed({ status: 'pending', created_at: ago(ORPHAN_TTL_MS + 1000) }); // 묵은 것은 먼저 정리된다
    expect((await createUpload(actor, { fileName: 'a.csv', size: 10 })).ok).toBe(true);

    const before = db.chat_attachments.length;
    const res = await createUpload(actor, { fileName: 'b.csv', size: 10 });
    expect(res).toEqual({
      ok: false, status: 429, message: '보내지 않은 첨부가 너무 많습니다. 정리한 뒤 다시 올려 주세요.',
    });
    expect(db.chat_attachments.length).toBe(before);
  });

  it('failed 묘비는 서명 주소가 살아 있는 동안만 센다 — 지나면 상한을 차지하지 않는다', async () => {
    expect(TOMBSTONE_WINDOW_MS).toBe((2 * 60 + 10) * 60 * 1000);
    // 3시간 지난 failed는 세지 않고 정리된다
    const oldFailed = seed({ status: 'failed', created_at: ago(3 * 60 * 60 * 1000) });
    objects.set(String(oldFailed.storage_path), Buffer.from('x'));
    for (let i = 0; i < MAX_PENDING_ATTACHMENTS - 1; i += 1) seed({ status: 'failed' });
    expect((await createUpload(actor, { fileName: 'a.csv', size: 10 })).ok).toBe(true);
    expect(db.chat_attachments.some((r) => r.id === oldFailed.id)).toBe(false);
    expect(objects.has(String(oldFailed.storage_path))).toBe(false);
  });

  it('1시간 지난 failed 묘비는 아직 세고 지우지 않는다(서명 주소가 살아 있다)', async () => {
    const young = seed({ status: 'failed', created_at: ago(60 * 60 * 1000) });
    objects.set(String(young.storage_path), Buffer.from('x'));
    for (let i = 0; i < MAX_PENDING_ATTACHMENTS - 1; i += 1) seed({ status: 'pending' });
    const res = await createUpload(actor, { fileName: 'a.csv', size: 10 });
    expect(res).toMatchObject({ ok: false, status: 429 });
    expect(db.chat_attachments.some((r) => r.id === young.id)).toBe(true);
    expect(objects.has(String(young.storage_path))).toBe(true);
  });

  it('3시간 지난 pending은 24시간 안이라 계속 센다', async () => {
    for (let i = 0; i < MAX_PENDING_ATTACHMENTS; i += 1) {
      seed({ status: 'pending', created_at: ago(3 * 60 * 60 * 1000) });
    }
    expect(await createUpload(actor, { fileName: 'a.csv', size: 10 })).toMatchObject({ ok: false, status: 429 });
  });

  it('상한을 세지 못하면 발급하지 않는다', async () => {
    state.selectError = { message: 'down' };
    expect(await createUpload(actor, { fileName: 'a.csv', size: 10 })).toMatchObject({ ok: false, status: 500 });
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

  it('발급 후 10분 지난 확인은 거부하고 객체를 지우되 기록은 failed로 남긴다', async () => {
    const up = await uploaded('a.csv', CSV);
    db.chat_attachments[0].created_at = ago(CONFIRM_WINDOW_MS + 1000);
    const res = await confirmUpload(actor, up.id);
    expect(res).toMatchObject({ ok: false, status: 410, message: '업로드 시간이 지났습니다. 다시 올려 주세요.' });
    expect(removed.flat()).toEqual(expect.arrayContaining([up.path, `chat-uploads/o1/u1/${up.id}.json`]));
    expect(objects.has(up.path)).toBe(false);
    // 서명 주소는 2시간 살아 있다. 행을 지우면 그 사이 다시 올린 객체가 기록 없이 남는다
    expect(db.chat_attachments).toHaveLength(1);
    expect(db.chat_attachments[0]).toMatchObject({ status: 'failed', conversation_id: null, extract_path: null });
    expect(db.chat_attachments[0].error).toMatch(/업로드 시간이 지났습니다/);
    // 다시 확인해도 살아나지 않는다
    expect(await confirmUpload(actor, up.id)).toMatchObject({ ok: true, attachment: { status: 'failed' } });
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
    expect(db.chat_attachments[0]).toMatchObject({ status: 'failed', extract_path: null });
    expect(db.chat_attachments[0].error).toMatch(/파일이 너무 큽니다/);
  });

  it('저장소 정보가 이미 상한을 넘으면 내려받지 않고 거부한다', async () => {
    const up = await uploaded('a.csv', CSV);
    state.infoSize = MAX_ATTACHMENT_BYTES + 1;
    const res = await confirmUpload(actor, up.id);
    expect(res).toMatchObject({ ok: false, status: 413 });
    expect(objects.has(up.path)).toBe(false);
    expect(db.chat_attachments[0].status).toBe('failed');
  });

  it('거부되어 남은 기록도 보내지 않은 첨부 상한에 센다', async () => {
    for (let i = 0; i < MAX_PENDING_ATTACHMENTS - 1; i += 1) seed({ status: 'pending' });
    const up = await uploaded('a.csv', CSV);
    db.chat_attachments.find((r) => r.id === up.id)!.created_at = ago(CONFIRM_WINDOW_MS + 1000);
    await confirmUpload(actor, up.id);
    expect(await createUpload(actor, { fileName: 'b.csv', size: 10 })).toMatchObject({ ok: false, status: 429 });
  });

  it('읽기 성공: 읽은 내용 JSON을 원본 옆에 두고 ready·요약을 돌려준다', async () => {
    const up = await uploaded('예산.csv', CSV);
    // 경로는 요청자 기관이 아니라 기록된 원본 경로에서 나온다
    const res = await confirmUpload({ ...actor, organizationId: 'o-other' }, up.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const extractPath = `chat-uploads/o1/u1/${up.id}.json`;
    expect(res.attachment).toMatchObject({ id: up.id, status: 'ready', file_name: '예산.csv', size_bytes: CSV.length });
    expect(res.attachment.summary?.tables.length).toBe(1);
    expect(db.chat_attachments[0].extract_path).toBe(extractPath);
    expect(objects.has(up.path)).toBe(true); // 원본은 남긴다
    // 읽은 내용은 gzip으로 저장한다(경로는 .json 그대로) — 원본보다 커져 버킷 상한에 걸리지 않게
    const stored = objects.get(extractPath)!;
    expect([stored[0], stored[1]]).toEqual([0x1f, 0x8b]);
    expect(uploads.find((u) => u.path === extractPath)?.opts).toMatchObject({ contentType: 'application/gzip' });
    const extract = JSON.parse(gunzipSync(stored).toString('utf8'));
    expect(extract.tables[0].columns).toEqual(['부서', '예산']);
    // 응답에 저장소 경로를 싣지 않는다
    expect(JSON.stringify(res.attachment)).not.toContain('chat-uploads');
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
    expect(db.chat_attachments[0].extract_path).toBeNull();
    expect(usage[0]).toMatchObject({ action: 'file_attached', details: { status: 'failed', tables: 0 } });
  });

  it.each([
    [401, 'critical'],
    [403, 'critical'],
    [503, 'warning'],
    [null, 'warning'],
  ] as const)('스캔 경로의 NODA 오류(%s)는 운영 기록(%s)에 남기고 행은 failed', async (status, level) => {
    const up = await uploaded('비밀 이름.pdf', Buffer.from('%PDF-1.4'));
    state.readFails = new AttachmentReadError(
      '스캔 문서를 읽지 못했습니다.',
      new NodaError('NODA 오류', status === null ? 'network' : 'http', status)
    );
    const res = await confirmUpload(actor, up.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.attachment.status).toBe('failed');
    const entry = logged.find((l) => (l as { category?: string }).category === 'api') as
      | { level: string; details: Record<string, unknown> }
      | undefined;
    expect(entry).toBeDefined();
    expect(entry!.level).toBe(level);
    expect(entry!.details).toEqual({
      attachment_id: up.id,
      code: status === null ? 'network' : 'http',
      status,
    });
    expect(JSON.stringify(logged)).not.toContain('비밀 이름');
  });

  it('NODA가 원인이 아닌 읽기 실패는 운영 기록을 남기지 않는다', async () => {
    const up = await uploaded('깨진.xlsx', Buffer.from('this is not a zip'));
    await confirmUpload(actor, up.id);
    expect(logged.filter((l) => (l as { category?: string }).category === 'api')).toEqual([]);
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
    state.uploadError = { message: 'Payload too large' };
    const res = await confirmUpload(actor, up.id);
    expect(res).toEqual({ ok: false, status: 500, message: '읽은 내용을 저장하지 못했습니다. 잠시 뒤 다시 올려 주세요.' });
    expect(db.chat_attachments[0].status).toBe('pending');
  });

  it('상태 기록이 실패하면 방금 올린 읽은 내용을 지운다', async () => {
    const up = await uploaded('a.csv', CSV);
    state.updateError = { message: 'db down' };
    expect(await confirmUpload(actor, up.id)).toMatchObject({ ok: false, status: 500 });
    expect(objects.has(`chat-uploads/o1/u1/${up.id}.json`)).toBe(false);
    expect(db.chat_attachments[0].status).toBe('pending');
  });

  it('겹친 확인이 이미 ready로 기록했으면 실패한 쪽이 읽은 내용을 지우지 않는다', async () => {
    const up = await uploaded('a.csv', CSV);
    const extractPath = `chat-uploads/o1/u1/${up.id}.json`;
    state.beforeUpdate = () => {
      // 다른 확인이 먼저 끝냈다
      Object.assign(db.chat_attachments[0], { status: 'ready', extract_path: extractPath });
    };
    state.updateError = { message: 'timeout' };
    expect(await confirmUpload(actor, up.id)).toMatchObject({ ok: false, status: 500 });
    expect(objects.has(extractPath)).toBe(true);
  });

  it('확인 도중 기록이 사라지면 방금 올린 읽은 내용을 지우고 404', async () => {
    const up = await uploaded('a.csv', CSV);
    state.beforeUpdate = () => { db.chat_attachments = []; };
    expect(await confirmUpload(actor, up.id)).toMatchObject({ ok: false, status: 404 });
    expect(objects.has(`chat-uploads/o1/u1/${up.id}.json`)).toBe(false);
    expect(usage).toEqual([]);
  });

  it('확인 도중 지워진(failed) 첨부는 되살리지 않고 읽은 내용도 남기지 않는다', async () => {
    const up = await uploaded('a.csv', CSV);
    state.beforeUpdate = () => {
      Object.assign(db.chat_attachments[0], { status: 'failed', error: '보내기 전에 지웠습니다.' });
    };
    const res = await confirmUpload(actor, up.id);
    expect(res).toMatchObject({ ok: true, attachment: { status: 'failed' } });
    expect(objects.has(`chat-uploads/o1/u1/${up.id}.json`)).toBe(false);
    expect(usage).toEqual([]);
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

describe('읽은 내용 불러오기', () => {
  it('기록의 경로로 읽고, 읽은 내용이 없는 기록은 null', async () => {
    const up = await uploaded('예산.csv', CSV);
    await confirmUpload(actor, up.id);
    db.conversations.push({ id: 'c0000000-0000-4000-8000-000000000009', user_id: 'u1' });
    const bound = await bindAttachments('u1', 'c0000000-0000-4000-8000-000000000009', [up.id]);
    if (!bound.ok) throw new Error(bound.message);
    expect(await loadExtract(bound.rows[0])).toMatchObject({ kind: 'spreadsheet' });

    const [listed] = await listConversationAttachments('u1', 'c0000000-0000-4000-8000-000000000009');
    expect(await loadExtract(listed)).toMatchObject({ kind: 'spreadsheet' });
    expect(await loadExtract({ ...listed, extract_path: null })).toBeNull();
  });

  it('gzip이 아닌 읽은 내용(평문 JSON)도 읽는다', async () => {
    const row = seed({});
    objects.set(String(row.extract_path), Buffer.from(JSON.stringify({ kind: 'text', text: '평문', tables: [], warnings: [] }), 'utf8'));
    expect(await loadExtract(row as never)).toMatchObject({ kind: 'text', text: '평문' });
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

  it('보내기 전에 지운 첨부는 묶지도 목록에 올리지도 않는다', async () => {
    const a = seed({});
    expect(await deleteAttachment('u1', a.id as string)).toBe(true);
    expect(await bindAttachments('u1', conv, [a.id as string])).toMatchObject({ ok: false });
    a.conversation_id = conv; // 억지로 묶어도 목록에는 ready만 나온다 (seed는 표의 행 자체를 돌려준다)
    expect(await listConversationAttachments('u1', conv)).toEqual([]);
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
    expect(await bindAttachments('u1', conv, [])).toEqual({ ok: true, rows: [], newlyBound: [] });
  });

  it('이번에 새로 묶은 id만 newlyBound로 알려 준다 — 이미 이 대화에 있던 것은 빠진다', async () => {
    const a = seed({});
    const b = seed({ conversation_id: conv });
    const res = await bindAttachments('u1', conv, [a.id as string, b.id as string]);
    expect(res.ok && res.newlyBound).toEqual([a.id]);
  });
});

describe('묶기 전 확인 (checkAttachable)', () => {
  const conv = 'c0000000-0000-4000-8000-000000000001';
  const other = 'c0000000-0000-4000-8000-000000000002';

  it('새 대화(null): 자기 ready 미연결 첨부만 통과, 아무것도 바꾸지 않는다', async () => {
    const mine = seed({});
    expect(await checkAttachable('u1', [mine.id as string], null)).toEqual({ ok: true });
    const cases = [
      seed({ user_id: 'u2' }),
      seed({ conversation_id: other }),
      seed({ status: 'failed' }),
      seed({ status: 'pending' }),
    ];
    for (const bad of cases) {
      expect((await checkAttachable('u1', [mine.id as string, bad.id as string], null)).ok, String(bad.id)).toBe(false);
    }
    expect((await checkAttachable('u1', ['not-a-uuid'], null)).ok).toBe(false);
    expect((await checkAttachable('u1', ['00000000-0000-4000-8000-ffffffffffff'], null)).ok).toBe(false);
    expect(db.chat_attachments.every((r) => r.conversation_id === null || r.conversation_id === other)).toBe(true);
  });

  it('이어지는 대화: 이 대화에 이미 묶인 것은 통과, 30개 상한을 본다', async () => {
    const here = seed({ conversation_id: conv });
    expect(await checkAttachable('u1', [here.id as string], conv)).toEqual({ ok: true });
    for (let i = 0; i < 28; i += 1) seed({ conversation_id: conv });
    const a = seed({});
    const b = seed({});
    const over = await checkAttachable('u1', [a.id as string, b.id as string], conv);
    expect(over).toEqual({ ok: false, message: '한 대화에 첨부는 30개까지입니다.' });
    expect(await checkAttachable('u1', [a.id as string], conv)).toEqual({ ok: true });
    expect(db.chat_attachments.filter((r) => r.conversation_id === conv)).toHaveLength(29);
  });

  it('빈 목록은 통과한다', async () => {
    expect(await checkAttachable('u1', [], null)).toEqual({ ok: true });
  });

  it('목록 조회가 실패하면 알린다 — 이번 턴이 첨부 없이 도는 것을 남긴다', async () => {
    state.selectError = { message: 'boom' };
    const errors: string[] = [];
    expect(await listConversationAttachments('u1', conv, { onError: (m) => errors.push(m) })).toEqual([]);
    expect(errors).toEqual(['boom']);
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
  });

  it('지우기는 묶이지 않은 자기 첨부만 — 객체는 지우고 기록은 failed로 남긴다', async () => {
    const free = seed({ status: 'pending' });
    const bound = seed({ conversation_id: conv });
    const others = seed({ user_id: 'u2' });
    expect(await deleteAttachment('u1', bound.id as string)).toBe(false);
    expect(await deleteAttachment('u1', others.id as string)).toBe(false);
    expect(await deleteAttachment('u1', 'nope')).toBe(false);
    expect(await deleteAttachment('u1', free.id as string)).toBe(true);
    expect(db.chat_attachments.map((r) => r.id)).toEqual([free.id, bound.id, others.id]);
    expect(db.chat_attachments[0]).toMatchObject({ status: 'failed', conversation_id: null, extract_path: null });
    expect(db.chat_attachments[0].error).toMatch(/보내기 전에 지웠습니다/);
    expect(db.chat_attachments[1].status).toBe('ready');
    expect(removed.flat().sort()).toEqual([free.storage_path, sibling(free)].sort());
  });
});

describe('목록 라우트', () => {
  const conv = 'c0000000-0000-4000-8000-000000000001';
  const req = (id: string) => new NextRequest(`http://localhost/api/attachments?conversation_id=${id}`);

  it('로그인하지 않으면 401', async () => {
    expect((await listRoute(req(conv))).status).toBe(401);
  });

  it('남의 대화·없는 대화·uuid 아닌 id는 404', async () => {
    state.session = { user: { id: 'u1' } };
    db.conversations.push({ id: conv, user_id: 'u2' });
    seed({ conversation_id: conv, user_id: 'u2' });
    for (const id of [conv, 'c0000000-0000-4000-8000-00000000ffff', 'x']) {
      const res = await listRoute(req(id));
      expect(res.status, id).toBe(404);
      expect(await res.json()).toMatchObject({ ok: false });
    }
  });

  it('내 대화면 ready 첨부를 저장소 경로 없이 준다', async () => {
    state.session = { user: { id: 'u1' } };
    db.conversations.push({ id: conv, user_id: 'u1' });
    const a = seed({ conversation_id: conv });
    const res = await listRoute(req(conv));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.map((r: { id: string }) => r.id)).toEqual([a.id]);
    expect(JSON.stringify(body)).not.toContain('chat-uploads');
    expect(body.data[0]).not.toHaveProperty('storage_path');
  });
});

describe('정리', () => {
  it('24시간 지난 pending·미연결 첨부의 원본·읽은 내용과 기록을 지운다', async () => {
    const now = Date.now();
    const old = ago(ORPHAN_TTL_MS + 1000);
    const stalePending = seed({ status: 'pending', created_at: old });
    const staleReady = seed({ created_at: old });
    const staleFailed = seed({ status: 'failed', created_at: old });
    const fresh = seed({ status: 'pending', created_at: ago(1000) });
    const bound = seed({ conversation_id: 'c1', created_at: old });
    const others = seed({ user_id: 'u2', created_at: old });
    for (const r of [stalePending, staleReady, staleFailed, bound]) {
      objects.set(String(r.storage_path), Buffer.from('x'));
      objects.set(sibling(r), Buffer.from('{}'));
    }

    await purgeOrphans('u1', now);
    expect(db.chat_attachments.map((r) => r.id).sort()).toEqual([fresh.id, bound.id, others.id].sort());
    for (const r of [stalePending, staleReady, staleFailed]) {
      expect(objects.has(String(r.storage_path))).toBe(false);
      expect(objects.has(sibling(r))).toBe(false); // pending·failed도 읽은 내용 자리까지
    }
    expect(objects.has(String(bound.storage_path))).toBe(true);
    expect(removed.flat()).not.toContain(others.storage_path);
  });

  it('failed 묘비는 서명 주소 시한(2시간+여유)이 지나면 24시간 전에도 지운다', async () => {
    const now = Date.now();
    const staleFailed = seed({ status: 'failed', created_at: ago(TOMBSTONE_WINDOW_MS + 1000) });
    const youngFailed = seed({ status: 'failed', created_at: ago(TOMBSTONE_WINDOW_MS - 60_000) });
    const threeHourPending = seed({ status: 'pending', created_at: ago(3 * 60 * 60 * 1000) });
    const threeHourReady = seed({ created_at: ago(3 * 60 * 60 * 1000) });
    // 묶인 failed·남의 failed는 시한이 지났든 아니든 건드리지 않는다
    const keep = [ago(TOMBSTONE_WINDOW_MS + 60_000), ago(60_000)].flatMap((created_at) => [
      seed({ status: 'failed', conversation_id: 'c1', created_at }),
      seed({ status: 'failed', user_id: 'u2', storage_path: `chat-uploads/o1/u2/${created_at}.csv`, created_at }),
    ]);
    for (const r of keep) objects.set(String(r.storage_path), Buffer.from('x'));
    for (const r of [staleFailed, youngFailed]) {
      objects.set(String(r.storage_path), Buffer.from('x'));
      objects.set(sibling(r), Buffer.from('{}'));
    }

    await purgeOrphans('u1', now);
    expect(db.chat_attachments.map((r) => r.id).sort()).toEqual(
      [youngFailed.id, threeHourPending.id, threeHourReady.id, ...keep.map((r) => r.id)].sort()
    );
    for (const r of keep) {
      expect(objects.has(String(r.storage_path))).toBe(true);
      expect(db.chat_attachments.find((x) => x.id === r.id)?.error).toBeNull();
    }
    expect(objects.has(String(staleFailed.storage_path))).toBe(false);
    expect(objects.has(sibling(staleFailed))).toBe(false);
    expect(objects.has(String(youngFailed.storage_path))).toBe(true);
  });

  it('저장소 삭제가 실패하면 기록을 남겨 다음에 다시 지운다(묶을 수는 없다)', async () => {
    const stale = seed({ created_at: ago(ORPHAN_TTL_MS + 1000) });
    state.removeError = { message: 'denied' };
    await purgeOrphans('u1', Date.now());
    expect(db.chat_attachments).toHaveLength(1);
    expect(db.chat_attachments[0]).toMatchObject({ status: 'failed', extract_path: null });
    expect(JSON.stringify(logged)).toContain(String(stale.storage_path));

    state.removeError = null;
    await purgeOrphans('u1', Date.now());
    expect(db.chat_attachments).toEqual([]);
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
  it('그 대화의 원본·읽은 내용을 지운다(읽은 내용 자리가 비어 있어도)', async () => {
    const a = seed({ conversation_id: 'c1' });
    const f = seed({ conversation_id: 'c1', status: 'failed' });
    seed({ conversation_id: 'c2' });
    await deleteConversationAttachments('c1');
    expect(removed.flat().sort()).toEqual([a.storage_path, a.extract_path, f.storage_path, sibling(f)].sort());
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

describe('라우트·마이그레이션', () => {
  it('확인 라우트는 300초까지 돈다 — 스캔 PDF는 NODA 읽기(시도 60초 + 재시도 창)가 든다', () => {
    const src = readFileSync('src/app/api/attachments/route.ts', 'utf8');
    expect(src).toMatch(/export const maxDuration = 300/);
  });

  it('감사 화면이 활동 코드를 한국어로 보인다', () => {
    const src = readFileSync('src/app/api/admin/audit-logs/route.ts', 'utf8');
    expect(src).toMatch(/file_attached:\s*'파일 첨부'/);
  });

  it('0030이 ready와 읽은 내용 경로를 짝으로 강제한다', () => {
    const sql = readFileSync('supabase/migrations/0030_chat_attachments.sql', 'utf8');
    expect(sql).toMatch(/CHECK\s*\(\s*\(status\s*=\s*'ready'\)\s*=\s*\(extract_path IS NOT NULL\)\s*\)/);
  });
});
