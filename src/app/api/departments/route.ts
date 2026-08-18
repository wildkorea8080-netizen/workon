import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export interface DepartmentNode {
  id: string;
  name: string;
  parent_id: string | null;
  description: string | null;
  userCount: number;
  agentCount: number;
  children: DepartmentNode[];
}

/** 관리자가 속한 기관 id. 모든 부서 작업을 이 기관으로 한정한다. */
async function getAdminOrganizationId(departmentId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('departments')
    .select('organization_id')
    .eq('id', departmentId)
    .maybeSingle();
  return data?.organization_id ?? null;
}

async function requireAdminOrg() {
  const session = await getServerAuthSession();
  if (!session?.user?.id || !isAdminSession(session)) {
    return { error: NextResponse.json({ ok: false, error: { message: '관리자 권한이 필요합니다.' } }, { status: 403 }) };
  }

  const departmentId = session.user.departmentId;
  if (!departmentId) {
    return { error: NextResponse.json({ ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } }, { status: 403 }) };
  }

  const organizationId = await getAdminOrganizationId(departmentId);
  if (!organizationId) {
    return { error: NextResponse.json({ ok: false, error: { message: '기관 정보를 찾을 수 없습니다.' } }, { status: 409 }) };
  }

  return { session, departmentId, organizationId };
}

/** 평면 목록을 트리로 조립한다. 부모를 못 찾은 노드는 최상위로 올린다. */
function buildTree(
  rows: { id: string; name: string; parent_id: string | null; description: string | null }[],
  userCounts: Map<string, number>,
  agentCounts: Map<string, number>
): DepartmentNode[] {
  const nodes = new Map<string, DepartmentNode>();
  for (const row of rows) {
    nodes.set(row.id, {
      ...row,
      userCount: userCounts.get(row.id) ?? 0,
      agentCount: agentCounts.get(row.id) ?? 0,
      children: [],
    });
  }

  const roots: DepartmentNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parent_id ? nodes.get(node.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sortRecursive = (list: DepartmentNode[]) => {
    list.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    for (const node of list) sortRecursive(node.children);
  };
  sortRecursive(roots);

  return roots;
}

/** 기관의 부서 트리 */
export async function GET() {
  const ctx = await requireAdminOrg();
  if ('error' in ctx) return ctx.error;

  const { data: departments, error } = await supabaseAdmin
    .from('departments')
    .select('id, name, parent_id, description')
    .eq('organization_id', ctx.organizationId);

  if (error) {
    console.error('[departments GET]', error);
    return NextResponse.json({ ok: false, error: { message: '부서 목록 조회에 실패했습니다.' } }, { status: 500 });
  }

  const ids = (departments ?? []).map((d: { id: string }) => d.id);

  // 부서별 인원/비서 수 — 삭제 가능 여부 판단과 화면 표시에 쓴다
  const [{ data: users }, { data: agents }] = await Promise.all([
    supabaseAdmin.from('users').select('department_id').in('department_id', ids),
    supabaseAdmin.from('agents').select('department_id').in('department_id', ids),
  ]);

  const count = (rows: { department_id: string | null }[] | null) => {
    const map = new Map<string, number>();
    for (const row of rows ?? []) {
      if (row.department_id) map.set(row.department_id, (map.get(row.department_id) ?? 0) + 1);
    }
    return map;
  };

  return NextResponse.json({
    ok: true,
    data: buildTree(departments ?? [], count(users), count(agents)),
    meta: { myDepartmentId: ctx.departmentId },
  });
}

/** 부서 생성 */
export async function POST(request: NextRequest) {
  const ctx = await requireAdminOrg();
  if ('error' in ctx) return ctx.error;

  const body = await request.json();
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const parentId = typeof body.parent_id === 'string' && body.parent_id ? body.parent_id : null;

  if (!name) {
    return NextResponse.json({ ok: false, error: { message: '부서명을 입력해주세요.' } }, { status: 400 });
  }

  // 상위 부서는 반드시 같은 기관 소속이어야 한다
  if (parentId) {
    const { data: parent } = await supabaseAdmin
      .from('departments')
      .select('id')
      .eq('id', parentId)
      .eq('organization_id', ctx.organizationId)
      .maybeSingle();
    if (!parent) {
      return NextResponse.json({ ok: false, error: { message: '상위 부서를 찾을 수 없습니다.' } }, { status: 400 });
    }
  }

  const slug =
    name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9가-힣-]/g, '') +
    '-' + Date.now().toString(36);

  const { data: created, error } = await supabaseAdmin
    .from('departments')
    .insert({ name, slug, parent_id: parentId, organization_id: ctx.organizationId })
    .select('id, name, parent_id, description')
    .single();

  if (error) {
    // (organization_id, name) 유니크 위반
    if (error.code === '23505') {
      return NextResponse.json({ ok: false, error: { message: '같은 이름의 부서가 이미 있습니다.' } }, { status: 409 });
    }
    console.error('[departments POST]', error);
    return NextResponse.json({ ok: false, error: { message: '부서 생성에 실패했습니다.' } }, { status: 500 });
  }

  return NextResponse.json({ ok: true, data: created });
}
