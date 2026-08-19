/**
 * 기존 기관에 기본 비서 세트를 설치한다.
 *
 *   npm run seed:agents            -- 넣기
 *   npm run seed:agents -- --dry   -- 무엇이 들어갈지만 보기
 *
 * 새로 만드는 기관은 슈퍼관리자 기관 등록 시 자동으로 깔린다(P3-2).
 * 이 스크립트는 그 이전에 만들어진 기관을 메우는 용도다.
 *
 * 비서 정의는 `src/lib/agent-presets.ts` 한 곳에 있다. 스크립트가 목록을
 * 따로 들고 있으면 한쪽만 바뀌어 기관마다 다른 세트를 받게 된다.
 *
 * 0019_agent_catalog.sql이 적용돼 있어야 한다.
 */
import { readFileSync } from 'fs';

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const eq = line.indexOf('=');
  if (eq > 0 && !line.trimStart().startsWith('#')) {
    const k = line.slice(0, eq).trim();
    if (!process.env[k]) process.env[k] = line.slice(eq + 1).trim();
  }
}
// config.ts가 import 시점에 필수 환경변수를 검사한다. 이 스크립트에는 없어도 되는 것들을 채운다.
for (const k of ['NEXTAUTH_URL', 'NEXTAUTH_SECRET']) {
  if (!process.env[k]) process.env[k] = 'seed-placeholder';
}

const dryRun = process.argv.includes('--dry');

const { createClient } = await import('@supabase/supabase-js');
const { presetsForOrganizationType } = await import('../src/lib/agent-presets.ts');
const { installPresetAgents } = await import('../src/lib/install-presets.ts');

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── 0019 적용 여부 ──
const { error: schemaError } = await db
  .from('agents')
  .select('is_published, display_order, agent_type')
  .limit(1);

if (schemaError) {
  console.error('0019_agent_catalog.sql이 적용되지 않았습니다.');
  console.error(`  ${schemaError.message}`);
  process.exit(1);
}

const { data: orgs } = await db.from('organizations').select('id, name, type').order('created_at');

if (!orgs?.length) {
  console.error('기관이 없습니다.');
  process.exit(1);
}

for (const org of orgs) {
  // 기관마다 대상 부서를 고른다. 공식 비서가 가장 많은 부서를 쓰면
  // 관리자가 실제로 쓰는 부서라 수정·삭제도 그 관리 범위 안에 들어온다.
  const { data: depts } = await db
    .from('departments')
    .select('id, name')
    .eq('organization_id', org.id)
    .order('created_at');

  if (!depts?.length) {
    console.log(`\n[${org.name}] 부서가 없어 건너뜁니다.`);
    continue;
  }

  const { data: existing } = await db
    .from('agents')
    .select('department_id')
    .eq('is_personal', false)
    .in('department_id', depts.map((d) => d.id));

  const tally = new Map();
  for (const row of existing ?? []) {
    if (row.department_id) tally.set(row.department_id, (tally.get(row.department_id) ?? 0) + 1);
  }
  const departmentId = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? depts[0].id;
  const deptName = depts.find((d) => d.id === departmentId)?.name;

  const presets = presetsForOrganizationType(org.type);
  console.log(`\n[${org.name}] (${org.type ?? '유형 없음'}) → 부서 "${deptName}"`);
  console.log(`  세트 ${presets.length}개`);

  if (dryRun) {
    for (const p of presets) {
      const tools = p.connectors?.length ? `  [${p.connectors.join(', ')}]` : '';
      console.log(`    ${p.icon} ${p.name.padEnd(22)} ${p.category}${tools}`);
    }
    continue;
  }

  const result = await installPresetAgents(org.id, departmentId, org.type);
  console.log(`  설치 ${result.installed}개 / 건너뜀 ${result.skipped}개 / 카테고리 ${result.categories}개 추가`);
}

if (dryRun) {
  console.log('\n--dry 이므로 넣지 않았습니다.');
} else {
  console.log('\n완료. 확인: npm run db:check');
}
