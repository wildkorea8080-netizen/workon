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
process.exit(ok?0:1);
