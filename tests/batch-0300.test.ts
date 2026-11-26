import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * 2026-11-25 — 자료함 파일 내용 찾기(0117): 담을 때 그 파일을 글로 읽어 앞 20,000자를 `content_text`에 두고,
 * 찾기는 이름 + 내용을 이은 `search_text`(생성 칸)를 본다. 내용에서 맞으면 그 자리 앞뒤만 화면에 보이고 내용 글은 내보내지 않는다.
 * 다른 자료함으로 보내면 내용 글도 함께 간다(다시 읽지 않음). 못 읽으면 내용 찾기만 빠지고 담기는 그대로.
 */

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/config', () => ({ SUPABASE_DOCUMENTS_BUCKET: 'documents' }));
vi.mock('@/lib/logger', () => ({ logSystem: async () => {} }));

import {
  libraryContentText, librarySnippet, listLibrary, saveToLibrary, transferLibraryFile, transferLibraryFiles,
  LIBRARY_CONTENT_MAX, LIBRARY_CONTENT_SEARCH_NOTE,
  type LibraryActor, type LibraryIo,
} from '@/lib/my-library';

const ORG = '22222222-2222-4222-8222-222222222222';
const ME = '33333333-3333-4333-8333-333333333333';
const DEPT = '77777777-7777-4777-8777-777777777777';
const FILE = '55555555-5555-4555-8555-555555555555';
const NEW = '66666666-6666-4666-8666-666666666666';
const actor: LibraryActor = { userId: ME, organizationId: ORG, departmentId: DEPT, isAdmin: false, managesWholeOrganization: false, shares: [] };
const newId = () => NEW;

describe('내용 글 다듬기·맞은 자리', () => {
  it('libraryContentText — 제어·서식 글자를 빼고 공백을 하나로, 20,000자(코드 포인트)까지, 남는 글이 없으면 null', () => {
    expect(libraryContentText('  2026년\n\n예산\t편성​기준\u0007 ')).toBe('2026년 예산 편성 기준');
    expect(libraryContentText(' \n\t ')).toBeNull();
    expect(libraryContentText(undefined)).toBeNull();
    expect(libraryContentText(12)).toBeNull();
    const long = libraryContentText('가'.repeat(LIBRARY_CONTENT_MAX + 5))!;
    expect(Array.from(long)).toHaveLength(LIBRARY_CONTENT_MAX);
    // 한 글자가 둘(서로게이트 짝)인 글도 글자 수로 센다 — DB char_length와 같다
    const emoji = libraryContentText('😀'.repeat(LIBRARY_CONTENT_MAX + 1))!;
    expect(Array.from(emoji)).toHaveLength(LIBRARY_CONTENT_MAX);
    expect(LIBRARY_CONTENT_MAX).toBe(100_000); // 0127(2026-11-26)에 20,000자에서 넓힘
  });
  it('librarySnippet — 내용에서 처음 맞은 자리 앞 30자·뒤 60자, 대소문자 무시, 이름에서 맞으면 null', () => {
    const content = `${'가'.repeat(40)} 국외 출장 여비는 Travel Rule에 따른다 ${'나'.repeat(80)}`;
    const s = librarySnippet(content, '여비 규정.hwpx', 'travel rule')!;
    expect(s.hit).toBe('Travel Rule');
    expect(s.before.startsWith('…')).toBe(true);
    expect(Array.from(s.before.slice(1))).toHaveLength(30);
    expect(s.after.endsWith('…')).toBe(true);
    expect(librarySnippet(content, '여비 규정.hwpx', '여비')).toBeNull();
    expect(librarySnippet(content, 'a.hwpx', '없는 글')).toBeNull();
    expect(librarySnippet(null, 'a.hwpx', '여비')).toBeNull();
    expect(librarySnippet(content, 'a.hwpx', null)).toBeNull();
    expect(librarySnippet('짧은 글 여비', 'a.hwpx', '여비')).toEqual({ before: '짧은 글 ', hit: '여비', after: '' });
  });
  it('화면 안내는 상한과 이름으로만 찾히는 경우를 밝힌다', () => {
    expect(LIBRARY_CONTENT_SEARCH_NOTE).toContain('100,000자');
    expect(LIBRARY_CONTENT_SEARCH_NOTE).toContain('이름으로만');
  });
});

