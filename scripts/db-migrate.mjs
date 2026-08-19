/**
 * 마이그레이션을 DB에 직접 적용한다.
 *
 *   npm run db:migrate                     -- 미적용 마이그레이션 전부
 *   npm run db:migrate -- 0019             -- 번호로 하나만
 *   npm run db:migrate -- --dry            -- 무엇이 적용될지만 보기
 *
 * SQL Editor에 붙여넣는 방식은 파일이 길면 일부만 복사되거나, 편집기에
 * 선택 영역이 남아 있으면 그 부분만 실행된다. 실제로 0013~0017과 0019가
 * 그렇게 누락됐고 매번 "적용했다"고 믿은 채 다음 단계로 넘어갔다.
 * 여기서는 파일을 통째로 읽어 한 트랜잭션으로 실행하고, 실패하면 되돌린다.
 *
 * DATABASE_URL이 필요하다 (Supabase 대시보드 → Settings → Database →
 * Connection string → URI). service role key로는 DDL을 실행할 수 없다.
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.trimStart().startsWith('#')) {
      const k = line.slice(0, eq).trim();
      if (!process.env[k]) process.env[k] = line.slice(eq + 1).trim();
    }
  }
}

// 이름을 헷갈려 넣는 경우가 많아 몇 가지를 함께 받는다.
const URL_KEYS = ['DATABASE_URL', 'POSTGRES_URL', 'SUPABASE_DB_URL'];
const foundKey = URL_KEYS.find((k) => process.env[k]);
const url = foundKey ? process.env[foundKey] : null;

const HOWTO = `
  1. Supabase 대시보드 → 프로젝트 → Settings → Database
  2. 'Connection string' 에서 Session pooler 탭 → URI 복사
     (Transaction pooler(6543)는 DDL에 적합하지 않습니다. 5432를 쓰세요)
  3. [YOUR-PASSWORD] 자리에 DB 비밀번호를 넣습니다
     기억나지 않으면 같은 화면에서 'Reset database password'로 재설정
  4. .env.local에 아래 한 줄 추가

     DATABASE_URL=postgresql://postgres.프로젝트ref:비밀번호@aws-0-리전.pooler.supabase.com:5432/postgres

  .env.local은 gitignore 대상이라 커밋되지 않습니다.`;

if (!url) {
  // https:// 주소를 넣어 둔 경우를 짚어 준다. 흔한 혼동이다.
  const apiUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  console.error(`
DB 접속 문자열이 없습니다. (${URL_KEYS.join(' / ')} 중 하나)
${apiUrl ? `
  SUPABASE_URL은 https:// 로 시작하는 API 주소라 여기에 쓸 수 없습니다.
  DDL 실행에는 postgresql:// 로 시작하는 Postgres 접속 문자열이 필요합니다.
` : ''}${HOWTO}
`);
  process.exit(1);
}

// 예시 문자열을 그대로 붙여넣는 일이 잦다. 접속을 시도하기 전에 잡는다.
const PLACEHOLDERS = ['리전', '비밀번호', '프로젝트ref', 'YOUR-PASSWORD', 'xxxx', '[', ']'];
const leftover = PLACEHOLDERS.filter((t) => url.includes(t));
if (leftover.length > 0) {
  console.error(`
${foundKey} 에 예시 문자열이 남아 있습니다: ${leftover.join(', ')}

  안내문의 예시가 아니라 대시보드에서 복사한 실제 URI를 넣어야 합니다.
  실제 값은 이런 형태입니다(리전·프로젝트 ref가 채워져 있습니다):

    postgresql://postgres.abcdefghijklmnop:실제비밀번호@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres

  Settings → Database → Connection string → Connection Method를
  'Session pooler'로 바꾼 뒤 Type: URI 를 복사하세요.
  복사한 문자열에서 [YOUR-PASSWORD] 부분만 비밀번호로 바꾸면 됩니다(대괄호도 지웁니다).
`);
  process.exit(1);
}

if (!/^postgres(ql)?:\/\//.test(url)) {
  console.error(`
${foundKey} 값이 Postgres 접속 문자열이 아닙니다.

  받은 형태 : ${url.split('://')[0]}://...
  필요한 형태: postgresql://...
${HOWTO}
`);
  process.exit(1);
}

const MIGRATIONS_DIR = 'supabase/migrations';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const only = args.find((a) => /^\d{4}$/.test(a));
// 이미 손으로 적용해 둔 마이그레이션을 '실행하지 않고' 기록만 한다.
const baselineIdx = args.indexOf('--baseline');
const baseline = baselineIdx >= 0 ? args[baselineIdx + 1] : null;

const { default: pg } = await import('pg');

// Supabase 풀러는 TLS를 쓰지만 인증서 체인이 로컬에 없을 수 있다.
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
} catch (err) {
  const code = err.code ?? '';
  console.error(`\n접속 실패: ${err.message}`);

  // Direct connection은 IPv6다. 국내 IPv4 전용 환경에서 흔히 여기서 막힌다.
  if (['ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'ENOENT', 'EAI_AGAIN'].includes(code)) {
    console.error(`
  Direct connection은 IPv6로 접속합니다. IPv4만 되는 환경이면 닿지 않습니다.
  대시보드에서 Connection Method를 'Session pooler'로 바꿔 URI를 다시 복사하세요.
  (주소가 db.xxx.supabase.co 가 아니라 aws-0-리전.pooler.supabase.com 형태가 됩니다)`);
  } else if (code === '28P01' || /password authentication/i.test(err.message)) {
    console.error(`
  비밀번호가 맞지 않습니다.
  - [YOUR-PASSWORD] 자리를 실제 비밀번호로 바꿨는지 확인하세요(대괄호도 지웁니다)
  - 비밀번호에 @ # ? / % : 가 있으면 percent-encode 해야 합니다
    (@ → %40, # → %23, ? → %3F, / → %2F, % → %25, : → %3A)
  - 기억나지 않으면 Settings → Database → Reset database password`);
  } else if (code === 'ETIMEDOUT') {
    console.error(`
  응답이 없습니다. 방화벽이 5432 포트를 막고 있을 수 있습니다.
  사내망이라면 Session pooler(5432) 또는 Transaction pooler(6543)를 시도해 보세요.`);
  }

  console.error('');
  process.exit(1);
}

/** 적용 이력 표. 없으면 만든다. */
await client.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    text PRIMARY KEY,
    filename   text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`);

const { rows: applied } = await client.query('SELECT version FROM schema_migrations');
const appliedSet = new Set(applied.map((r) => r.version));

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

// ── 베이스라인 ──────────────────────────────────────────────
// 이 스크립트를 도입하기 전에 손으로 적용한 것들이 있다. 기록이 없다고
// 0001_init부터 다시 돌리면 기존 데이터가 위험하다.
if (baseline) {
  if (!/^\d{4}$/.test(baseline)) {
    console.error('--baseline 뒤에는 네 자리 번호를 주세요. 예: --baseline 0018');
    await client.end();
    process.exit(1);
  }
  const upto = files.filter((f) => f.slice(0, 4) <= baseline);
  for (const f of upto) {
    await client.query(
      `INSERT INTO schema_migrations (version, filename) VALUES ($1, $2)
       ON CONFLICT (version) DO NOTHING`,
      [f.slice(0, 4), f]
    );
  }
  console.log(`${upto.length}건을 '적용됨'으로 기록했습니다 (실행하지 않음).`);
  console.log(`마지막: ${upto[upto.length - 1] ?? '(없음)'}`);
  await client.end();
  process.exit(0);
}

// 기록이 비어 있는데 전체 실행을 요청하면 0001_init까지 다시 돌게 된다.
// 그건 사고다. 무엇을 이미 적용했는지 먼저 말하게 한다.
if (appliedSet.size === 0 && !only) {
  console.error(`
