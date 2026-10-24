/**
 * NODA(문서 읽기 서비스) 점검 스크립트.
 *
 *   npm run noda:check                  -- /health만 (바깥 LLM 연결이 남아 있지 않은지·검색 켜짐)
 *   npm run noda:check -- --roundtrip   -- 작은 파일을 보관함 workon-check에 올려 찾고 지우기까지
 *   npm run noda:check -- --roundtrip --strict -- 엉뚱한 질문·쪽/출처 확인도 WARN이 아니라 FAIL로
 *
 * 실제 NODA 서버를 호출한다. 키(NODA_API_KEY)는 .env.local에서 읽고 **출력하지 않는다**.
 * 하나라도 FAIL이면 종료 코드 1. WARN(엉뚱한 질문·쪽/출처 정보)은 종료 코드에 넣지 않는다(`--strict`면 FAIL).
 *
 * 배포 순서(CLAUDE.md): 키 넣기 → noda:check -- --roundtrip → 마이그레이션 0031 → 푸시(배포 확인) → noda:migrate.
 */
import { existsSync, readFileSync } from 'fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.trimStart().startsWith('#')) {
      const key = line.slice(0, eq).trim();
      if (!process.env[key]) process.env[key] = line.slice(eq + 1).trim();
    }
  }
}
// config.ts가 import 시점에 필수 환경변수를 검사한다. 이 스크립트는 NODA만 부르므로 나머지는 자리표시자로 채운다.
for (const key of [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'NEXTAUTH_URL',
  'NEXTAUTH_SECRET',
  'ANTHROPIC_API_KEY',
]) {
  if (!process.env[key]) process.env[key] = 'noda-check-placeholder';
}

const { noda, nodaFilename, NodaError } = await import('../src/lib/noda.ts');

/** 점검용 보관함. 운영 보관함(`workon-a…`)과 겹치지 않는다 */
const CHECK_TENANT = 'workon-check';
const CHECK_FILE = 'noda-check.txt';
// 고정 이름 — 지난 실행이 남긴 파일이 있어도 replace=1이 덮어쓰므로 쌓이지 않는다
const CHECK_DOC_ID = '00000000-0000-0000-0000-000000000000';
const CHECK_TEXT = [
  '출장 여비 정산 안내',
  '국내 출장 숙박비는 1박당 최대 8만 원까지 실비로 지급한다.',
  '출장 복귀 후 5일 이내에 여비 정산서를 총무과에 제출해야 한다.',
].join('\n');
const RELEVANT_QUERY = '국내 출장 숙박비는 1박에 얼마까지 지급되나요?';
const IRRELEVANT_QUERY = '김치찌개 맛있게 끓이는 법';

const strict = process.argv.includes('--strict');
let failed = 0;
function ok(label, detail) {
  console.log(`OK    ${label}${detail ? ` — ${detail}` : ''}`);
}
function fail(label, detail) {
  failed += 1;
  console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}

/** 엉뚱한 질문·쪽/출처는 참고용이라 기본은 WARN(종료 코드에 넣지 않음), --strict면 FAIL */
function softFail(label, detail) {
  if (strict) {
    fail(label, detail);
    return;
  }
  console.log(`WARN  ${label}${detail ? ` — ${detail}` : ''}`);
}

