/**
 * 테넌트 격리 실측 점검.
 *
 *   npm run isolation:check
 *
 * CLAUDE.md가 🔴로 표시한 구조적 위험을 실제 DB에서 확인한다.
 *
 *   "RLS 미사용 — 테넌트 격리가 애플리케이션 코드에만 의존"
 *
 * 이 구조에서 RLS를 켜는 것은 실효가 거의 없다. 앱이 전부 supabaseAdmin
 * (service role)으로 접근하는데 service role은 RLS를 우회하기 때문이다.
 * 실제 위험은 "라우트 하나가 .eq('department_id', ...)를 빠뜨리는 것"이고,
 * 그건 정책이 아니라 실측으로 잡아야 한다.
 *
 * 단위 테스트로는 못 잡는다. 목을 세우면 격리가 되는 것처럼 보이지만,
 * 실제로 깨지는 것은 RPC 결과·트리거·기존 데이터가 얽힌 자리다.
 * 그래서 db:check·connector:probe와 같은 계열로 둔다.
 *
 * 읽는 법: '위반'이 하나라도 나오면 그 자리에서 타 기관 자료가 보인다는 뜻이다.
 */
import { readFileSync } from 'fs';

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const eq = line.indexOf('=');
  if (eq > 0 && !line.trimStart().startsWith('#')) {
    const k = line.slice(0, eq).trim();
    if (!process.env[k]) process.env[k] = line.slice(eq + 1).trim();
  }
}
for (const k of ['NEXTAUTH_URL', 'NEXTAUTH_SECRET']) {
  if (!process.env[k]) process.env[k] = 'isolation-check';
}

const { createClient } = await import('@supabase/supabase-js');
const scope = await import('../src/lib/department-scope.ts');

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

let violations = 0;
const pass = (msg) => console.log(`OK    ${msg}`);
const fail = (msg, detail) => {
  violations += 1;
  console.log(`위반  ${msg}`);
  if (detail) console.log(`      ${detail}`);
};

// ── 준비 ────────────────────────────────────────────────────
const { data: orgs } = await db.from('organizations').select('id, name').order('created_at');
const { data: depts } = await db.from('departments').select('id, name, organization_id');

const orgName = new Map(orgs.map((o) => [o.id, o.name]));
const deptById = new Map(depts.map((d) => [d.id, d]));

console.log(`기관 ${orgs.length}개 / 부서 ${depts.length}개`);

if (orgs.length < 2) {
  console.log('\n기관이 하나뿐이라 교차 접근을 확인할 수 없습니다.');
  console.log('기관을 하나 더 등록한 뒤 다시 실행하세요.');
  process.exit(0);
}

// ── 1. 부서 범위 함수가 기관을 넘지 않는가 ──────────────────
console.log('\n=== 1. 부서 범위 함수 ===');
for (const [label, fn] of [
  ['getVisibleDepartmentIds (직원이 볼 범위)', scope.getVisibleDepartmentIds],
  ['getManagedDepartmentIds (관리자 관리 범위)', scope.getManagedDepartmentIds],
  ['getSharedDepartmentIds (공유 영향 범위)', scope.getSharedDepartmentIds],
]) {
  let crossed = null;
  for (const d of depts) {
    const ids = await fn(d.id);
    const outside = ids.filter((id) => deptById.get(id)?.organization_id !== d.organization_id);
    if (outside.length > 0) {
      crossed = `${d.name} → ${outside.map((id) => deptById.get(id)?.name ?? id).join(', ')}`;
      break;
    }
  }
  if (crossed) fail(`${label} 이 기관 경계를 넘음`, crossed);
  else pass(label);
}

