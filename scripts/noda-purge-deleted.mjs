/**
 * 이미 지운 비서의 NODA 보관함을 비운다 (2026-10-24).
 *
 *   npm run noda:purge-deleted          -- 대상만 보기(아무것도 바꾸지 않음)
 *   npm run noda:purge-deleted -- --yes -- 실제로 비우기
 *
 * 2026-10-24 전의 비서 지우기는 문서 행과 저장소 원본만 지우고 NODA 사본은 남겼다(숨긴 비서의 보관함은 부르는 곳이 없어 영영 남는다).
 * 지금 코드는 비서를 지울 때 보관함을 통째로 비운다(`removeAgentDocuments`). 이 스크립트는 그 전에 지운 비서들에
 * 같은 정리를 한 번 돌린다 — 보관함 비우기 → 남은 문서 행 → 저장소 원본. 비서를 지울 때 NODA를 못 비워
 * `deleting`으로 남은 행도 함께 치운다. 여러 번 돌려도 안전하다(이미 빈 보관함은 404 = 지운 것).
 *
 * **되돌릴 수 없다**(NODA 사본은 지우면 다시 읽혀야 생긴다 — 지운 비서라 다시 쓸 일은 없다). 실서버 데이터라 사용자가 직접 실행한다.
 * NODA_API_KEY와 Supabase 값이 .env.local에 있어야 한다.
 * 출력에는 키·DATABASE_URL·파일 이름을 싣지 않는다. 비서는 id 앞 8자로만 가리킨다.
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
for (const k of ['NEXTAUTH_URL', 'NEXTAUTH_SECRET', 'ANTHROPIC_API_KEY']) {
  if (!process.env[k]) process.env[k] = 'noda-purge-placeholder';
}

const apply = process.argv.includes('--yes');

if (!process.env.NODA_API_KEY) {
  console.error('NODA_API_KEY가 없습니다 — .env.local에 넣은 뒤 다시 실행하세요.');
  process.exit(1);
}

const { supabaseAdmin } = await import('../src/lib/supabaseAdmin.ts');
const { noda, nodaTenant } = await import('../src/lib/noda.ts');
const { removeAgentDocuments } = await import('../src/lib/agent-documents.ts');

const short = (id) => String(id).slice(0, 8);

async function main() {
  const { data: agents, error } = await supabaseAdmin
    .from('agents')
    .select('id, deleted_at')
    .not('deleted_at', 'is', null)
    .order('deleted_at', { ascending: true });
  if (error) throw new Error(`지운 비서 조회 실패: ${error.message}`);

  console.log(`지운 비서 ${agents.length}개`);
  let copies = 0;
  let rowsLeft = 0;
  let failed = 0;
  for (const a of agents) {
    const { count, error: countError } = await supabaseAdmin
      .from('documents')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', a.id);
    const rows = countError ? null : (count ?? 0);
    if (rows) rowsLeft += rows;

    if (!apply) {
      let inNoda = '?';
      try {
        const listing = await noda.listDocuments(nodaTenant(a.id), { retry: false });
        const n = listing.documents.length + listing.receiving.length;
        copies += n;
        inNoda = String(n);
      } catch (e) {
        inNoda = `확인 못 함(${e?.code ?? 'error'})`;
      }
      if (inNoda !== '0' || rows) console.log(`  ${short(a.id)}  NODA 사본 ${inNoda} · 남은 문서 행 ${rows ?? '확인 못 함'}`);
      continue;
    }

    const r = await removeAgentDocuments(a.id);
    if (!r.nodaCleared) failed += 1;
    if (!r.nodaCleared || r.removed || r.kept) {
      console.log(
        `  ${short(a.id)}  ${r.nodaCleared ? '보관함 비움' : 'NODA 실패 — 다시 실행하세요'} · 지운 행 ${r.removed}${r.kept ? ` · deleting으로 남김 ${r.kept}` : ''}`,
      );
    }
  }

  if (!apply) {
    console.log(`NODA 사본 ${copies}개 · 남은 문서 행 ${rowsLeft}건`);
    console.log('(아무것도 바꾸지 않았습니다 — 비우려면 -- --yes)');
    return;
  }
  console.log(failed ? `끝 — NODA를 못 비운 비서 ${failed}개(다시 실행하면 이어서 비움)` : '끝 — 모두 비웠습니다');
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`실패: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
