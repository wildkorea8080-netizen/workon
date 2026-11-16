import { readFileSync } from 'fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SNAPSHOT_SQL, diffSchemas, formatDrift, hasBlockingDrift, toSnapshot, type SchemaSnapshot } from '@/lib/schema-drift';

/** 2026-11-16 — 운영 DB 스키마와 마이그레이션의 어긋남 찾기(`npm run db:drift`). 0097에서 찾은 빈자리가 다시 숨지 않게 */

const base = (): SchemaSnapshot => ({
  relations: { users: 'table', security_logs: 'table', v_summary: 'view' },
  columns: [
    { table: 'users', column: 'id', type: 'uuid', nullable: false },
    { table: 'users', column: 'password_hash', type: 'text', nullable: true },
    { table: 'security_logs', column: 'id', type: 'uuid', nullable: false },
    { table: 'documents', column: 'embedding', type: 'text', nullable: true },
  ],
  functions: ['app_run_states(uuid[], timestamp with time zone, integer)', 'search_agent_chunks(text, uuid)'],
  rlsOff: [],
});

describe('맞대기', () => {
  it('같으면 어긋남 없음', () => {
    const d = diffSchemas(base(), base());
    expect(hasBlockingDrift(d)).toBe(false);
    expect(formatDrift(d)).toContain('마이그레이션에 있는데 대상에 없는 칸: 없음');
  });
  it('0097 전 운영 꼴 — 빠진 칸·표를 찾는다(표가 통째로 없으면 칸은 다시 적지 않음)', () => {
    const target = base();
    delete target.relations.security_logs;
    target.columns = target.columns.filter((c) => c.column !== 'password_hash' && c.table !== 'security_logs');
    const d = diffSchemas(base(), target);
    expect(d.missingRelations).toEqual(['security_logs']);
    expect(d.missingColumns).toEqual(['users.password_hash']);
    expect(hasBlockingDrift(d)).toBe(true);
  });
  it('형식·NULL 허용 차이, 함수 빠짐, RLS 꺼짐은 막는 어긋남', () => {
    const target = base();
    target.columns = target.columns.map((c) => (c.column === 'password_hash' ? { ...c, type: 'character varying', nullable: false } : c));
    target.functions = target.functions.slice(1);
    target.rlsOff = ['users'];
    const d = diffSchemas(base(), target);
    expect(d.columnMismatches).toEqual(['users.password_hash: 형식 text → character varying, NULL 허용 → NOT NULL']);
    expect(d.missingFunctions).toEqual(['app_run_states(uuid[], timestamp with time zone, integer)']);
    expect(d.rlsOff).toEqual(['users']);
    expect(hasBlockingDrift(d)).toBe(true);
  });
  it('시험 DB의 vector→text 바꿈은 어긋남이 아니다(칸·함수 인자)', () => {
    const target = base();
    target.columns = target.columns.map((c) => (c.column === 'embedding' ? { ...c, type: 'vector' } : c));
    target.functions = target.functions.map((f) => f.replace('search_agent_chunks(text', 'search_agent_chunks(vector'));
    expect(hasBlockingDrift(diffSchemas(base(), target))).toBe(false);
  });
  it('대상에만 있는 것은 정보(막지 않음) — 대상에만 있는 표의 칸은 칸 목록에 다시 적지 않음', () => {
    const target = base();
    target.relations.dash_made = 'table';
    target.columns.push({ table: 'dash_made', column: 'x', type: 'int4', nullable: true }, { table: 'users', column: 'icon', type: 'text', nullable: true });
    target.functions.push('extra_fn()');
    const d = diffSchemas(base(), target);
    expect(d.extraRelations).toEqual(['dash_made']);
    expect(d.extraColumns).toEqual(['users.icon']);
    expect(d.extraFunctions).toEqual(['extra_fn()']);
    expect(hasBlockingDrift(d)).toBe(false);
  });
  it('toSnapshot은 무시할 표를 뺀다(schema_migrations)', () => {
    const s = toSnapshot({
      relations: [{ name: 'users', kind: 'table' }, { name: 'schema_migrations', kind: 'table' }, { name: 'v', kind: 'view' }],
      columns: [{ table: 'schema_migrations', column: 'version', type: 'text', nullable: false }],
      functions: [{ sig: 'f()' }],
      rlsOff: [{ name: 'schema_migrations' }],
    }, ['schema_migrations']);
    expect(s).toEqual({ relations: { users: 'table', v: 'view' }, columns: [], functions: ['f()'], rlsOff: [] });
  });
  it('잎 파일·명령 등록·읽기 전용', () => {
    expect(readFileSync('src/lib/schema-drift.ts', 'utf8')).not.toMatch(/^import /m);
    expect(JSON.parse(readFileSync('package.json', 'utf8')).scripts['db:drift']).toBe('tsx scripts/db-drift.mjs');
    const script = readFileSync('scripts/db-drift.mjs', 'utf8');
    expect(script).toContain("await client.query('BEGIN READ ONLY')");
    expect(script).toContain("await client.query('ROLLBACK')");
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('스냅숏 질의 (시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('실제 DB에서 읽고 자기 자신과 맞대면 어긋남 없음, 0097 칸·표가 보인다', async () => {
    const q = async (sql: string) => (await db.query(sql)).rows;
    const snap = toSnapshot({
      relations: await q(SNAPSHOT_SQL.relations),
      columns: await q(SNAPSHOT_SQL.columns),
      functions: await q(SNAPSHOT_SQL.functions),
      rlsOff: await q(SNAPSHOT_SQL.rlsOff),
    }, ['schema_migrations']);
    expect(snap.relations.security_logs).toBe('table');
    expect(snap.columns).toContainEqual({ table: 'users', column: 'password_hash', type: 'text', nullable: true });
    expect(snap.functions.some((f) => f.startsWith('app_run_states('))).toBe(true);
    expect(hasBlockingDrift(diffSchemas(snap, snap))).toBe(false);
  });
});