적용 이력이 비어 있습니다.

이 상태로 전부 실행하면 0001_init부터 다시 돌아 기존 데이터가 위험합니다.
이미 손으로 적용해 둔 것이 있으면 먼저 기준선을 기록하세요.

  npm run db:migrate -- --baseline 0018     (0001~0018을 적용됨으로 기록)
  npm run db:migrate                        (그다음 0019부터 적용)

특정 파일 하나만 강제로 실행하려면 번호를 직접 주세요.

  npm run db:migrate -- 0019
`);
  await client.end();
  process.exit(1);
}

const pending = files.filter((f) => {
  const version = f.slice(0, 4);
  if (only) return version === only;
  return !appliedSet.has(version);
});

if (pending.length === 0) {
  console.log(only ? `${only} 파일을 찾지 못했습니다.` : '적용할 마이그레이션이 없습니다.');
  await client.end();
  process.exit(only ? 1 : 0);
}

console.log(`대상 ${pending.length}건:`);
for (const f of pending) {
  const version = f.slice(0, 4);
  console.log(`  ${appliedSet.has(version) ? '재적용' : '신규  '}  ${f}`);
}

if (dryRun) {
  console.log('\n--dry 이므로 실행하지 않았습니다.');
  await client.end();
  process.exit(0);
}

console.log('');

for (const filename of pending) {
  const version = filename.slice(0, 4);
  const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');

  // 한 파일을 한 트랜잭션으로 묶는다. 중간에 실패하면 그 파일은 통째로
  // 되돌아간다 — 절반만 적용돼 다음에 무엇이 남았는지 모르는 상태를 막는다.
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      `INSERT INTO schema_migrations (version, filename) VALUES ($1, $2)
       ON CONFLICT (version) DO UPDATE SET filename = EXCLUDED.filename, applied_at = now()`,
      [version, filename]
    );
    await client.query('COMMIT');
    console.log(`OK    ${filename}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`실패  ${filename}`);
    console.error(`      ${err.message}`);
    if (err.position) {
      // 오류 위치를 줄 번호로 바꿔 준다. 문자 위치만으로는 못 찾는다.
      const upto = sql.slice(0, Number(err.position));
      const line = upto.split('\n').length;
      console.error(`      ${filename}:${line} 부근`);
    }
    console.error('\n이 파일은 되돌렸습니다. 원인을 고친 뒤 다시 실행하세요.');
    await client.end();
    process.exit(1);
  }
}

await client.end();
console.log('\n완료. 확인: npm run db:check');
