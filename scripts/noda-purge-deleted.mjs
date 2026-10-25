/**
 * NODA 보관함을 WORKON 장부와 맞대고, 지운 비서·DB에 없는 비서의 보관함을 비운다 (2026-10-24, `GET /tenants`로 넓힘 2026-10-26).
 *
 *   npm run noda:purge-deleted          -- 맞대 보기만(아무것도 바꾸지 않음)
 *   npm run noda:purge-deleted -- --yes -- 지운 비서·고아 보관함 비우기
 *
 * NODA `GET /tenants`(workon 키 — `workon`·`workon-…` 보관함만 보인다)로 보관함 목록·파일 수·읽는 중·실패·권한 상태와
 * 서비스 한도를 받고, 비서 보관함(`workon-a…`)을 DB의 비서와 맞대 가른다(`src/lib/noda-vaults.ts`):
 *   live(살아 있는 비서) · deleted(지운 비서) · orphan(DB에 행이 없는 비서) · common(공통 자료실) · other(`workon`·`workon-check` 등)
 * `--yes`면 deleted는 `removeAgentDocuments`(보관함 비우기 → 남은 문서 행 → 저장소 원본), orphan은 보관함만 비운다.
 * live·common·other는 건드리지 않는다(공통 자료실은 슈퍼관리자 화면에서 지운다).
 * 보관함이 이미 없어도 지운 비서에 문서 행이 남았으면 함께 치운다(비서를 지울 때 NODA를 못 비워 `deleting`으로 남은 행).
 * 권한 상태가 `broken`인 보관함은 규칙 파일이 깨져 **전부 잠긴** 것이라 경고한다(WORKON은 권한 규칙을 쓰지 않는다 — 나오면 이상 신호).
 * 여러 번 돌려도 안전하다(이미 빈 보관함은 404 = 지운 것).
 *
 * **되돌릴 수 없다**(NODA 사본은 지우면 다시 읽혀야 생긴다). 실서버 데이터라 사용자가 직접 실행한다.
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
const { noda, nodaErrorFields } = await import('../src/lib/noda.ts');
const { removeAgentDocuments } = await import('../src/lib/agent-documents.ts');
const { classifyVaults, agentIdsOf } = await import('../src/lib/noda-vaults.ts');

const short = (id) => String(id).slice(0, 8);
const mb = (b) => `${(b / 1024 / 1024).toFixed(1)}MB`;
const LABEL = { live: '살아 있는 비서', deleted: '지운 비서', orphan: 'DB에 없는 비서', common: '공통 자료실', other: '그 밖' };

function failReason(e) {
  const f = nodaErrorFields(e);
  return `${f.code}${f.status ? ` ${f.status}` : ''}${f.request_id ? ` · 요청 번호 ${f.request_id}` : ''}`;
}

async function main() {
  let listing;
  try {
    listing = await noda.listTenants();
  } catch (e) {
    console.error(`NODA 보관함 목록(GET /tenants)을 받지 못했습니다: ${failReason(e)}`);
    process.exit(1);
  }

  const ids = agentIdsOf(listing.tenants);
  const agents = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabaseAdmin.from('agents').select('id, deleted_at').in('id', ids.slice(i, i + 200));
    if (error) throw new Error(`비서 조회 실패: ${error.message}`);
    agents.push(...(data ?? []));
  }
  const rows = classifyVaults(listing.tenants, agents);

  // 보관함이 없어도 문서 행이 남은 지운 비서
  const { data: deletedAgents, error: delError } = await supabaseAdmin.from('agents').select('id').not('deleted_at', 'is', null);
  if (delError) throw new Error(`지운 비서 조회 실패: ${delError.message}`);
  const vaultAgentIds = new Set(rows.map((r) => r.agentId).filter(Boolean));
  const leftovers = [];
  for (const a of deletedAgents ?? []) {
    if (vaultAgentIds.has(a.id)) continue;
    const { count, error } = await supabaseAdmin.from('documents').select('id', { count: 'exact', head: true }).eq('agent_id', a.id);
    if (!error && count) leftovers.push({ id: a.id, rows: count });
  }

  const q = listing.quota;
  if (q) {
    const docs = q.max_documents ? `문서 ${q.used_documents ?? '?'} / ${q.max_documents}건(남은 ${q.remaining_documents ?? '?'})` : '';
    const bytes = q.max_bytes ? `용량 ${mb(q.used_bytes ?? 0)} / ${mb(q.max_bytes)}` : '';
    console.log(`NODA 한도: ${[docs, bytes].filter(Boolean).join(' · ') || '(정보 없음)'}${q.rate_per_minute ? ` · 분당 ${q.rate_per_minute}회` : ''}`);
  }
  const counts = {};
  for (const r of rows) counts[r.class] = (counts[r.class] ?? 0) + 1;
  console.log(`보관함 ${rows.length}개 — ${Object.entries(counts).map(([c, n]) => `${LABEL[c]} ${n}`).join(' · ') || '없음'}`);

  for (const r of rows.filter((r) => r.access === 'broken')) {
    console.log(`  경고: ${r.tenant.slice(0, 16)}… 권한 규칙이 깨져 보관함 전체가 잠겼습니다(access=broken)`);
  }
  const busy = rows.filter((r) => r.receiving > 0 || r.failed > 0);
  for (const r of busy) {
    console.log(`  ${r.agentId ? short(r.agentId) : r.tenant}  읽는 중 ${r.receiving} · 최근 실패 ${r.failed}`);
  }

  const targets = rows.filter((r) => r.class === 'deleted' || r.class === 'orphan');
  for (const r of targets) {
    console.log(`  ${LABEL[r.class]} ${short(r.agentId)}  파일 ${r.files} · ${mb(r.bytes)}`);
  }
  for (const l of leftovers) console.log(`  지운 비서 ${short(l.id)}  보관함 없음 · 남은 문서 행 ${l.rows}`);

  if (!apply) {
    console.log(`비울 보관함 ${targets.length}개 · 행만 남은 지운 비서 ${leftovers.length}개`);
    console.log('(아무것도 바꾸지 않았습니다 — 비우려면 -- --yes)');
    return;
  }

  let failed = 0;
  for (const r of targets) {
    if (r.class === 'deleted') {
      const res = await removeAgentDocuments(r.agentId);
      if (!res.nodaCleared) failed += 1;
      console.log(`  ${short(r.agentId)}  ${res.nodaCleared ? '보관함 비움' : 'NODA 실패 — 다시 실행하세요'} · 지운 행 ${res.removed}${res.kept ? ` · deleting으로 남김 ${res.kept}` : ''}`);
    } else {
      try {
        await noda.deleteTenant(r.tenant);
        console.log(`  ${short(r.agentId)}  고아 보관함 비움`);
      } catch (e) {
        failed += 1;
        console.log(`  ${short(r.agentId)}  고아 보관함을 비우지 못함(${failReason(e)}) — 다시 실행하세요`);
      }
    }
  }
  for (const l of leftovers) {
    const res = await removeAgentDocuments(l.id);
    if (!res.nodaCleared) failed += 1;
    console.log(`  ${short(l.id)}  남은 행 지움 ${res.removed}${res.kept ? ` · deleting으로 남김 ${res.kept}` : ''}`);
  }
  console.log(failed ? `끝 — 비우지 못한 곳 ${failed}개(다시 실행하면 이어서 비움)` : '끝 — 모두 비웠습니다');
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`실패: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
