import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * 2026-11-25 — 자료함 내용 글 채우기(0120). 0117 전에 담은 파일·담을 때 읽지 못한 파일은 내용 글이 없어 이름으로만 찾혔다.
 * 5분 실행기가 내용을 아직 확인하지 않은(`content_checked_at` 빈) 파일을 두 개씩 자료함 사본에서 다시 읽어 채운다.
 * 읽었으면(글이 없었어도) 확인한 때를 적어 다시 읽지 않고, 저장소가 잠깐 안 될 때(503)만 다음 차례에 다시 본다.
 */

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/config', () => ({ SUPABASE_DOCUMENTS_BUCKET: 'documents' }));
vi.mock('@/lib/logger', () => ({ logSystem: async () => {} }));

import { LIBRARY_FILL_BATCH, LIBRARY_FILL_BUDGET_MS, fillLibraryContent, type LibraryFillDeps, type LibraryFillRow } from '@/lib/library-content-fill';
import { LIBRARY_CONTENT_SEARCH_NOTE, saveToLibrary, transferLibraryFile, type LibraryActor, type LibraryIo } from '@/lib/my-library';

const row = (id: string): LibraryFillRow => ({ id, storage_path: `my-library/o/u/${id}.xlsx`, file_name: `${id}.xlsx` });

function deps(over: Partial<LibraryFillDeps> = {}) {
  const saved: Array<{ id: string; content: string | null }> = [];
  let t = 0;
  const d: LibraryFillDeps = {
    listPending: async () => [row('a'), row('b'), row('c')],
    read: async () => ({ ok: true, text: '  예산\n집행 내역 ' }),
    save: async (id, content) => { saved.push({ id, content }); return true; },
    now: () => (t += 10),
    random: () => 0.5,
    ...over,
  };
  return { d, saved };
}

describe('채우기 실행기', () => {
  it('한 차례에 두 개씩 사본을 읽어 다듬은 글과 확인한 때를 적는다', async () => {
    const { d, saved } = deps();
    expect(await fillLibraryContent(d)).toEqual({ filled: 2, empty: 0, deferred: 0 });
    expect(saved).toHaveLength(LIBRARY_FILL_BATCH);
    expect(saved[0].content).toBe('예산 집행 내역');
  });
  it('글이 없거나 다시 해도 같은 실패(너무 큼·스캔 PDF·깨진 파일)면 내용 없이 확인만, 저장소가 잠깐 안 되면(503) 다음 차례에', async () => {
    const reads: Array<{ ok: true; text: string } | { ok: false; status: number }> = [{ ok: true, text: '   ' }, { ok: false, status: 422 }, { ok: false, status: 503 }];
    let i = 0;
    const { d, saved } = deps({ listPending: async () => [row('a'), row('b'), row('c')], read: async () => reads[i++] });
    const twice = { ...d, save: d.save };
    expect(await fillLibraryContent(twice)).toEqual({ filled: 0, empty: 2, deferred: 0 });
    expect(saved).toEqual([{ id: expect.any(String), content: null }, { id: expect.any(String), content: null }]);
    const late = deps({ read: async () => ({ ok: false, status: 503 }) });
    expect(await fillLibraryContent(late.d)).toEqual({ filled: 0, empty: 0, deferred: 2 });
    expect(late.saved).toEqual([]);
  });
  it('그 사이 다른 쪽이 확인했으면(save false) 세지 않고, 쓰기 실패·목록 실패는 던지지 않는다', async () => {
    expect(await fillLibraryContent(deps({ save: async () => false }).d)).toEqual({ filled: 0, empty: 0, deferred: 0 });
    expect(await fillLibraryContent(deps({ save: async () => { throw new Error('db'); } }).d)).toEqual({ filled: 0, empty: 0, deferred: 2 });
    expect(await fillLibraryContent(deps({ listPending: async () => { throw new Error('db'); } }).d)).toEqual({ filled: 0, empty: 0, deferred: 0 });
  });
  it('자료함 사본 경로만 읽고, 시간 예산을 넘기면 멈춘다', async () => {
    const read = vi.fn(async () => ({ ok: true as const, text: 'x' }));
    await fillLibraryContent(deps({ listPending: async () => [{ id: 'z', storage_path: 'chat-uploads/o/u/z.xlsx', file_name: 'z.xlsx' }], read }).d);
    expect(read).not.toHaveBeenCalled();
    let t = 0;
    const slow = deps({ now: () => (t += LIBRARY_FILL_BUDGET_MS + 1) });
    expect((await fillLibraryContent(slow.d)).filled).toBe(0);
  });
  it('5분 실행기가 부르고, 실제 의존은 사본 글 읽기(스캔 PDF는 NODA로 보내지 않음)·아직 확인하지 않은 행만 적기', () => {
    expect(readFileSync('src/app/api/cron/app-schedules/route.ts', 'utf8')).toContain('libraryFillDeps().then(fillLibraryContent).catch(() => null)');
    const src = readFileSync('src/lib/library-content-fill.ts', 'utf8');
    expect(src).toContain("await import('@/lib/source-original')");
    expect(src).toContain(".eq('id', id).is('content_checked_at', null).select('id')");
  });
});