// ── 2. 자료가 기관 밖에서 보이는가 ──────────────────────────
// visibilityFilter가 만드는 조건을 그대로 써서, 각 기관 부서 기준으로
// 조회했을 때 타 기관 자료가 섞이는지 본다. 라우트가 쓰는 것과 같은 경로다.
console.log('\n=== 2. 자료 조회 (visibilityFilter) ===');
for (const [table, labelCol] of [
  ['agents', 'name'],
  // documents는 이름 컬럼이 title이다. 표마다 다르므로 함께 적어 둔다.
  ['documents', 'title'],
]) {
  let leaked = null;
  let queryFailed = false;

  for (const d of depts) {
    const s = await scope.getAccessScope(d.id);
    const { data, error } = await db
      .from(table)
      .select(`id, ${labelCol}, organization_id`)
      .or(scope.visibilityFilter(s));

    if (error) {
      fail(`${table} 조회 실패`, error.message);
      queryFailed = true;
      break;
    }

    const outside = (data ?? []).filter((row) => row.organization_id !== d.organization_id);
    if (outside.length > 0) {
      leaked = `${orgName.get(d.organization_id)}/${d.name} 에서 ${outside.length}건 (예: ${outside[0][labelCol]})`;
      break;
    }
  }

  if (queryFailed) continue;
  if (leaked) fail(`${table} 가 타 기관 자료를 노출`, leaked);
  else pass(`${table} — 모든 부서에서 자기 기관 것만 조회됨`);
}

// ── 3. 기관 연결이 빠진 행 ──────────────────────────────────
// organization_id가 NULL이면 visibilityFilter의 기관 조건에 걸리지 않아
// 아무에게도 안 보이거나, 반대로 부서 조건으로만 걸려 의도와 어긋난다.
console.log('\n=== 3. 기관 미연결 행 ===');
for (const table of ['departments', 'agents', 'documents', 'usage_logs', 'conversations']) {
  const { count, error } = await db
    .from(table)
    .select('id', { count: 'exact', head: true })
    .is('organization_id', null);

  if (error) {
    // conversations 등 organization_id가 없는 표는 건너뛴다
    console.log(`      ${table} — 해당 없음`);
    continue;
  }
  if ((count ?? 0) > 0) fail(`${table} 에 기관 미연결 ${count}건`);
  else pass(`${table} 0건`);
}

// ── 4. 부서와 자료의 기관이 어긋나는가 ──────────────────────
// organization_id는 트리거가 department_id로부터 채운다. 둘이 어긋나면
// 트리거가 없거나 누가 직접 수정한 것이고, 그 행은 격리가 깨진 상태다.
console.log('\n=== 4. 부서-자료 기관 일치 ===');
for (const [table, labelCol] of [
  ['agents', 'name'],
  ['documents', 'title'],
]) {
  const { data, error } = await db
    .from(table)
    .select(`id, ${labelCol}, department_id, organization_id`);

  if (error) {
    fail(`${table} 조회 실패`, error.message);
    continue;
  }

  const mismatched = (data ?? []).filter((row) => {
    const dept = deptById.get(row.department_id);
    return dept && row.organization_id && dept.organization_id !== row.organization_id;
  });

  if (mismatched.length > 0) {
    fail(
      `${table} ${mismatched.length}건의 기관이 소속 부서와 다름`,
      mismatched.slice(0, 3).map((r) => r[labelCol]).join(', ')
    );
  } else {
    pass(`${table} — 부서와 기관이 일치`);
  }
}

// ── 5. 대화·메시지 ──────────────────────────────────────────
// messages에는 department_id가 없다. conversations를 거쳐야만 범위가 정해지므로
// 고아 메시지가 있으면 어느 기관 것인지 판정할 수 없다.
console.log('\n=== 5. 대화·메시지 ===');
{
  const { data: convs } = await db.from('conversations').select('id');
  const convIds = new Set((convs ?? []).map((c) => c.id));

  const { data: msgs } = await db.from('messages').select('id, conversation_id');
  const orphans = (msgs ?? []).filter((m) => !convIds.has(m.conversation_id));

  if (orphans.length > 0) fail(`대화에 연결되지 않은 메시지 ${orphans.length}건`);
  else pass(`메시지 ${msgs?.length ?? 0}건 모두 대화에 연결됨`);
}

// ── 결과 ────────────────────────────────────────────────────
console.log('');
if (violations === 0) {
  console.log('격리 위반 없음.');
  process.exit(0);
}
console.log(`격리 위반 ${violations}건. 위 항목을 확인하세요.`);
process.exit(1);
