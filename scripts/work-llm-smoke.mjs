/**
 * 업무 실제 모델 점검 — 업무별로 가상 자료를 넣어 **실제 Claude**로 끝까지 돌리고, 결과(확인 사항·칸·항목)와 원가를 적는다.
 *
 *   npm run work:testdb -- start
 *   npm run work:llm-smoke -- --yes-cost            -- 모델을 부르는 업무 8개(취합·정산은 모델을 안 써서 뺌) + 현행화(S6-1)
 *   npm run work:llm-smoke -- --yes-cost --app-rag --out report.md  -- 실제 ReadLayer + 실제 모델로 회신 1건
 *   npm run work:llm-smoke -- --yes-cost --only reply,meeting
 *   npm run work:llm-smoke -- --yes-cost --only currentize   -- 보고서에 작년 파일(HWPX)을 넣어 올해 문서로 고치기
 *   npm run work:llm-smoke -- --yes-cost --out docs/workon-rebuild/evidence/llm-smoke.md
 *
 * 지키는 것
 *  - **시험 DB(WORK_TEST_DATABASE_URL)에만** 쓴다. 운영처럼 보이는 주소면 멈춘다. 자료는 전부 가상(실제 기관·사람 아님)
 *  - 기본은 .env.local에서 ANTHROPIC_API_KEY만 읽는다. --app-rag는 NODA_API_KEY·NODA_API_URL도 읽고 별도 가상 문서를 올렸다 지운다. 운영 Supabase에는 접근하지 않으며, NODA는 --app-rag에서만 실제 호출한다
 *  - 규정 확인의 근거: 기관 문서·공통 자료실은 '설정 안 됨', 법령은 법제처 **공개 시험 계정(OC=test)**으로 실제 검색
 *  - --yes-cost 없이는 모델을 부르지 않는다(비용이 든다). 사용 기록은 시험 DB usage_logs에만 남는다
 */
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

