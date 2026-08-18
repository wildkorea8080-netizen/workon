/**
 * 공공 데이터 커넥터 검증 스크립트.
 *
 *   npm run connector:probe
 *   npm run connector:probe -- law_search '{"query":"개인정보 보호법"}'
 *
 * 실제 외부 API를 호출합니다. 네트워크가 필요합니다.
 */
import { existsSync, readFileSync } from 'fs';

// config.ts는 import 시점에 필수 환경변수를 검사한다. 이 스크립트는 커넥터만
// 확인하므로 .env.local이 있으면 쓰고, 없으면 나머지를 자리표시자로 채운다.
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.trimStart().startsWith('#')) {
      const key = line.slice(0, eq).trim();
      if (!process.env[key]) process.env[key] = line.slice(eq + 1).trim();
    }
  }
}
for (const key of [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'NEXTAUTH_URL',
  'NEXTAUTH_SECRET',
  'VOYAGE_API_KEY',
  'ANTHROPIC_API_KEY',
]) {
  if (!process.env[key]) process.env[key] = 'probe-placeholder';
}

const { availableConnectors, availableTools, executeTool } = await import(
  '../src/lib/connectors/index.ts'
);

function show(title, result) {
  console.log(`\n--- ${title} ---`);
  console.log(result.isError ? `오류: ${result.content}` : result.content);
  if (result.sources.length) {
    console.log('\n출처:');
    for (const s of result.sources.slice(0, 5)) console.log(`  - ${s.title}: ${s.url}`);
  }
  return !result.isError;
}

async function main() {
  const [toolName, rawInput] = process.argv.slice(2);

  console.log('설정된 커넥터:', availableConnectors().map((c) => `${c.label}(${c.id})`).join(', ') || '없음');
  console.log('노출 도구:', availableTools().map((t) => t.name).join(', ') || '없음');

  if (toolName) {
    const input = rawInput ? JSON.parse(rawInput) : {};
    const result = await executeTool(toolName, input);
    show(`${toolName} ${rawInput ?? ''}`, result);
    return;
  }

  // 기본 시나리오: 설정된 커넥터마다 검색 → 상세 조회까지 한 번씩 태운다.
  // 커넥터는 순수 함수라 여기서 통과하면 /api/chat의 툴 루프에서도 같게 동작한다.
  const configured = new Set(availableConnectors().map((c) => c.id));
  const results = [];

  /** 도구를 호출해 출력하고 통과 여부를 기록한다. 실패해도 다음 시나리오를 계속한다. */
  async function step(label, tool, input, { optional = false } = {}) {
    const result = await executeTool(tool, input);
    const ok = show(`${tool} ${JSON.stringify(input)}`, result);
    results.push({ label, ok: ok || optional, hard: ok, optional });
    return result;
  }

  // ── 국가법령정보 ──
  if (configured.has('law')) {
    const search = await step('law 검색', 'law_search', { query: '개인정보 보호법', limit: 3 });
    const mst = search.sources[0]?.url.match(/lsiSeq=(\d+)/)?.[1];
    if (mst) {
      await step('law 조문', 'law_get_content', { id: mst, type: '법령', article: '15' });
    } else {
      results.push({ label: 'law 조문', ok: false, hard: false });
    }

    // 판례 본문은 기관 자체 OC일 때만 열린다. 기본 OC면 실패가 정상이라 optional.
    const prec = await step('판례 검색', 'law_search', { query: '개인정보', type: '판례', limit: 1 });
    const seq = prec.sources[0]?.url.match(/precSeq=(\d+)/)?.[1];
    if (seq) {
      await step('판례 본문(자체 OC 필요)', 'law_get_content', { id: seq, type: '판례' }, { optional: true });
    }
  }

  // ── KOSIS ──
  if (configured.has('kosis')) {
    const tables = await step('KOSIS 검색', 'kosis_search_tables', { query: '소비자물가지수', limit: 3 });
    const m = tables.sources[0]?.url.match(/orgId=([^&]+)&tblId=([^&]+)/);
    if (m) {
      await step('KOSIS 데이터', 'kosis_get_data', { orgId: m[1], tblId: m[2], periods: 2 });
    } else {
      results.push({ label: 'KOSIS 데이터', ok: false, hard: false });
    }
  }

  // ── 나라장터 ──
  if (configured.has('g2b')) {
    await step('나라장터 공고', 'g2b_search_bids', { keyword: '인공지능', days: 30, limit: 3 });
  }

  // ── DART ──
  if (configured.has('dart')) {
    const disc = await step('DART 공시', 'dart_search_disclosures', { limit: 3 });
    const corp = disc.content?.match(/corp_code\): (\d{8})/)?.[1];
    if (corp) {
      await step('DART 기업개황', 'dart_get_company', { corp_code: corp });
    } else {
      results.push({ label: 'DART 기업개황', ok: false, hard: false });
    }
  }

  // ── 오류 처리 ──
  const unknown = await executeTool('nope_tool', {});
  const guardOk = unknown.isError === true;
  console.log(`\n--- 알 수 없는 도구 처리 --- ${guardOk ? 'PASS (isError)' : 'FAIL'}`);
  results.push({ label: '오류 처리', ok: guardOk, hard: guardOk });

  console.log('\n===== 결과 =====');
  for (const r of results) {
    const mark = r.hard ? 'PASS' : r.optional ? 'SKIP (선택)' : 'FAIL';
    console.log(`  ${mark.padEnd(12)} ${r.label}`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log(`\n실패 ${failed.length}건: ${failed.map((r) => r.label).join(', ')}`);
    process.exit(1);
  }
  console.log('\n전부 통과했습니다.');
}

main().catch((e) => {
  console.error('실패:', e.message);
  process.exit(1);
});
