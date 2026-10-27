/**
 * 업무 실제 모델 점검 — 업무별로 가상 자료를 넣어 **실제 Claude**로 끝까지 돌리고, 결과(확인 사항·칸·항목)와 원가를 적는다.
 *
 *   npm run work:testdb -- start
 *   npm run work:llm-smoke -- --yes-cost            -- 모델을 부르는 업무 8개(취합·정산은 모델을 안 써서 뺌)
 *   npm run work:llm-smoke -- --yes-cost --only reply,meeting
 *   npm run work:llm-smoke -- --yes-cost --out docs/workon-rebuild/evidence/llm-smoke.md
 *
 * 지키는 것
 *  - **시험 DB(WORK_TEST_DATABASE_URL)에만** 쓴다. 운영처럼 보이는 주소면 멈춘다. 자료는 전부 가상(실제 기관·사람 아님)
 *  - .env.local에서는 **ANTHROPIC_API_KEY만** 읽는다. Supabase·NODA 주소는 닿지 않는 값으로 덮어 운영에 아무것도 가지 않게 한다
 *  - 규정 확인의 근거: 기관 문서·공통 자료실은 '설정 안 됨', 법령은 법제처 **공개 시험 계정(OC=test)**으로 실제 검색
 *  - --yes-cost 없이는 모델을 부르지 않는다(비용이 든다). 사용 기록은 시험 DB usage_logs에만 남는다
 */
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

const args = process.argv.slice(2);
if (!args.includes('--yes-cost')) {
  console.error('실제 모델을 부르면 비용이 듭니다. --yes-cost를 붙여 실행하세요.');
  process.exit(1);
}
const dbUrl = process.env.WORK_TEST_DATABASE_URL;
if (!dbUrl) {
  console.error('WORK_TEST_DATABASE_URL이 없습니다 — npm run work:testdb -- start');
  process.exit(1);
}
if (/supabase\.(co|com)|pooler\./.test(dbUrl) || !/localhost|127\.0\.0\.1/.test(dbUrl)) {
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
// config.ts가 요구하는 값 — 닿지 않는 값으로(운영 Supabase·NODA로 아무것도 가지 않게)
Object.assign(process.env, {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'smoke-disabled',
  SUPABASE_SERVICE_ROLE_KEY: 'smoke-disabled',
  NEXTAUTH_URL: 'http://localhost',
  NEXTAUTH_SECRET: 'smoke',
  NODA_API_URL: 'http://127.0.0.1:9',
  NODA_API_KEY: '',
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

/** 업무별 가상 자료 */
const CASES = {
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
};

const onlyIdx = args.indexOf('--only');
const keys = onlyIdx >= 0 ? args[onlyIdx + 1].split(',') : Object.keys(CASES);
const outIdx = args.indexOf('--out');
const lines = [`# 업무 실제 모델 점검 (${new Date().toISOString().slice(0, 16)}Z, claude-sonnet-4-6, 가상 자료)`, ''];
let total = 0;

for (const key of keys) {
  const c = CASES[key];
  if (!c) {
    console.error(`모르는 업무: ${key}`);
    continue;
  }
  const started = Date.now();
  try {
    let task = await svc.createTask(ctx, actor, { workflowKey: key, title: c.title, form: c.form });
    for (const s of c.sources) {
      const bytes = Buffer.from(s.text, 'utf8');
      const up = await createSourceUpload(ctx, task, userId, { fileName: s.name, size: bytes.length, purpose: s.purpose });
      await ctx.files.put(up.path, bytes, 'text/plain');
      await confirmSource(ctx, task, up.sourceId);
    }
    await svc.refreshReadiness(ctx, (await ctx.store.getTask(task.id, orgId)));
    const r = await svc.requestGenerate(ctx, actor, task.id, { baseVersion: 0, idempotencyKey: `smoke-${randomUUID()}` });
    const [out] = await runWorker(ctx, { workerId: 'smoke', runId: r.run.id, budgetMs: 280_000 });
    const d = await svc.getTaskDetail(ctx, actor, task.id);
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
    for (const f of (v?.fields ?? []).filter((f) => f.value.trim()).slice(0, 12)) lines.push(`  - ${f.label}(${f.origin}): ${f.value.replace(/\s*\n\s*/g, ' ⏎ ').slice(0, 220)}`);
    lines.push('');
    console.log(`${key}: ${out?.finish} ${krw.toFixed(1)}원 ${sec}초`);
  } catch (e) {
    lines.push(`## ${key} — 실패: ${e instanceof Error ? e.message : String(e)}`, '');
    console.log(`${key}: 실패 ${e instanceof Error ? e.message : e}`);
  }
}
lines.push(`합계 원가(기록 시점 단가): ${total.toFixed(1)}원`);
const text = lines.join('\n');
if (outIdx >= 0) writeFileSync(args[outIdx + 1], text + '\n');
console.log('\n' + text);
await pool.end();