function fakeIo(over: Partial<LibraryIo> = {}) {
  const inserted: Record<string, unknown>[] = [];
  const pages: { query: string | null }[] = [];
  const row = {
    id: FILE, file_name: '서식.xlsx', folder: '', size_bytes: 10, source: 'attachment', created_at: '2026-11-25T00:00:00Z', user_id: ME,
    storage_path: `my-library/${ORG}/${ME}/${FILE}.xlsx`, content_text: '총무과 2026 예산 집행 내역 여비 1,200천원',
  };
  const io = {
    findSource: async () => ({ storage_path: `chat-uploads/${ORG}/${ME}/x.xlsx`, file_name: '서식.xlsx', size_bytes: 10, extract_path: `chat-uploads/${ORG}/${ME}/x.json` }),
    readContent: async () => '  예산\n집행  내역 ',
    folderValues: async () => [''],
    page: async (_a: LibraryActor, _s: unknown, opts: { query: string | null }) => { pages.push({ query: opts.query }); return [row]; },
    findRow: async () => row,
    findRows: async () => [row],
    userNames: async () => new Map(),
    copyObject: async () => 'ok' as const,
    removeObject: async () => 'ok' as const,
    insert: async (r: Record<string, unknown>) => { inserted.push(r); return { ...r, created_at: '2026-11-25T01:00:00Z' }; },
    remove: async () => 1,
    ...over,
  } as unknown as LibraryIo;
  return { io, inserted, pages };
}

describe('담기·보내기·찾기', () => {
  it('담을 때 읽은 글을 다듬어 content_text로 넣는다(원본 id·경로를 넘김)', async () => {
    const seen: unknown[][] = [];
    const { io, inserted } = fakeIo({ readContent: async (...a: unknown[]) => { seen.push(a); return '  예산\n집행  내역 '; } } as Partial<LibraryIo>);
    expect(await saveToLibrary(actor, { kind: 'attachment', id: FILE.toUpperCase() }, io, newId)).toMatchObject({ ok: true });
    expect(inserted[0].content_text).toBe('예산 집행 내역');
    expect(seen[0]).toEqual([ME, 'attachment', FILE, expect.objectContaining({ extract_path: `chat-uploads/${ORG}/${ME}/x.json` })]);
  });
  it('못 읽거나(던짐·null) 글이 없으면 content_text 없이 담는다 — 담기는 그대로', async () => {
    for (const readContent of [async () => { throw new Error('x'); }, async () => null, async () => '   ', undefined]) {
      const { io, inserted } = fakeIo({ readContent } as Partial<LibraryIo>);
      expect(await saveToLibrary(actor, { kind: 'generated', id: FILE }, io, newId)).toMatchObject({ ok: true });
      expect(inserted[0].content_text).toBeNull();
    }
  });
  it('찾기 — 내용에서 맞으면 그 자리 앞뒤만 싣고 내용 글은 내보내지 않는다', async () => {
    const { io, pages } = fakeIo();
    const r = await listLibrary(actor, { space: 'personal', q: ' 여비 ' }, io);
    expect(pages[0].query).toBe('여비');
    if (!r.ok) throw new Error('목록 실패');
    const f = r.data.files[0];
    expect(f.snippet).toEqual({ before: '총무과 2026 예산 집행 내역 ', hit: '여비', after: ' 1,200천원' });
    expect(Object.keys(f)).not.toContain('content_text');
    expect(JSON.stringify(r)).not.toContain('chat-uploads');
    // 이름에서 맞았거나 찾지 않으면 자리 없음
    const byName = await listLibrary(actor, { space: 'personal', q: '서식' }, io);
    expect(byName.ok && byName.data.files[0].snippet).toBeFalsy();
    const plain = await listLibrary(actor, { space: 'personal' }, io);
    expect(plain.ok && 'snippet' in plain.data.files[0]).toBe(false);
  });
  it('다른 자료함으로 보내면 내용 글도 함께 간다 — 다시 읽지 않는다(하나·여럿)', async () => {
    let reads = 0;
    const one = fakeIo({ readContent: async () => { reads++; return 'x'; } } as Partial<LibraryIo>);
    expect(await transferLibraryFile(actor, FILE, { space: 'personal', to: 'department', mode: 'copy' }, one.io, newId)).toMatchObject({ ok: true });
    expect(one.inserted[0].content_text).toBe('총무과 2026 예산 집행 내역 여비 1,200천원');
    const many = fakeIo();
    expect(await transferLibraryFiles(actor, { space: 'personal', to: 'department', mode: 'copy', ids: [FILE] }, many.io, newId)).toMatchObject({ ok: true, sent: 1 });
    expect(many.inserted[0].content_text).toBe('총무과 2026 예산 집행 내역 여비 1,200천원');
    // 내용 글이 없던 파일은 없는 채로
    const none = fakeIo({ findRow: async () => ({ id: FILE, file_name: 'a.xlsx', folder: '', size_bytes: 1, source: 'generated', created_at: '2026-11-25T00:00:00Z', user_id: ME, storage_path: 'my-library/a.xlsx', content_text: null }) } as Partial<LibraryIo>);
    expect(await transferLibraryFile(actor, FILE, { space: 'personal', to: 'department', mode: 'move' }, none.io, newId)).toMatchObject({ ok: true });
    expect(none.inserted[0].content_text).toBeNull();
    expect(reads).toBe(0);
  });
});

