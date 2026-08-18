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

  // 기본 시나리오: 검색 → 첫 결과의 조문 조회
  const search = await executeTool('law_search', { query: '개인정보 보호법', limit: 3 });
  const searchOk = show('law_search {"query":"개인정보 보호법"}', search);

  const mst = search.sources[0]?.url.match(/lsiSeq=(\d+)/)?.[1];
  if (!mst) {
    console.log('\n[결과] law_search FAIL — mst를 얻지 못해 조문 조회를 건너뜁니다.');
    process.exit(1);
  }

  const articles = await executeTool('law_get_articles', { mst, article: '15' });
  const articleOk = show(`law_get_articles {"mst":"${mst}","article":"15"}`, articles);

  const unknown = await executeTool('nope_tool', {});
  const guardOk = unknown.isError === true;
  console.log(`\n--- 알 수 없는 도구 처리 --- ${guardOk ? 'PASS (isError)' : 'FAIL'}`);

  console.log(
    `\n[결과] law_search ${searchOk ? 'PASS' : 'FAIL'} / law_get_articles ${articleOk ? 'PASS' : 'FAIL'} / 오류처리 ${guardOk ? 'PASS' : 'FAIL'}`
  );
  if (!searchOk || !articleOk || !guardOk) process.exit(1);
}

main().catch((e) => {
  console.error('실패:', e.message);
  process.exit(1);
});
