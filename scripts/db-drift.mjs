/**
 * 운영 DB 스키마와 저장소 마이그레이션의 어긋남 보기(2026-11-16) — `npm run db:drift`.
 *
 * 기준 = 시험 DB(`npm run work:testdb -- reset`으로 마이그레이션 전부를 적용한 것, WORK_TEST_DATABASE_URL 또는 기본 54329),
 * 대상 = DATABASE_URL(운영). 두 DB의 public 스키마(표·뷰·칸 형식/NULL·함수·RLS)를 **읽기 전용 트랜잭션**으로 읽어 맞댄다(`src/lib/schema-drift.ts`).
 * 행 값은 읽지 않는다. 대상에 없는 것·형식 다름·RLS 꺼짐이 있으면 종료 코드 1.
 *
 *   npm run db:drift                 -- 보고
 *   npm run db:drift -- --json       -- JSON으로
 *
 * 기준은 시험 DB이므로 **먼저 시험 DB를 마이그레이션 전부로 다시 만든다**(`npm run work:testdb -- reset`) — 시험이 덧붙인 것이 섞이지 않게.
 */
import { existsSync, readFileSync } from 'fs';
import pg from 'pg';
import { SNAPSHOT_SQL, diffSchemas, formatDrift, hasBlockingDrift, toSnapshot } from '../src/lib/schema-drift.ts';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.trimStart().startsWith('#')) {
      const k = line.slice(0, eq).trim();
      if (!process.env[k]) process.env[k] = line.slice(eq + 1).trim();
    }
  }
}

const targetUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_DB_URL;
const refUrl = process.env.WORK_TEST_DATABASE_URL || 'postgresql://postgres@localhost:54329/workon_test';
if (!targetUrl) {
  console.error('DATABASE_URL이 없습니다(.env.local).');
  process.exit(2);
}
if (/supabase\.(co|com)|pooler\./.test(refUrl)) {
  console.error('기준(WORK_TEST_DATABASE_URL)이 운영 DB 주소로 보입니다 — 시험 DB를 주세요.');
  process.exit(2);
}

// 마이그레이션 기록 표는 적용 도구가 만든다 — 비교에서 뺀다
const IGNORE = ['schema_migrations'];

async function snapshot(url, ssl) {
  const client = new pg.Client({ connectionString: url, ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}) });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const q = async (sql) => (await client.query(sql)).rows;
    const rows = {
      relations: await q(SNAPSHOT_SQL.relations),
      columns: await q(SNAPSHOT_SQL.columns),
      functions: await q(SNAPSHOT_SQL.functions),
      rlsOff: await q(SNAPSHOT_SQL.rlsOff),
    };
    await client.query('ROLLBACK');
    return toSnapshot(rows, IGNORE);
  } finally {
    await client.end();
  }
}

let ref;
try {
  ref = await snapshot(refUrl, false);
} catch (err) {
  console.error(`기준 시험 DB에 붙지 못했습니다(${err.code ?? err.message}) — npm run work:testdb -- start`);
  process.exit(2);
}
const target = await snapshot(targetUrl, true);
const drift = diffSchemas(ref, target);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(drift, null, 2));
} else {
  console.log(`기준(시험 DB): 표·뷰 ${Object.keys(ref.relations).length} · 칸 ${ref.columns.length} · 함수 ${ref.functions.length}`);
  console.log(`대상(운영 DB): 표·뷰 ${Object.keys(target.relations).length} · 칸 ${target.columns.length} · 함수 ${target.functions.length}\n`);
  console.log(formatDrift(drift));
}
process.exit(hasBlockingDrift(drift) ? 1 : 0);