const args = process.argv.slice(2);
const appRag = args.includes('--app-rag');
if (appRag && args.includes('--only') && args[args.indexOf('--only') + 1] !== 'reply') throw new Error('--app-rag는 reply 한 건만 지원합니다.');
if (!args.includes('--yes-cost')) {
  console.error('실제 모델을 부르면 비용이 듭니다. --yes-cost를 붙여 실행하세요.');
  process.exit(1);
}
const dbUrl = process.env.WORK_TEST_DATABASE_URL;
if (!dbUrl) {
  console.error('WORK_TEST_DATABASE_URL이 없습니다 — npm run work:testdb -- start');
  process.exit(1);
}
const parsedDbUrl = new URL(dbUrl);
if (!['localhost', '127.0.0.1'].includes(parsedDbUrl.hostname) || !parsedDbUrl.pathname.startsWith('/workon_')) {
  console.error('시험 DB(localhost)만 씁니다. 운영처럼 보이는 주소라 멈춥니다.');
  process.exit(1);
}
// .env.local에서 모델 키만
if (!process.env.ANTHROPIC_API_KEY && existsSync('.env.local')) {
  const line = readFileSync('.env.local', 'utf8').split(/\r?\n/).find((l) => l.startsWith('ANTHROPIC_API_KEY='));
  if (line) process.env.ANTHROPIC_API_KEY = line.slice(line.indexOf('=') + 1).trim();
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY가 없습니다.');
  process.exit(1);
}
// --app-rag일 때만 ReadLayer 연결 설정도 읽는다. 운영 DB 설정은 읽지 않는다.
if (appRag && existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = /^(NODA_API_KEY|NODA_API_URL)=(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}
const ragUrl = appRag ? process.env.NODA_API_URL || 'https://api.readlayer.kr' : 'http://127.0.0.1:9';
const ragKey = appRag ? process.env.NODA_API_KEY || '' : '';
if (appRag && !ragKey) throw new Error('NODA_API_KEY가 없습니다.');
// config.ts가 요구하는 값 — 닿지 않는 값으로(운영 Supabase·NODA로 아무것도 가지 않게)
Object.assign(process.env, {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'smoke-disabled',
  SUPABASE_SERVICE_ROLE_KEY: 'smoke-disabled',
  NEXTAUTH_URL: 'http://localhost',
  NEXTAUTH_SECRET: 'smoke',
  NODA_API_URL: ragUrl,
  NODA_API_KEY: ragKey,
  LAW_API_OC: 'test',
  WORK_GENERATOR: '',
});

const pg = (await import('pg')).default;
const { createPgWorkStore } = await import('../src/lib/work/store/pg.ts');
const { createLocalWorkFiles } = await import('../src/lib/work/files.ts');
const { unavailableRenderer } = await import('../src/lib/work/documents/renderer.ts');
const { llmGenerator } = await import('../src/lib/work/generation/compose.ts');
const { llmRegulationModel } = await import('../src/lib/work/workflows/regulations/model.ts');
const { llmItemsModel } = await import('../src/lib/work/workflows/items/model.ts');
const { llmQaModel } = await import('../src/lib/work/workflows/qa/model.ts');
const { llmCurrentizeModel } = await import('../src/lib/work/workflows/currentize/model.ts');
const { readSegments } = await import('../src/lib/work/workflows/currentize/segments.ts');
const { readFillableTemplate, generateDocumentFile } = await import('../src/lib/work/documents/generate-file.ts');
const { fieldsFromSlots } = await import('../src/lib/work/documents/fields.ts');
const { openHwpx, readEntry, writeHwpx } = await import('../src/lib/doc-fill/hwpx-core.ts');
const { para, tableAt } = await import('../tests/fixtures/hwpx.ts');
const ExcelJS = (await import('exceljs')).default;
const { parseLawSearch, splitArticles, pickArticles } = await import('../src/lib/work/workflows/regulations/gather.ts');
const { lawConnector } = await import('../src/lib/connectors/law.ts');
const { createSourceUpload, confirmSource } = await import('../src/lib/work/sources.ts');
const svc = await import('../src/lib/work/services.ts');
const { runWorker } = await import('../src/lib/work/runs/worker.ts');

/** 규정 확인 시험용 근거 — 법령만 실제 법제처(공개 시험 계정) 검색 */
const providers = {
  async orgDocuments() {
    return { status: 'unavailable', reason: '점검 스크립트 — 기관 문서 검색 안 함' };
  },
  async common() {
    return { status: 'unavailable', reason: '점검 스크립트 — 공통 자료실 안 함' };
  },
  async laws(_scope, plan) {
    const items = [];
    for (const q of plan.lawQueries.slice(0, 2)) {
      const found = await lawConnector.execute('law_search', { query: q, type: '법령', limit: 2 });
      for (const row of parseLawSearch(found.content)) {
        const content = await lawConnector.execute('law_get_content', { id: row.id, type: '법령' });
        if (content.isError) continue;
        const { enforced, articles } = splitArticles(content.content);
        for (const a of pickArticles(articles, plan.keywords, 2)) {
          items.push({ kind: 'law', title: row.title, location: a.heading, effectiveDate: row.effectiveDate ?? enforced, editionYear: null, issuer: null, text: a.text, url: content.sources[0]?.url ?? null });
        }
      }
    }
    return { status: 'ok', items };
  },
};

const pool = new pg.Pool({ connectionString: dbUrl, max: 3 });
const ctx = {
  store: createPgWorkStore(pool),
  files: createLocalWorkFiles(mkdtempSync(path.join(tmpdir(), 'workon-smoke-'))),
  generator: llmGenerator,
  generatorMode: 'llm',
  renderer: unavailableRenderer,
  regulations: { providers, model: llmRegulationModel },
  items: { model: llmItemsModel },
  qa: { model: llmQaModel },
  currentize: { model: llmCurrentizeModel },
  resolveModel: async () => 'claude-sonnet-4-6',
  checkLimit: async () => ({ allowed: true }),
  log: async (p) => {
    if (p.level === 'error') console.error('[log]', p.message, JSON.stringify(p.details ?? {}).slice(0, 300));
  },
  now: () => new Date(),
};

// ── 가상 기관·사람 ──
const orgId = randomUUID(), deptId = randomUUID(), userId = randomUUID();
await pool.query('INSERT INTO organizations (id, name, type) VALUES ($1, $2, $3)', [orgId, '가상시청(점검)', '지방자치단체']);
await pool.query('INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)', [deptId, '총무과', `smoke-${deptId.slice(0, 8)}`, orgId]);
await pool.query('INSERT INTO users (id, email, department_id) VALUES ($1, $2, $3)', [userId, `${userId}@smoke.local`, deptId]);
await pool.query('INSERT INTO work_org_settings (organization_id, home_enabled, new_tasks_enabled) VALUES ($1, true, true)', [orgId]);
const actor = { userId, organizationId: orgId, departmentId: deptId, isAdmin: false, managedDepartmentIds: [] };

// 실제 ReadLayer + 실제 모델 시험은 한 개의 독립 가상 문서만 쓴다.
const ragAgentId = randomUUID();
const ragDocId = randomUUID();
const ragTenant = `workon-smoke-${randomUUID()}`;
let ragFilename = null;
let ragClient = null;
if (appRag) {
  const { noda, nodaFilename } = await import('../src/lib/noda.ts');
  const { sourcesToChunks, contextPassages, isCleanMatch } = await import('../src/lib/capabilities/doc-search.ts');
  ragClient = noda;
  ragFilename = nodaFilename(ragDocId, '가상-주차장-운영기준.txt');
  await pool.query('INSERT INTO agents(id,name,department_id,organization_id,tier,visibility,is_published) VALUES($1,$2,$3,$4,$5,$6,true)', [ragAgentId, '가상 주차장 비서', deptId, orgId, 'official', 'organization']);
  ctx.loadAppSnapshot = async () => ({ schemaVersion: 1, agentId: ragAgentId, name: '가상 주차장 비서', version: 1, systemPrompt: '문의별로 짧게 답변하고 확정되지 않은 약속은 하지 않습니다.', requestedModel: 'claude-sonnet-4-6', capturedAt: new Date().toISOString(), documentSearchEligible: true });
  ctx.regulations.providers.orgDocuments = async (scope, query) => {
    if (scope.agentId !== ragAgentId || scope.organizationId !== orgId) throw new Error('시험 범위 불일치');
    const c = await noda.getContext({ tenant: ragTenant, query });
    const match = sourcesToChunks(c.sources, [{ id: ragDocId, title: '가상 주차장 운영 기준', file_name: '가상-주차장-운영기준.txt', noda_status: 'ready' }], contextPassages(c.context));
    if (!isCleanMatch(match)) throw new Error('검색 근거 매칭 실패');
    return { status: 'ok', items: match.chunks.map((chunk) => ({ kind: 'org_doc', title: chunk.documentTitle, location: chunk.page ? `p.${chunk.page}` : chunk.section || null, text: chunk.text, effectiveDate: null, editionYear: null, issuer: null, url: null })) };
  };
}

/** 현행화 사례의 작년 파일 — 표준 보고서 양식(assets/templates/report.hwpx)을 실제 채우기 엔진으로 채운다(tests/helpers/prior-fixture.ts와 같은 방법) */
async function buildPriorHwpx() {
  const bytes = readFileSync(path.join(process.cwd(), 'assets', 'templates', 'report.hwpx'));
  const read = await readFillableTemplate(bytes, 'report.hwpx');
  const values = {
    제목: '2025년 ○○ 사업계획',
    개요: '2025년에는 사업 A·B를 추진하였다.',
    // 둘째 줄은 연도·수치·인용이 없는 줄글 — 모델이 올해 자료·메모로 다시 쓰는 대상
    '주요 내용': '2025년 예산은 1,200백만원이다. 「지방공기업법」 제64조에 따라 편성한다. 담당 부서는 기획팀이다.\n사업 B를 계속 추진하여 지역 일자리를 늘린다.',
  };
  const fields = fieldsFromSlots(read.slots).map((f) => ({ ...f, value: values[f.label] ?? '' }));
  const filled = (await generateDocumentFile(bytes, 'report.hwpx', fields)).bytes;
  // 표 하나(2024·2025년 열)를 첫 구역 끝에 덧붙인다 — tests/helpers/prior-fixture.ts의 appendXml과 같은 방법
  const doc = await openHwpx(filled);
  const name = doc.sections[0];
  const xml = await readEntry(doc.zip, name);
  const at = xml.lastIndexOf('</hs:sec>');
  const extra = para('(단위: 백만원)') + tableAt([['구분', '2024년', '2025년', '증감'], ['사업 A', '1,100', '1,200', '100']], { addr: true });
  return writeHwpx(doc, new Map([[name, xml.slice(0, at) + extra + xml.slice(at)]]));
}
/** 올해 자료 — 2026 예산 시트(사업 A 1300) */
async function buildDataXlsx() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('2026 예산');
  ws.addRow(['구분', '2026년']);
  ws.addRow(['사업 A', 1300]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 업무별 가상 자료 */
const CASES = {
  'document-faq': {
    title: '가상 주차장 이용 FAQ', form: { audience: '일반 시민', questionCount: '3' },
    sources: [{ name: '가상-이용안내.txt', purpose: 'reference', text: '가상 주차장은 매일 오전 7시부터 오후 10시까지 운영합니다. 장애인 주차구역은 상시 확보합니다. 이용 요금은 안내문에 기재되어 있지 않습니다. 야간 조명은 교체 완료했습니다.' }],
  },
  'meeting-agenda': {
    title: '가상 주차장 운영 개선 회의', form: { meetingPurpose: '운영 시간 연장 검토에 필요한 쟁점과 준비 자료를 정리한다. 이번 회의에서 결정된 사항은 아직 없다.', attendees: ['시설관리팀', '민원지원팀'] },
    sources: [{ name: '가상-검토메모.txt', purpose: 'reference', text: '가상 주차장은 매일 07시부터 22시까지 운영한다. 23시까지 연장을 요청하는 민원이 접수됐다. 야간 인력과 조명 유지비 추산은 아직 없다. 인근 주민의 소음 의견은 확인하지 않았다. 운영 시간 변경 여부는 결정되지 않았다.' }],
  },
  'document-translation': {
    title: '가상 시설 점검 안내 영어 번역', form: { targetLanguage: '영어', translationStyle: '공식 문서', glossary: '가상시청 = Example City Hall' },
    sources: [{ name: '가상-번역원문.txt', purpose: 'reference', text: '가상시청은 2026년 11월 3일 오후 2시에 시설 점검을 진행할 예정입니다. 참가 인원은 15명이며 비용은 30,000원입니다. 우천 시에는 일정을 다시 안내합니다. 추가 점검 계획은 아직 확정되지 않았습니다.' }],
  },
  'document-rewrite': {
    title: '가상 시설 점검 안내 공문체 변환', form: { rewriteMode: '공문체 변환' },
    sources: [{ name: '가상-점검안내.txt', purpose: 'reference', text: '시설 점검을 2026년 11월 3일 오후 2시에 할 예정이에요. 참가 인원은 15명이고 비용은 30,000원입니다. 비가 오면 날짜는 다시 알려드릴게요. 추가 점검 계획은 아직 확정되지 않았어요.' }],
  },
  'document-summary': {
    title: '가상 주차장 운영 안내 요약', form: { summaryStyle: '핵심 요약' },
    sources: [{ name: '가상-운영안내.txt', purpose: 'reference', text: '가상시청 주차장은 2026년 10월 기준 매일 오전 7시부터 오후 10시까지 운영한다. 오후 11시까지 연장하는 계획은 아직 확정되지 않았다. 야간 조명은 2026년 10월 20일 교체 완료했다. 장애인 주차구역은 상시 확보한다.' }],
  },
  'official-letter': {
    title: '2026년 하반기 개인정보 보호 교육 실시 알림',
    form: { facts: '전 직원 대상 개인정보 보호 교육을 2026. 11. 19.(목) 14:00 본관 대회의실에서 2시간 실시. 부서별 참석자 명단을 11. 12.까지 총무과로 제출.', recipients: ['각 부서장'] },
    sources: [],
  },
  report: {
    title: '2026년 3분기 사업 추진 결과보고',
    form: { reportType: '결과보고', period: '2026년 3분기', emphasis: '집행률이 낮은 사업의 원인' },
    sources: [{ name: '3분기 실적.txt', purpose: 'reference', text: '부서별 3분기 실적\n기획팀: 예산 1,200,000원, 집행 900,000원, 참여자 30명\n사업팀: 예산 800,000원, 집행 500,000원, 참여자 20명(행사 1건 연기)\n교육팀: 예산 600,000원, 집행 450,000원, 참여자 12명\n합계: 예산 2,600,000원, 집행 1,850,000원(집행률 71.15%)\n4분기 계획: 연기된 사업팀 행사를 11월에 개최' }],
  },
  regulations: {
    title: '출장 숙박비 상한 초과 지급 가능 여부 검토',
    form: { question: '국내 출장 중 숙박비가 상한액을 넘으면 넘는 금액을 여비로 지급할 수 있는가?', basisDate: '2026-10-27', scope: '공무원 여비' },
    sources: [],
  },
  intake: {
    title: '3분기 실적 제출 요청 접수',
    form: { receivedOn: '2026-10-20' },
    sources: [
      { name: '공문.txt', purpose: 'request', text: '수신: 각 시·군 총무과장\n제목: 2026년 3분기 사업 실적 제출 요청\n1. 2026년 3분기(7~9월) 사업 실적을 붙임 양식에 따라 작성하여 2026. 10. 30.(금)까지 도 기획예산과로 제출하여 주시기 바랍니다.\n2. 문의: 기획예산과 주무관 김가나(061-123-4567)\n붙임 실적 제출 양식 1부. 끝.' },
      { name: '붙임 작성 요령.txt', purpose: 'request', text: '작성 요령\n- 제출 기한: 2026. 10. 31.\n- 사업별 예산·집행·참여 인원을 적을 것\n- 미제출 시 사유서를 접수 후 3일 이내 제출' },
      { name: '업무분장표.txt', purpose: 'reference', text: '총무과: 복무, 여비, 문서 접수\n기획예산과: 사업 실적 취합, 예산 편성\n시설과: 청사 관리' },
    ],
  },
  meeting: {
    title: '4분기 집행 계획 조정 회의',
    form: { meetingName: '4분기 집행 계획 조정 회의', meetingOn: '2026-10-27', participants: ['부시장', '기획예산과장', '시설과장'] },
    sources: [{ name: '회의 메모.txt', purpose: 'reference', text: '회의 메모(2026. 10. 27. 본관 소회의실)\n안건: 4분기 집행 계획 조정\n부시장: 집행률 낮은 사업은 11월 중 재배정 검토\n기획예산과장: 행사성 경비 20% 감액안 제시 — 부시장 원안 승인\n시설과장: 청사 보수는 안전진단 결과가 나오는 조건으로 추진 동의\n홍보비 증액은 다음 회의에서 다시 논의\n기획예산과가 11. 10.까지 재배정안 작성\n시설과는 안전진단 의뢰' }],
  },
  handover: {
    title: '사업 실적 관리',
    form: { confirmedStatus: '3분기 실적 취합 진행 중 — 운영팀 자료 대기\n예산 재배정 요청 미결(기한 2026. 9. 30. 지남, 기획예산과 협의 중)\n위원회 운영은 매 분기 마지막 달 둘째 주', basisDate: '2026-10-27' },
    sources: [{ name: '업무 매뉴얼.txt', purpose: 'reference', text: '실적 관리 매뉴얼\n- 매월 5일 집행 실적을 재정 시스템에 입력(접속 계정 ID/PW : jaejung01 / Qwer!2345)\n- 2분기 실적 보고는 7. 15. 완료\n- 분기 실적 취합 양식은 공유 폴더 \\\\실적\\양식에 있음' }],
  },
  reply: {
    title: '주차장 이용 문의 회신',
    form: { inquiry: '안녕하세요. 시청 주차장 이용 시간을 밤 11시까지 늘릴 수 있나요? 그리고 지난주 신고한 야간 조명 고장은 언제 고쳐지나요? 연락은 010-1111-2222로 부탁드립니다.', confirmedFacts: '- 주차장 운영 시간은 07시~22시이며 연장 계획은 확정되지 않음\n- 야간 조명은 10월 20일 교체 완료', recipient: '민원인' },
    sources: [],
  },
  'audit-response': {
    title: '민원 처리 실적 요구자료',
    form: { indicatorDefinitions: [{ name: '민원 평균 처리 기간(2026년 1~9월)' }] },
    sources: [
      { name: '요구서.txt', purpose: 'request', text: '요구자료\n1. 2026년 1~9월 민원 평균 처리 기간\n2. 민원 만족도 조사 결과\n3. 처리 기간 단축을 위한 개선 조치' },
      { name: '민원 처리 실적.txt', purpose: 'evidence', text: '민원 처리 실적(2026년 1~9월)\n- 접수 1,240건, 평균 처리 기간 4.2일\n- 산정 기준을 2026년부터 접수일 기준으로 변경\n- 개선 조치: 전자 결재 단계 축소(3단계→2단계)' },
      { name: '2025 제출본.txt', purpose: 'reference', text: '2025년 제출 — 민원 평균 처리 기간 4.8일' },
    ],
  },
  currentize: {
    workflowKey: 'report',
    title: '2026년 ○○ 사업계획',
    form: { reportType: '사업계획', period: '2026년', emphasis: '사업 B 중단, 사업 C 신설' },
    sources: async () => [
      { name: '2025 사업계획.hwpx', purpose: 'prior', bytes: await buildPriorHwpx(), contentType: 'application/hwp+zip' },
      { name: '2026 예산.xlsx', purpose: 'data', bytes: await buildDataXlsx(), contentType: XLSX_TYPE },
      { name: '2026년 사업 방향.txt', purpose: 'reference', text: '2026년에는 사업 B를 중단하고 사업 C를 새로 시작한다. 예산은 1,300백만원으로 늘린다.' },
    ],
  },
};

const onlyIdx = args.indexOf('--only');
const keys = appRag ? ['reply'] : onlyIdx >= 0 ? args[onlyIdx + 1].split(',') : Object.keys(CASES);
const outIdx = args.indexOf('--out');
const lines = [`# 업무 실제 모델 점검 (${new Date().toISOString().slice(0, 16)}Z, claude-sonnet-4-6, 가상 자료)`, ''];
let total = 0;
let failures = 0;
try {
if (appRag) {
  const upload = await ragClient.uploadDocument({ tenant: ragTenant, filename: ragFilename, bytes: new TextEncoder().encode('가상시청 주차장 운영 안내. 주차장은 매일 오전 07시부터 오후 22시까지 운영합니다. 밤 23시까지 연장하는 계획은 확정되지 않았습니다. 야간 조명은 2026년 10월 20일 교체 완료되었습니다.') });
  if (upload.filename) ragFilename = upload.filename;
  if (!upload.readable) throw new Error('시험 문서 읽기 실패');
}

for (const key of keys) {
  const c = CASES[key];
  if (!c) {
    console.error(`모르는 업무: ${key}`);
    continue;
  }
  const started = Date.now();
  try {
    let task = await svc.createTask(ctx, actor, { workflowKey: c.workflowKey ?? key, title: c.title, form: c.form, ...(appRag ? { agentId: ragAgentId, documentScope: 'selected-agent' } : {}) });
    const sources = typeof c.sources === 'function' ? await c.sources() : c.sources;
    for (const s of sources) {
      // 글 원자료는 text, 파일 원자료(작년 HWPX·엑셀)는 bytes + contentType
      const bytes = s.bytes ?? Buffer.from(s.text, 'utf8');
      const up = await createSourceUpload(ctx, task, userId, { fileName: s.name, size: bytes.length, purpose: s.purpose });
      await ctx.files.put(up.path, bytes, s.contentType ?? 'text/plain');
      await confirmSource(ctx, task, up.sourceId);
    }
    await svc.refreshReadiness(ctx, (await ctx.store.getTask(task.id, orgId)));
    const r = await svc.requestGenerate(ctx, actor, task.id, { baseVersion: 0, idempotencyKey: `smoke-${randomUUID()}` });
    const [out] = await runWorker(ctx, { workerId: 'smoke', runId: r.run.id, budgetMs: 280_000 });
    const d = await svc.getTaskDetail(ctx, actor, task.id);
    if (out?.finish !== 'succeeded') failures++;
    if (appRag) {
      const count = d.version?.appEvidence?.length ?? 0;
      lines.push(`- 실제 ReadLayer 근거: ${count}건 · 앱 설정 버전: ${d.task.app?.version ?? '없음'}`);
      if (!count || !d.currentArtifacts.some((a) => a.format === 'hwpx' && a.validation_status === 'valid')) failures++;
    }
    const { rows } = await pool.query("SELECT details FROM usage_logs WHERE resource_id = $1", [r.run.id]);
    const krw = rows.reduce((s, x) => s + Number(x.details.cost_krw ?? 0), 0);
    total += krw;
    const sec = ((Date.now() - started) / 1000).toFixed(0);
    lines.push(`## ${d.task.workflowName} — ${out?.finish ?? '처리 안 됨'}${out?.error ? ` (${out.error.code}: ${out.error.safeMessage})` : ''} · ${sec}초 · 모델 ${rows.length}회 · ${krw.toFixed(1)}원`);
    lines.push(`- 확인 사항: ${d.review.map((i) => `${i.severity === 'blocking' ? '■' : i.severity === 'warning' ? '▲' : '·'}${i.code}`).join(' ') || '없음'}`);
    lines.push(`- 결과 파일: ${d.currentArtifacts.map((a) => `${a.output_key}(${a.format}, ${a.validation_status})`).join(', ') || '없음'}`);
    const v = d.version;
    if (v?.items) lines.push(`- 항목 ${v.items.items.length}개: ${v.items.items.slice(0, 6).map((i) => `${i.id} ${i.type} ${Object.values(i.values).filter(Boolean)[0] ?? ''}${i.flags.length ? ` [${i.flags.join(',')}]` : ''}`).join(' / ')}`);
    if (v?.qa) lines.push(`- 질문 ${v.qa.pairs.length}개: ${v.qa.pairs.map((p) => `${p.id} ${p.question.slice(0, 30)}${p.flags.length ? ` [${p.flags.join(',')}]` : ''}`).join(' / ')}`);
    if (v?.regulations) lines.push(`- 근거 ${v.regulations.evidence.length}건(${v.regulations.evidence.map((e) => `${e.id} ${e.title} ${e.location ?? ''} ${e.applicability}`).join(' / ')}) · 의견 ${v.regulations.findings.length} · 유보 ${v.regulations.reservations.length}`);
    const cz = v?.currentize ?? null;
    if (c.workflowKey && key === 'currentize') {
      const ch = cz?.changes ?? [];
      const n = (st) => ch.filter((x) => x.status === st).length;
      let hasTitle = false;
      const main = d.currentArtifacts.find((a) => a.output_key === 'report');
      if (main) {
        const row = (await ctx.store.listArtifacts(task.id, orgId)).find((a) => a.id === main.id);
        const bytes = row ? await ctx.files.get(row.storage_path) : null;
        if (bytes) hasTitle = (await readSegments(bytes)).segments.some((sg) => sg.text.includes('2026년 ○○ 사업계획'));
      }
      lines.push(`- 현행화: 변경 ${ch.length}개 (바꿈 ${n('changed')} / 확인 필요 ${n('needs_check')} / 제안 ${n('proposed')}) · costStopped ${cz?.costStopped ?? '?'} · 제목에 '2026년 ○○ 사업계획' ${hasTitle ? '있음' : '없음'}`);
      for (const x of ch.slice(0, 12)) lines.push(`  - [${x.status}] ${x.kind} ${String(x.before).replace(/\s+/g, ' ').slice(0, 60)} → ${x.after == null ? '(없음)' : String(x.after).replace(/\s+/g, ' ').slice(0, 80)}${x.note ? ` // ${x.note}` : ''}`);
    }
    for (const f of (v?.fields ?? []).filter((f) => f.value.trim()).slice(0, 12)) lines.push(`  - ${f.label}(${f.origin}): ${f.value.replace(/\s*\n\s*/g, ' ⏎ ').slice(0, 220)}`);
    lines.push('');
    console.log(`${key}: ${out?.finish} ${krw.toFixed(1)}원 ${sec}초`);
  } catch (e) {
    failures++;
    lines.push(`## ${key} — 실패: ${e instanceof Error ? e.message : String(e)}`, '');
    console.log(`${key}: 실패 ${e instanceof Error ? e.message : e}`);
  }
}
lines.push(`합계 원가(기록 시점 단가): ${total.toFixed(1)}원`);
const text = lines.join('\n');
if (outIdx >= 0) writeFileSync(args[outIdx + 1], text + '\n');
console.log('\n' + text);
} finally {
  if (appRag && ragFilename) {
    try {
      await ragClient.deleteDocument(ragTenant, ragFilename);
      const remaining = await ragClient.listDocuments(ragTenant);
      if ([...remaining.documents, ...remaining.receiving].some((d) => d.filename === ragFilename)) throw new Error('삭제 확인 실패');
      console.log('ReadLayer 시험 문서 삭제·목록 확인 완료');
    } catch {
      failures++;
      console.error(`ReadLayer 시험 문서 정리 필요: 보관함 ${ragTenant}, 파일 ${ragFilename}`);
    }
  }
  await pool.end();
}
if (failures) process.exitCode = 1;