describe('코드 모양', () => {
  const src = readFileSync('src/lib/my-library.ts', 'utf8');
  it('찾기는 search_text를, 내용 글은 찾을 때만 읽고, 한 행을 다룰 때는 경로와 내용 글을 함께 읽는다', () => {
    expect(src).toContain("q.ilike('search_text', fileNamePattern(query))");
    expect(src).not.toContain("q.ilike('file_name'");
    expect(src).toContain('select(query ? `${COLUMNS}, content_text` : COLUMNS)');
    expect(src).toContain('const ROW_COLUMNS = `${COLUMNS}, storage_path, content_text, content_checked_at`;');
    expect(src).not.toContain('select(`${COLUMNS}, storage_path`)');
  });
  it('첨부는 읽어 둔 내용(loadExtract), 만든 파일은 원본을 다시 읽는다(readOriginalText — 스캔 PDF는 NODA로 보내지 않음)', () => {
    expect(src).toContain("const { loadExtract } = await import('@/lib/attachments/store');");
    expect(src).toContain("const { readOriginalText } = await import('@/lib/source-original');");
    expect(readFileSync('src/lib/source-original.ts', 'utf8')).toContain('parseScanned: async () => { throw new ScanSkipped(); }');
  });
  it('화면 — 찾을 때 안내를 보이고 맞은 자리를 칠한다', () => {
    const ui = readFileSync('src/components/files/MyLibrarySection.tsx', 'utf8');
    expect(ui).toContain('{query && <p className="mb-2 text-[13px] text-slate-500">{LIBRARY_CONTENT_SEARCH_NOTE}</p>}');
    expect(ui).toContain('<mark');
    expect(ui).toContain('이름이나 내용에 든 파일이 없습니다');
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0117 — 자료함 내용 칸(시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('여러 번 적용해도 안전·20,000자 CHECK·search_text는 이름 + 내용(이름을 바꾸면 따라 바뀜)·ilike로 찾힘', async () => {
    await db.query('BEGIN');
    try {
      const sql = readFileSync('supabase/migrations/0117_library_content_search.sql', 'utf8');
      await db.query(sql); await db.query(sql);
      const org = randomUUID(); const dept = randomUUID(); const user = randomUUID();
      await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [org, '0117 기관']);
      await db.query("INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, '총무과', $2, $3)", [dept, `d-${dept.slice(0, 8)}`, org]);
      await db.query("INSERT INTO users (id, email, role, department_id) VALUES ($1, $2, 'USER', $3)", [user, `${user}@x.test`, dept]);
      const file = (content: string | null) => db.query(
        "INSERT INTO my_library_files (user_id, organization_id, space, folder, file_name, size_bytes, storage_path, source, content_text) VALUES ($1, $2, 'personal', '', '서식.xlsx', 1, $3, 'attachment', $4) RETURNING id, search_text",
        [user, org, `my-library/${randomUUID()}`, content]);
      const a = await file('국외 출장 여비 기준');
      expect(a.rows[0].search_text).toBe('서식.xlsx 국외 출장 여비 기준');
      const b = await file(null);
      expect(b.rows[0].search_text).toBe('서식.xlsx ');
      // 0127이 CHECK를 100,000자로 넓혔다 — 시험 DB에는 둘 다 적용돼 있다
      await file('가'.repeat(LIBRARY_CONTENT_MAX));
      for (const bad of ['', '가'.repeat(LIBRARY_CONTENT_MAX + 1)]) {
        await db.query('SAVEPOINT s');
        await expect(file(bad)).rejects.toThrow(/check/i);
        await db.query('ROLLBACK TO SAVEPOINT s');
      }
      await db.query("UPDATE my_library_files SET file_name = '여비 규정.hwpx' WHERE id = $1", [b.rows[0].id]);
      const found = await db.query("SELECT id FROM my_library_files WHERE user_id = $1 AND search_text ILIKE '%여비%' ORDER BY id", [user]);
      expect(found.rows.map((r) => r.id).sort()).toEqual([a.rows[0].id, b.rows[0].id].sort());
      await db.query('SAVEPOINT g');
      await expect(db.query("UPDATE my_library_files SET search_text = 'x' WHERE id = $1", [a.rows[0].id])).rejects.toThrow(/generated|cannot|only be updated to DEFAULT/i);
      await db.query('ROLLBACK TO SAVEPOINT g');
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
