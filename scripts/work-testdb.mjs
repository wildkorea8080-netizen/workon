/**
 * 로컬 시험용 PostgreSQL (WORKON 개편 P1) — 운영 DB를 시험 자료로 쓰지 않으려고 만든다.
 *
 *   npm run work:testdb -- start     -- 임시 폴더에 클러스터를 만들고(처음 한 번) 54329번에서 띄운 뒤 마이그레이션 전부 적용
 *   npm run work:testdb -- reset     -- DB를 지우고 다시 만들어 마이그레이션 전부 적용
 *   npm run work:testdb -- stop
 *
 * 이 PC에 설치된 PostgreSQL 바이너리(initdb·pg_ctl)만 쓴다 — 설치된 서비스·비밀번호는 건드리지 않는다.
 * 클러스터는 OS 임시 폴더(workon-testdb)에 trust 인증, localhost만 듣는다.
 *
 * **옛 벡터 칸만 바꿔 적용한다**: pgvector가 없는 PC라 `vector(N)` 칸을 text로, ivfflat 색인을 빼고,
 * 함수 본문 검사를 끈다(check_function_bodies=off — 옛 검색 RPC가 `<=>`를 쓴다). 새 업무 표(0034~)는 그대로 적용된다.
 * 접속 문자열은 WORK_TEST_DATABASE_URL로 시험(tests/work-db.test.ts)에 넘긴다.
 */
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import pg from 'pg';

const PORT = Number(process.env.WORK_TEST_DB_PORT || 54329);
const DB = 'workon_test';
const dataDir = path.join(tmpdir(), 'workon-testdb');
const binCandidates = [process.env.PG_BIN, 'C:/Program Files/PostgreSQL/17/bin', 'C:/Program Files/PostgreSQL/16/bin'].filter(Boolean);
const bin = binCandidates.find((d) => existsSync(path.join(d, process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl')));
if (!bin) {
  console.error('PostgreSQL 바이너리를 찾지 못했습니다 — PG_BIN에 bin 폴더를 주세요.');
  process.exit(1);
}
const run = (exe, args) => spawnSync(path.join(bin, exe), args, { encoding: 'utf8' });
export const TEST_URL = `postgresql://postgres@localhost:${PORT}/${DB}`;

function ensureCluster() {
  if (existsSync(path.join(dataDir, 'PG_VERSION'))) return;
  mkdirSync(dataDir, { recursive: true });
  const r = run('initdb', ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=C']);
  if (r.status !== 0) throw new Error(`initdb 실패: ${r.stderr}`);
}

function isRunning() {
  return run('pg_ctl', ['status', '-D', dataDir]).status === 0;
}

function start() {
  ensureCluster();
  if (isRunning()) return;
  // 출력 관을 물려 주면 띄운 서버가 관을 잡고 있어 spawnSync가 끝나지 않는다(Windows) — 버리고 로그 파일로 본다
  const r = spawnSync(path.join(bin, 'pg_ctl'), ['start', '-w', '-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-o', `-p ${PORT} -c listen_addresses=localhost`], { stdio: 'ignore' });
  if (r.status !== 0) throw new Error(`pg_ctl start 실패 — ${path.join(dataDir, 'server.log')}를 보세요`);
}

/** 옛 벡터 칸만 바꾼다 — 그 밖의 SQL은 그대로 */
export function shimLegacyVector(sql) {
  return sql
    .replace(/create extension if not exists vector;/gi, '-- (시험 DB) pgvector 없음')
    .replace(/^.*using ivfflat.*$/gim, '-- (시험 DB) ivfflat 색인 뺌')
    .replace(/\bvector\(\d+\)/g, 'text');
}

/**
 * 저장소 마이그레이션으로는 생기지 않지만 운영 DB에는 있는 칸 — 그 칸을 처음 쓰는 마이그레이션 앞에 넣는다.
 * (운영 DB를 대시보드에서 손댄 흔적. 찾은 것은 docs/workon-rebuild/IMPLEMENTATION_STATUS.md '발견'에 적는다)
 */
const DRIFT = {
  '0019_agent_catalog.sql':
    'ALTER TABLE agents ADD COLUMN IF NOT EXISTS icon text, ADD COLUMN IF NOT EXISTS color text, ' +
    'ADD COLUMN IF NOT EXISTS usage_guide text, ADD COLUMN IF NOT EXISTS starter_prompts text[];',
};

async function migrate() {
  const admin = new pg.Client({ connectionString: `postgresql://postgres@localhost:${PORT}/postgres` });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB}`);
  await admin.end();

  const client = new pg.Client({ connectionString: TEST_URL });
  await client.connect();
  await client.query('SET check_function_bodies = off');
  // Supabase가 미리 만들어 두는 역할 — 마이그레이션의 GRANT·RLS 시험에 쓴다
  await client.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  END $$`);
  const dir = path.join(process.cwd(), 'supabase', 'migrations');
  const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  for (const f of files) {
    try {
      await client.query('BEGIN');
      if (DRIFT[f]) await client.query(DRIFT[f]);
      await client.query(shimLegacyVector(readFileSync(path.join(dir, f), 'utf8')));
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      await client.end();
      throw new Error(`${f} 적용 실패: ${e.message}`);
    }
  }
  // Supabase는 public 표를 anon·authenticated에 기본 GRANT한다 — 같은 조건에서 RLS가 막는지 본다
  await client.query('GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role');
  await client.query('GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role');
  await client.end();
  return files.length;
}

const cmd = process.argv[2] || 'start';
try {
  if (cmd === 'stop') {
    if (isRunning()) run('pg_ctl', ['stop', '-D', dataDir, '-m', 'fast']);
    console.log('멈춤');
  } else if (cmd === 'start' || cmd === 'reset') {
    start();
    const n = await migrate();
    console.log(`시험 DB 준비됨 — 마이그레이션 ${n}개 적용\nWORK_TEST_DATABASE_URL=${TEST_URL}`);
  } else {
    console.error('사용법: npm run work:testdb -- start | reset | stop');
    process.exit(1);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
