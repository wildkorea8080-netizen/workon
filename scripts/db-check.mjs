/**
 * 마이그레이션 적용 상태를 실제 DB에 붙어 확인한다.
 *
 *   npm run db:check
 *
 * .env.local의 SUPABASE_SERVICE_ROLE_KEY로 접속한다.
 * PostgREST를 거치므로 스키마 캐시가 오래되면 실제와 다르게 보일 수 있다.
 * 결과가 의심스러우면 SQL Editor에서 information_schema를 직접 확인할 것.
 */
import { readFileSync } from 'fs';
for (const line of readFileSync('.env.local','utf8').split(/\r?\n/)) {
  const eq = line.indexOf('=');
  if (eq > 0 && !line.trimStart().startsWith('#')) {
    const k = line.slice(0,eq).trim();
    if (!process.env[k]) process.env[k] = line.slice(eq+1).trim();
  }
}
const { createClient } = await import('@supabase/supabase-js');
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// 컬럼/함수 존재 여부는 실제 조회를 시도해 판정한다 (information_schema는 REST로 못 봄)
const checks = [
  ['0012', 'usage_logs.organization_id', () => db.from('usage_logs').select('organization_id').limit(1)],
  ['0013', 'agents.enabled_connectors',  () => db.from('agents').select('enabled_connectors').limit(1)],
  ['0014', 'departments.parent_id',      () => db.from('departments').select('parent_id').limit(1)],
  ['0016', 'agents.visibility',          () => db.from('agents').select('visibility, organization_id').limit(1)],
  ['0016', 'documents.visibility',       () => db.from('documents').select('visibility, organization_id').limit(1)],
  ['0017', 'contracts.billing_type',     () => db.from('contracts').select('billing_type, annual_budget_krw, budget_alert_percent').limit(1)],
  ['0019', 'agents 카탈로그 컬럼',        () => db.from('agents').select('is_published, display_order, agent_type, link_url').limit(1)],
  ['0019', 'agent_categories 테이블',    () => db.from('agent_categories').select('id, name, display_order').limit(1)],
  ['0020', '기관 브랜딩 컬럼',            () => db.from('organizations').select('slug, ai_notice, logo_url').limit(1)],
  ['0021', 'organizations.allowed_models', () => db.from('organizations').select('allowed_models').limit(1)],
  ['0021', 'model_policy_logs 테이블',   () => db.from('model_policy_logs').select('id').limit(1)],
];

console.log('=== 컬럼 점검 ===');
let ok = true;
for (const [mig, label, fn] of checks) {
  const { error } = await fn();
  const pass = !error;
  if (!pass) ok = false;
  console.log(`${pass?'OK  ':'없음'}  ${mig}  ${label}${error?`  → ${error.message.slice(0,60)}`:''}`);
}

console.log('\n=== 함수(RPC) 점검 ===');
const { data: dept } = await db.from('departments').select('id, name').limit(1).maybeSingle();
const rpcs = [
  ['0014', 'department_descendants', { p_department_id: dept?.id }],
  ['0015', 'department_ancestors',   { p_department_id: dept?.id }],
  ['0017', 'organization_spend_krw', { p_organization_id: null, p_from: '2026-01-01', p_to: '2026-12-31' }],
];
for (const [mig, name, args] of rpcs) {
  const { error } = await db.rpc(name, args);
  const pass = !error;
  if (!pass) ok = false;
  console.log(`${pass?'OK  ':'없음'}  ${mig}  ${name}${error?`  → ${error.message.slice(0,70)}`:''}`);
}

// ── 데이터 상태 ─────────────────────────────────────────────
// 스키마가 있어도 백필이 안 됐으면 격리가 깨진다. 실제 행을 세어 본다.

