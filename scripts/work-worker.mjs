/**
 * 업무 작업자 — 계속 돌며 대기 실행을 처리한다 (WORKON 개편 P1, ADR 0003).
 *
 *   npm run work:worker                       -- .env.local의 DATABASE_URL(Postgres 직결) + Supabase Storage
 *   npm run work:worker -- --once             -- 한 바퀴만
 *   npm run work:worker -- --local-files 폴더  -- 저장소 대신 로컬 폴더(시험 DB와 함께)
 *   npm run work:worker -- --hancom           -- (Windows·한글 설치 PC) 한글로 실제 파일 미리보기(PDF)를 만든다
 *
 * 브라우저가 닫혀도·서버 함수가 끊겨도 실행이 이어지게 하는 작업자 중 하나다(나머지: /api/work/worker 예약 호출, 화면의 execute).
 * 실행 행의 lease로 여러 작업자가 같이 돌아도 한 실행은 한 곳만 처리한다. Ctrl+C면 지금 실행을 끝낸 뒤 멈춘다.
 * 출력에는 실행 id·결과만(본문·키·서명 주소 없음).
 */
import { existsSync, readFileSync } from 'fs';
import pg from 'pg';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.trimStart().startsWith('#')) {
      const k = line.slice(0, eq).trim();
      if (!process.env[k]) process.env[k] = line.slice(eq + 1).trim();
    }
  }
}

const args = process.argv.slice(2);
const once = args.includes('--once');
const localIdx = args.indexOf('--local-files');
const localFiles = localIdx >= 0 ? args[localIdx + 1] : null;
const dbUrl = process.env.WORK_DATABASE_URL || process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL(또는 WORK_DATABASE_URL)이 없습니다 — Postgres 직결 주소가 필요합니다.');
  process.exit(1);
}

const { createPgWorkStore } = await import('../src/lib/work/store/pg.ts');
const files = await import('../src/lib/work/files.ts');
const { llmGenerator, mockGenerator } = await import('../src/lib/work/generation/compose.ts');
const { getRenderer, setRenderer } = await import('../src/lib/work/documents/renderer.ts');
const { runWorker, newWorkerId } = await import('../src/lib/work/runs/worker.ts');
const { resolveModelForDepartment } = await import('../src/lib/model-policy.ts');
const { checkTokenLimit, limitMessage } = await import('../src/lib/usage-limit.ts');
const { WORK_GENERATOR } = await import('../src/lib/config.ts');

if (args.includes('--hancom')) {
  const { hancomRenderer } = await import('./work-hancom-renderer.mjs');
  setRenderer(hancomRenderer);
}

const pool = new pg.Pool({ connectionString: dbUrl, max: 3 });
const ctx = {
  store: createPgWorkStore(pool),
  files: localFiles ? files.createLocalWorkFiles(localFiles) : files.createSupabaseWorkFiles(),
  generator: WORK_GENERATOR === 'mock' ? mockGenerator : llmGenerator,
  generatorMode: WORK_GENERATOR,
  renderer: getRenderer(),
  resolveModel: (d) => resolveModelForDepartment(d),
  checkLimit: async (d, u) => {
    const s = await checkTokenLimit(d, u);
    return s.allowed ? { allowed: true } : { allowed: false, message: limitMessage(s) };
  },
  log: async (p) => console.error(`[${p.level}] ${p.message}`, p.details ? JSON.stringify(p.details).slice(0, 300) : ''),
  now: () => new Date(),
};

const workerId = newWorkerId('local');
let stopping = false;
process.on('SIGINT', () => {
  stopping = true;
  console.log('\n지금 실행을 끝낸 뒤 멈춥니다…');
});

console.log(`작업자 ${workerId} 시작 — 생성기 ${ctx.generatorMode}, 렌더러 ${ctx.renderer.name}${localFiles ? ', 로컬 파일' : ''}`);
do {
  const out = await runWorker(ctx, { workerId, limit: 5, budgetMs: 120_000 });
  for (const o of out) console.log(`${new Date().toISOString()} ${o.runId} → ${o.finish}${o.error ? ` (${o.error.code})` : ''}`);
  if (!out.length && !once) await new Promise((r) => setTimeout(r, 3000));
} while (!once && !stopping);
await pool.end();
