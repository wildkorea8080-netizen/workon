import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractRefs, missingRefs, readSource, selectColumns, sourceFiles } from './helpers/code-schema-refs';

/**
 * 2026-11-16 — 코드가 부르는 표·칸·함수가 마이그레이션에 있는가. `users.password_hash`는 코드가 읽고 썼는데 만드는 마이그레이션이 없었다
 * (운영에도 없어 비밀번호 바꾸기·재발급·찾기가 실패 — 0097). 시험 DB는 마이그레이션만으로 만드므로 거기에 없는 이름은 마이그레이션 없이 쓰는 이름이다.
 */

describe('어림 규칙', () => {
  it('select 글 — 내장 관계·별칭·*는 떼고 이 표의 칸만', () => {
    expect(selectColumns('id, email, password_hash')).toEqual(['id', 'email', 'password_hash']);
    expect(selectColumns('*, organizations(id, name, status)')).toEqual([]);
    expect(selectColumns('id, agents!inner(name, organization_id, deleted_at), file_name')).toEqual(['id', 'file_name']);
    expect(selectColumns('id, departments(name, organizations(name, type))')).toEqual(['id']);
    expect(selectColumns('count:id')).toEqual([]);
  });
  it('사슬 — select·필터의 칸, rpc, 다음 문장으로 넘어가지 않음', () => {
    const src = `
      const a = await db.from('users').select('id, password_hash').eq('email', e).maybeSingle();
      const b = await db.from('system_settings').select('value').eq('key', K).maybeSingle(),
        other.lt('next_run_at', x);
      await db.rpc('app_run_states', {});
    `;
    const names = extractRefs(src, 'f.ts').map((r) => `${r.kind}:${r.name}`);
    expect(names).toEqual([
      'function:app_run_states',
      'table:users', 'column:users.id', 'column:users.password_hash', 'column:users.email',
      'table:system_settings', 'column:system_settings.value', 'column:system_settings.key',
    ]);
  });
  it('내장 관계의 칸도 본다 — 별칭:외래키 중 표인 쪽으로(예전 security-logs의 users.name)', () => {
    const src = `db.from('security_logs').select('*, users:user_id (name, email), departments(name, organizations(type))')`;
    const schema = {
      columns: new Map([
        ['security_logs', new Set(['id'])],
        ['users', new Set(['id', 'full_name', 'email'])],
        ['departments', new Set(['id', 'name'])],
        ['organizations', new Set(['id', 'type'])],
      ]),
      functions: new Set<string>(),
    };
    expect(Array.from(missingRefs(extractRefs(src, 'x.ts'), schema).keys())).toEqual(['칸 users.name (내장 관계)']);
  });
  it('없는 이름만 모은다', () => {
    const schema = { columns: new Map([['users', new Set(['id', 'email'])]]), functions: new Set(['f']) };
    const refs = extractRefs(`db.from('users').select('id, password_hash'); db.from('security_logs').insert({}); db.rpc('g')`, 'x.ts');
    expect(Array.from(missingRefs(refs, schema).keys())).toEqual(['함수 g', '칸 users.password_hash', '표 security_logs']);
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('코드가 부르는 이름이 시험 DB(= 마이그레이션 전부)에 있다', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('src·scripts 전부', async () => {
    const columns = new Map<string, Set<string>>();
    const rows = await db.query(`SELECT c.relname t, a.attname col FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m') AND a.attnum > 0 AND NOT a.attisdropped`);
    for (const r of rows.rows) {
      if (!columns.has(r.t)) columns.set(r.t, new Set());
      columns.get(r.t)!.add(r.col);
    }
    const functions = new Set<string>((await db.query(`SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`)).rows.map((r) => r.proname));
    const files = sourceFiles(['src', 'scripts']);
    const refs = files.flatMap((f) => extractRefs(readSource(f), f));
    expect(refs.length).toBeGreaterThan(500); // 어림이 아무것도 못 찾는 쪽으로 깨지지 않았는가
    const missing = Object.fromEntries(missingRefs(refs, { columns, functions }));
    expect(missing, '마이그레이션 없이 쓰는 이름 — 그 칸·표·함수를 만드는 마이그레이션을 더하세요').toEqual({});
  });
});