/** 오류를 한 줄로. NodaError 글에는 키가 들어 있지 않다(noda.ts가 지운다) */
function why(err) {
  if (err instanceof NodaError) return `${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

function hasLocation(source) {
  const anchors = Array.isArray(source.anchors) ? source.anchors : [];
  if (anchors.some((a) => typeof a?.page === 'number' || (typeof a?.cell_range === 'string' && a.cell_range))) return true;
  if (typeof source.path === 'string' && source.path) return true;
  if (Array.isArray(source.outline) ? source.outline.length > 0 : typeof source.outline === 'string' && source.outline) return true;
  return false;
}

async function checkHealth() {
  let health;
  try {
    health = await noda.getHealth();
  } catch (err) {
    fail('/health 호출', why(err));
    return;
  }
  ok('/health 호출');

  const search = health && typeof health.search === 'object' ? health.search : null;
  if (search && search.vectors === true) ok('검색(search.vectors)', '켜져 있음');
  else fail('검색(search.vectors)', '켜져 있지 않습니다 — 문서 찾기가 동작하지 않습니다');

  const llm = health && typeof health.llm === 'object' ? health.llm : null;
  if (llm && llm.external === true) {
    fail('바깥 LLM 연결(llm.external)', "운영 서버에 바깥 LLM 연결이 남아 있습니다 — 보안 자료에 '바깥 연결 없음'을 쓰지 마세요");
  } else if (llm && llm.external === false) {
    ok('바깥 LLM 연결(llm.external)', '없음');
  } else {
    fail('바깥 LLM 연결(llm.external)', '/health 응답에서 읽지 못했습니다');
  }
}

async function checkRoundtrip() {
  let filename = nodaFilename(CHECK_DOC_ID, CHECK_FILE);
  let cleanup = true;
  try {
    // 1. 올리기
    try {
      const r = await noda.uploadDocument({
        tenant: CHECK_TENANT,
        filename,
        bytes: new TextEncoder().encode(CHECK_TEXT),
      });
      if (typeof r.filename === 'string' && r.filename) filename = r.filename;
      if (r.readable) ok('올리기·읽기', `${r.chunks}조각`);
      else fail('올리기·읽기', `읽지 못했습니다: ${(r.reason ?? '이유 없음').slice(0, 100)}`);
    } catch (err) {
      // 키가 없으면 NODA에 닿은 적이 없어 지울 것도 없다
      if (err instanceof NodaError && err.code === 'missing_key') cleanup = false;
      fail('올리기·읽기', why(err));
      return; // finally가 지우기를 시도한다 — 올리기가 NODA에 저장된 뒤 끊겼을 수 있다
    }

    // 2. 관련 질문 — 근거·쪽/출처
    try {
      const c = await noda.getContext({ tenant: CHECK_TENANT, query: RELEVANT_QUERY });
      const mine = c.sources.filter((s) => s.filename === filename);
      if (mine.length > 0) ok('관련 질문 → 근거', `근거 ${mine.length}건`);
      else fail('관련 질문 → 근거', `올린 글의 근거가 나오지 않았습니다 (근거 ${c.sources.length}건)`);
      if (mine.length > 0) {
        if (mine.some(hasLocation)) ok('근거의 쪽·출처 정보');
        else softFail('근거의 쪽·출처 정보', '쪽·절·셀 범위 중 어느 것도 없습니다 (글 파일은 원래 없을 수 있습니다)');
      }
    } catch (err) {
      fail('관련 질문 → 근거', why(err));
    }

    // 3. 엉뚱한 질문 — 근거가 비어야 한다
    try {
      const c = await noda.getContext({ tenant: CHECK_TENANT, query: IRRELEVANT_QUERY });
      if (c.sources.length === 0) ok('엉뚱한 질문 → 근거 없음');
      else softFail('엉뚱한 질문 → 근거 없음', `근거 ${c.sources.length}건이 나왔습니다 (하한 0.80은 엉뚱한 질문의 일부만 거릅니다 — 모델 판단이 둘째 겹입니다)`);
    } catch (err) {
      fail('엉뚱한 질문 → 근거 없음', why(err));
    }
  } finally {
    // 4. 지우기 — 올리기가 실패했어도(저장된 뒤 끊겼을 수 있다) 뒤 단계가 실패했어도 항상 시도한다.
    //    아무것도 없으면(deleted:false) 조용히 넘어간다.
    let removed = false;
    if (cleanup) {
      try {
        const d = await noda.deleteDocument(CHECK_TENANT, filename);
        removed = true;
        if (d.deleted) ok('삭제');
      } catch (err) {
        fail('삭제', `${why(err)} — 손으로 지워 주세요 (보관함 ${CHECK_TENANT}, 파일 ${filename})`);
      }
    }
    // 5. 목록에서 사라졌는지
    if (removed) {
      try {
        const list = await noda.listDocuments(CHECK_TENANT);
        const still =
          list.documents.some((d) => d.filename === filename) || list.receiving.some((d) => d.filename === filename);
        if (still) fail('삭제 뒤 목록', `목록에 아직 남아 있습니다 — 손으로 지워 주세요 (보관함 ${CHECK_TENANT}, 파일 ${filename})`);
        else ok('삭제 뒤 목록', '사라짐');
      } catch (err) {
        fail('삭제 뒤 목록', why(err));
      }
    }
  }
}

async function main() {
  const roundtrip = process.argv.includes('--roundtrip');
  console.log(`NODA 점검${roundtrip ? ' (왕복 포함)' : ''}`);
  await checkHealth();
  if (roundtrip) await checkRoundtrip();
  else console.log('SKIP  왕복 시험 — --roundtrip을 붙이면 올리기·찾기·삭제까지 봅니다');

  if (failed > 0) {
    console.log(`\n실패 ${failed}건`);
    process.exit(1);
  }
  console.log('\n전부 통과했습니다.');
}

main().catch((e) => {
  console.error('실패:', why(e));
  process.exit(1);
});
