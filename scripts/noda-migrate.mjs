/**
 * 기존 참고 문서를 NODA로 옮긴다 (S4-a).
 *
 *   npm run noda:migrate              -- 옮기기 전(noda_status NULL) 문서를 차례로 NODA에 읽힌다
 *   npm run noda:migrate -- --dry-run -- 대상 수만 보기
 *
 * 배포 순서(CLAUDE.md): 마이그레이션 0031 → 코드 푸시(배포 확인) → 이 스크립트.
 * 새 코드가 돈 뒤에 옮긴다 — 옛 코드는 문서를 지울 때 NODA 사본을 지우지 않아, 먼저 옮기면
 * 배포 전까지 지운 문서가 NODA에 고아로 남는다. 푸시 뒤 이 스크립트까지는 옛 문서(noda_status NULL)가
 * 근거로 쓰이지 않으니(비서는 문서 없이 답함) 바로 이어서 돌린다.
 * NODA_API_KEY가 .env.local에 있어야 한다.
 * 여러 번 돌려도 안전하다 — 이미 옮긴 문서(noda_status가 있는 행)는 대상이 아니다.
 * 읽지 못한 문서(failed)는 문서 화면의 '다시 시도'로 다시 읽힌다.
 *
 * 비서가 없는 문서(agent_id NULL)는 NODA 보관함(= 비서)이 없어 건너뛴다. 세어서 알려 줄 뿐이다.
 *
 * 출력에는 키·DATABASE_URL·파일 이름을 싣지 않는다. 문서는 id 앞 8자로만 가리킨다.
 */
import { existsSync, readFileSync } from 'fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.trimStart().startsWith('#')) {
      const k = line.slice(0, eq).trim();
      if (!process.env[k]) process.env[k] = line.slice(eq + 1).trim();
    }
  }
}
// config.ts가 import 시점에 필수 환경변수를 검사한다. 이 스크립트에는 없어도 되는 것들을 채운다.
// (Supabase 값은 채우지 않는다 — 진짜 DB에 써야 하므로 .env.local에 있어야 한다.)
for (const k of ['NEXTAUTH_URL', 'NEXTAUTH_SECRET', 'VOYAGE_API_KEY', 'ANTHROPIC_API_KEY']) {
  if (!process.env[k]) process.env[k] = 'noda-migrate-placeholder';
}

const dryRun = process.argv.includes('--dry-run');

if (!dryRun && !process.env.NODA_API_KEY) {
  console.error('NODA_API_KEY가 없습니다 — .env.local에 넣은 뒤 다시 실행하세요.');
  process.exit(1);
}

const { supabaseAdmin } = await import('../src/lib/supabaseAdmin.ts');
const { nodaFilename } = await import('../src/lib/noda.ts');
const { readDocument, startReadingFields } = await import('../src/lib/document-reading.ts');

const STATUS_LABELS = {
  ready: '읽기 끝',
  unreadable: '읽을 수 없는 문서 — 이유는 문서 화면에서',
  failed: '읽기 실패 — 문서 화면에서 다시 시도',
  reading: 'NODA 호출이 닿지 않음 — 문서 화면을 열면 이어서 읽음',
  busy: '다른 곳에서 읽는 중',
  deleting: '삭제 대기',
  not_found: '문서를 찾을 수 없음',
};

const short = (id) => String(id).slice(0, 8);

async function main() {
  const { data: targets, error } = await supabaseAdmin
    .from('documents')
    .select('id, agent_id, file_name, created_at')
    .not('agent_id', 'is', null)
    .is('noda_status', null)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`문서 조회 실패: ${error.message}`);

  const { count: noAgent, error: countError } = await supabaseAdmin
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .is('agent_id', null)
    .is('noda_status', null);
  if (countError) throw new Error(`비서 없는 문서 수 조회 실패: ${countError.message}`);

  console.log(`옮길 문서 ${targets.length}건 · 비서 없음 — 건너뜀 ${noAgent ?? 0}건`);
  if (dryRun) {
    console.log('(--dry-run — 아무것도 바꾸지 않았습니다)');
    return;
  }

  const tally = {};
  for (const t of targets) {
    const label = short(t.id);
    try {
      // 읽는 중으로 바꾼다 — 조건부(noda_status NULL)라 다른 곳에서 먼저 옮긴 행은 건드리지 않는다
      const { data: claimed, error: updateError } = await supabaseAdmin
        .from('documents')
        .update({ noda_filename: nodaFilename(t.id, t.file_name), ...startReadingFields(new Date()) })
        .eq('id', t.id)
        .is('noda_status', null)
        .select('id');
      if (updateError) throw new Error(`행 갱신 실패: ${updateError.message}`);
      if (!claimed || claimed.length === 0) {
        console.log(`${label} · 건너뜀 · 이미 옮겨졌습니다`);
        tally.skipped = (tally.skipped ?? 0) + 1;
        continue;
      }

      const outcome = await readDocument(t.id);
      tally[outcome.status] = (tally[outcome.status] ?? 0) + 1;
      // NODA가 준 이유에는 파일 이름이 섞일 수 있어 찍지 않는다 — 이유는 DB·문서 화면에 있다
      console.log(`${label} · ${outcome.status} · ${STATUS_LABELS[outcome.status] ?? '확인 필요'}`);
    } catch {
      tally.error = (tally.error ?? 0) + 1;
      // 오류 글은 찍지 않는다 — DB·NODA 오류 글에 파일 이름·경로가 섞일 수 있다(NODA 호출 실패는 system_logs에 남는다)
      console.log(`${label} · 오류 · 이 문서를 옮기지 못했습니다 — 다시 실행하세요`);
    }
  }

  console.log(`\n===== 결과 =====`);
  for (const [status, n] of Object.entries(tally)) console.log(`  ${status.padEnd(12)} ${n}건`);
  if (tally.reading || tally.busy || tally.error || tally.failed) {
    console.log(
      "\n'reading'은 NODA 호출이 닿지 않은 문서입니다 — 문서 화면을 열면 이어서 읽습니다. 'failed'·'unreadable'은 이유를 보고 문서 화면에서 다시 시도하세요.",
    );
  }
  // reading·busy는 아직 끝나지 않은 문서라 운영자가 확인해야 한다(문서 화면을 열면 이어서 읽는다)
  if (tally.error || tally.reading || tally.busy) process.exit(1);
}

main().catch((e) => {
  console.error('실패:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