console.log('\n=== 공개 범위 분포 ===');
console.log('0016 직후에는 기존 자료가 전부 department여야 정상입니다.');
for (const table of ['agents', 'documents']) {
  const { data, error } = await db.from(table).select('visibility');
  if (error) {
    console.log(`      ${table}  → 조회 실패: ${error.message.slice(0, 60)}`);
    ok = false;
    continue;
  }
  const tally = {};
  for (const row of data) tally[row.visibility ?? '(null)'] = (tally[row.visibility ?? '(null)'] ?? 0) + 1;
  const summary = Object.entries(tally).map(([k, v]) => `${k} ${v}건`).join(' / ') || '행 없음';
  // visibility가 NULL이면 visibilityFilter의 .or()에 걸리지 않아 아무에게도 안 보인다
  const bad = tally['(null)'] > 0;
  if (bad) ok = false;
  console.log(`${bad ? '주의' : 'OK  '}  ${table.padEnd(10)} ${summary}`);
}

console.log('\n=== 기관 미연결 행 (전부 0이어야 정상) ===');
for (const table of ['departments', 'agents', 'documents', 'usage_logs']) {
  const { count, error } = await db
    .from(table)
    .select('id', { count: 'exact', head: true })
    .is('organization_id', null);
  if (error) {
    console.log(`      ${table}  → 조회 실패: ${error.message.slice(0, 60)}`);
    ok = false;
    continue;
  }
  const bad = (count ?? 0) > 0;
  if (bad) ok = false;
  console.log(`${bad ? '주의' : 'OK  '}  ${table.padEnd(12)} ${count ?? 0}건`);
}

// ── 트리거 동작 확인 (0012 / 0022) ─────────────────────────
// PostgREST로는 pg_trigger를 볼 수 없다. 대신 증상을 본다 —
// 부서에는 organization_id가 있는데 로그만 NULL이면 트리거가 없는 것이다.
// 실제로 0012의 트리거가 빠진 채 컬럼만 있던 적이 있고, 그동안 쌓인 로그가
// 전부 기관 집계와 예산 판정에서 조용히 빠졌다.
console.log('\n=== usage_logs 기관 채움 트리거 ===');
{
  const { data: orphans } = await db
    .from('usage_logs')
    .select('department_id')
    .is('organization_id', null);

  const deptIds = [...new Set((orphans ?? []).map((r) => r.department_id).filter(Boolean))];

  if (deptIds.length === 0) {
    console.log('OK    미연결 로그 없음');
  } else {
    const { data: depts } = await db
      .from('departments')
      .select('id, name, organization_id')
      .in('id', deptIds);

    const fixable = (depts ?? []).filter((d) => d.organization_id);
    if (fixable.length > 0) {
      ok = false;
      console.log('주의  부서에는 기관이 있는데 로그만 미연결입니다. 트리거가 빠졌을 수 있습니다.');
      console.log(`      해당 부서: ${fixable.map((d) => d.name).join(', ')}`);
      console.log('      → supabase/migrations/0022_restore_usage_org_trigger.sql 적용');
    } else {
      console.log('참고  미연결 로그가 있으나 부서에도 기관이 없어 귀속할 수 없습니다.');
    }
  }
}


// ── 과금 기록 규약 ───────────────────────────────────────────
// organization_spend_krw는 details.cost_krw가 있는 행만 센다.
// 토큰을 쓰는 라우트가 이 필드를 빠뜨리면 그 사용량은 예산 판정에서
// 조용히 0원이 되어 한도가 걸릴 수 없게 된다. 드리프트를 여기서 잡는다.
// (2026-08 이전 로그는 규약 도입 전이라 없는 것이 정상이다.)

