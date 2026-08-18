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

process.exit(ok?0:1);
