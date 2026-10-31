/** 운영/시험 연결의 스키마를 읽기 전용으로 확인한다. 행 데이터·키·접속 주소는 출력하지 않는다. */
import { readFileSync, existsSync, writeFileSync } from 'fs';
const allowed = new Set(['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
if (existsSync('.env.local')) for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = /^([A-Z_]+)=(.*)$/.exec(line);
  if (match && allowed.has(match[1]) && !process.env[match[1]]) process.env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
}
const base = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!base || !key) { console.error('Supabase 연결 설정이 없습니다.'); process.exit(1); }
const checks = [
  ['work-tasks', 'work_tasks', 'id,organization_id,workflow_key'],
  ['app-snapshot-0036', 'work_tasks', 'app_snapshot'],
  ['work-settings', 'work_org_settings', 'organization_id,new_tasks_enabled'],
  ['work-installations', 'workflow_installations', 'workflow_key,status'],
  ['work-sources', 'work_sources', 'id,status,origin,extract_path'],
  ['work-runs', 'work_runs', 'id,status,payload'],
  ['work-versions', 'work_document_versions', 'id,content,fields'],
  ['work-artifacts', 'work_artifacts', 'id,validation_status,storage_path'],
];
const results = await Promise.all(checks.map(async ([id, table, columns]) => {
  const url = new URL(`/rest/v1/${table}`, base); url.searchParams.set('select', columns); url.searchParams.set('limit', '0');
  try {
    const response = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
    const body = await response.json().catch(() => null);
    return { id, status: response.ok ? 'passed' : 'failed', httpStatus: response.status, errorCode: typeof body?.code === 'string' ? body.code : null };
  } catch { return { id, status: 'unavailable', httpStatus: null, errorCode: null }; }
}));
const report = { checkedAt: new Date().toISOString(), readOnly: true, rowDataRequested: false, schemaColumnsReady: results.every((r) => r.status === 'passed'), results, limitations: ['컬럼 조회만 확인한다. RPC·RLS·트리거·워크플로우 CHECK 허용값·로그인 계정·기관 스위치·스토리지는 별도 검증이 필요하다.'] };
const output = JSON.stringify(report, null, 2);
console.log(output);
const outIndex = process.argv.indexOf('--out');
if (outIndex >= 0) { if (!process.argv[outIndex + 1]) throw new Error('--out 경로가 필요합니다.'); writeFileSync(process.argv[outIndex + 1], output + '\n'); }
if (!report.schemaColumnsReady) process.exitCode = 1;