console.log('\n=== 과금 기록 규약 (details.cost_krw) ===');
{
  const CONVENTION_FROM = '2026-08-01';
  // 토큰을 쓰는 활동만 본다. create_agent 같은 것은 cost_krw가 없는 게 정상이라
  // 함께 세면 거짓 경보가 나고, 그러면 진짜 누락이 묻힌다.
  const TOKEN_ACTIONS = ['chat_message', 'qna_search', 'generate_report', 'document_ocr'];

  const { data, error } = await db
    .from('usage_logs')
    .select('created_at, action, details')
    .gte('created_at', CONVENTION_FROM)
    .in('action', TOKEN_ACTIONS);

  if (error) {
    console.log(`      조회 실패: ${error.message.slice(0, 60)}`);
    ok = false;
  } else if (data.length === 0) {
    console.log(`OK    ${CONVENTION_FROM} 이후 사용 로그 없음`);
  } else {
    const missing = data.filter((r) => r?.details?.cost_krw == null);
    const noModel = data.filter((r) => !r?.details?.model);
    if (missing.length) ok = false;
    console.log(
      `${missing.length ? '주의' : 'OK  '}  cost_krw 누락 ${missing.length}건 / 전체 ${data.length}건 (${CONVENTION_FROM} 이후)`
    );
    // model이 없으면 나중에 모델을 늘렸을 때 과거 사용량을 귀속시킬 수 없다
    console.log(
      `${noModel.length ? '주의' : 'OK  '}  model 누락 ${noModel.length}건`
    );
    if (missing.length) {
      const days = [...new Set(missing.map((r) => r.created_at?.slice(0, 10)))].sort();
      console.log(`      누락 발생일: ${days.join(', ')}`);
    }
  }
}

// ── 비서 카탈로그 (0019) ────────────────────────────────────
console.log('\n=== 비서 카탈로그 ===');
{
  const { data, error } = await db
    .from('agents')
    .select('name, icon, category, is_published, agent_type, link_url, is_personal');

  if (error) {
    console.log(`      조회 실패: ${error.message.slice(0, 60)}`);
    ok = false;
  } else {
    const official = data.filter((a) => !a.is_personal);
    const hidden = official.filter((a) => !a.is_published);
    const noIcon = official.filter((a) => !a.icon);
    const links = official.filter((a) => a.agent_type === 'link');
    // 링크형인데 주소가 없으면 클릭해도 아무 일이 없다. DB CHECK가 막지만
    // 제약이 걸리기 전에 들어간 행이 있을 수 있어 여기서도 센다.
    const brokenLinks = links.filter((a) => !a.link_url);

    console.log(`OK    공식 비서 ${official.length}개 (노출중 ${official.length - hidden.length} / 대기중 ${hidden.length})`);
    console.log(`${noIcon.length ? '참고' : 'OK  '}  아이콘 없음 ${noIcon.length}개${noIcon.length ? ` — ${noIcon.map((a) => a.name).join(', ')}` : ''}`);
    console.log(`${brokenLinks.length ? '주의' : 'OK  '}  링크형 ${links.length}개, 주소 없는 것 ${brokenLinks.length}개`);
    if (brokenLinks.length) ok = false;
  }
}

// ── 기관 브랜딩·모델 정책 (0020, 0021) ─────────────────────
console.log('\n=== 기관 설정 ===');
{
  const { data, error } = await db
    .from('organizations')
    .select('name, slug, logo_url, ai_notice, allowed_models');

  if (error) {
    console.log(`      조회 실패: ${error.message.slice(0, 60)}`);
    ok = false;
  } else {
    for (const org of data) {
      const models = Array.isArray(org.allowed_models) && org.allowed_models.length
        ? org.allowed_models.join(', ')
        : '미설정(기본 모델만)';
      // slug가 org-xxxxxxxx 형태면 이름에서 못 만든 자동 생성분이다.
      // 동작에는 문제없지만 직원에게 안내하기엔 알아보기 어렵다.
      const autoSlug = /^org-[0-9a-f]{8}$/.test(org.slug ?? '');
      console.log(`      ${org.name}`);
      console.log(`        ${autoSlug ? '참고' : 'OK  '} 로그인 경로 /signin/${org.slug}${autoSlug ? ' (자동 생성 — 알아보기 쉬운 값 권장)' : ''}`);
      console.log(`        ${org.logo_url ? 'OK  ' : '참고'} 로고 ${org.logo_url ? '있음' : '없음'}`);
      console.log(`        OK   허용 모델 ${models}`);
    }
  }
}

process.exit(ok?0:1);