describe('담기·보내기가 확인한 때를 남긴다', () => {
  const ORG = '22222222-2222-4222-8222-222222222222';
  const ME = '33333333-3333-4333-8333-333333333333';
  const FILE = '55555555-5555-4555-8555-555555555555';
  const actor: LibraryActor = { userId: ME, organizationId: ORG, departmentId: '77777777-7777-4777-8777-777777777777', isAdmin: false, managesWholeOrganization: false, shares: [] };
  function io(over: Partial<LibraryIo> = {}) {
    const inserted: Record<string, unknown>[] = [];
    const base = {
      findSource: async () => ({ storage_path: `chat-uploads/${ORG}/${ME}/x.xlsx`, file_name: '서식.xlsx', size_bytes: 10 }),
      readContent: async () => '예산',
      folderValues: async () => [''],
      findRow: async () => ({ id: FILE, file_name: '서식.xlsx', folder: '', size_bytes: 1, source: 'attachment', created_at: '2026-11-25T00:00:00Z', user_id: ME, storage_path: 'my-library/x.xlsx', content_text: null, content_checked_at: null }),
      userNames: async () => new Map(),
      copyObject: async () => 'ok' as const,
      removeObject: async () => 'ok' as const,
      insert: async (r: Record<string, unknown>) => { inserted.push(r); return { ...r, created_at: '2026-11-25T01:00:00Z' }; },
      remove: async () => 1,
      ...over,
    } as unknown as LibraryIo;
    return { io: base, inserted };
  }
  it('담을 때 읽었으면 확인한 때, 못 읽었으면 비워 둔다(실행기가 채움)', async () => {
    const ok = io();
    await saveToLibrary(actor, { kind: 'attachment', id: FILE }, ok.io, () => FILE);
    expect(typeof ok.inserted[0].content_checked_at).toBe('string');
    const failed = io({ readContent: async () => null } as Partial<LibraryIo>);
    await saveToLibrary(actor, { kind: 'attachment', id: FILE }, failed.io, () => FILE);
    expect(failed.inserted[0].content_checked_at).toBeNull();
  });
  it('보내면 확인한 때도 그대로(아직이면 새 사본도 실행기가 채운다)', async () => {
    const pending = io();
    await transferLibraryFile(actor, FILE, { space: 'personal', to: 'department', mode: 'copy' }, pending.io, () => '66666666-6666-4666-8666-666666666666');
    expect(pending.inserted[0].content_checked_at).toBeNull();
    const checked = io({ findRow: async () => ({ id: FILE, file_name: '서식.xlsx', folder: '', size_bytes: 1, source: 'attachment', created_at: '2026-11-25T00:00:00Z', user_id: ME, storage_path: 'my-library/x.xlsx', content_text: '예산', content_checked_at: '2026-11-25T00:00:00Z' }) } as Partial<LibraryIo>);
    await transferLibraryFile(actor, FILE, { space: 'personal', to: 'department', mode: 'copy' }, checked.io, () => '66666666-6666-4666-8666-666666666666');
    expect(checked.inserted[0]).toMatchObject({ content_text: '예산', content_checked_at: '2026-11-25T00:00:00Z' });
  });
  it('찾기 안내가 몇 분 안에 채워진다고 알린다', () => {
    expect(LIBRARY_CONTENT_SEARCH_NOTE).toContain('몇 분 안에 채워집니다');
    expect(LIBRARY_CONTENT_SEARCH_NOTE).toContain('이름으로만');
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0120 — 내용 확인 칸(시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('여러 번 적용해도 안전·내용 글이 있는 행은 담은 때로 채움·확인 안 한 행 색인', async () => {
    await db.query('BEGIN');
    try {
      const org = randomUUID(); const dept = randomUUID(); const user = randomUUID();
      await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [org, '0120 기관']);
      await db.query("INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, '총무과', $2, $3)", [dept, `d-${dept.slice(0, 8)}`, org]);
      await db.query("INSERT INTO users (id, email, role, department_id) VALUES ($1, $2, 'USER', $3)", [user, `${user}@x.test`, dept]);
      const put = (content: string | null) => db.query(
        "INSERT INTO my_library_files (user_id, organization_id, space, folder, file_name, size_bytes, storage_path, source, content_text, content_checked_at, created_at) VALUES ($1, $2, 'personal', '', 'a.xlsx', 1, $3, 'attachment', $4, NULL, '2026-11-01T00:00:00Z') RETURNING id",
        [user, org, `my-library/${randomUUID()}`, content]);
      const withText = (await put('예산')).rows[0].id; const without = (await put(null)).rows[0].id;
      const sql = readFileSync('supabase/migrations/0120_library_content_checked.sql', 'utf8');
      await db.query(sql); await db.query(sql);
      const rows = await db.query('SELECT id, content_checked_at FROM my_library_files WHERE id = ANY($1)', [[withText, without]]);
      const byId = new Map(rows.rows.map((r) => [r.id, r.content_checked_at]));
      expect(new Date(byId.get(withText)).toISOString()).toBe('2026-11-01T00:00:00.000Z');
      expect(byId.get(without)).toBeNull();
      const idx = await db.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'my_library_files_content_unchecked_idx'");
      expect(idx.rows[0].indexdef).toContain('content_checked_at IS NULL');
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
