import { NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { actorScopeOr503 } from '@/lib/actor-scope-response';
import { readJsonObject, BAD_BODY_MESSAGE } from '@/lib/request-body';
import { AGENT_SHARES_MAX, defaultAgentSharesIo, getAgentShares, getShareDepartments, parseShareDepartments, parseShareEmails, setAgentShares, setShareDepartments } from '@/lib/agent-shares';

export const dynamic = 'force-dynamic';
const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });

/** 나만의 비서를 함께 쓰는 사람(0128) — 주인만 본다 */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  if ((session.user as { isImpersonating?: boolean }).isImpersonating) return fail('대리 접근 중에는 함께 쓰기를 볼 수 없습니다.', 403);
  const actor = await actorScopeOr503(session);
  if (actor instanceof Response) return actor;
  if (!actor) return fail('소속을 확인할 수 없습니다.', 403);
  const io = defaultAgentSharesIo();
  const out = await getAgentShares(io, actor, params.id);
  if (!out.ok) return fail(out.message, out.status);
  // 함께 쓰는 부서(0130)와 고를 거리
  const depts = await getShareDepartments(io, actor, params.id);
  if (!depts.ok) return fail(depts.message, depts.status);
  return NextResponse.json({ ok: true, data: { shares: out.shares, max: AGENT_SHARES_MAX, departments: depts.selected, departmentChoices: depts.choices } });
}

/** 함께 쓸 사람을 통째로 정한다 — `{ emails: string[], editors?: string[] }`(editors는 그중 함께 고칠 사람, 0129)(빈 목록이면 모두 뺌, 20명까지). 주인만, 대리 접근 중에는 안 됨 */
export async function PUT(request: Request, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  if ((session.user as { isImpersonating?: boolean }).isImpersonating) return fail('대리 접근 중에는 함께 쓰기를 바꿀 수 없습니다.', 403);
  const body = await readJsonObject(request);
  if (!body) return fail(BAD_BODY_MESSAGE, 400);
  // 사람(emails·editors)과 부서(departments, 0130)는 따로 — 보내지 않은 쪽은 그대로 둔다
  if (body.emails === undefined && body.departments === undefined) return fail('바꿀 사람(emails)이나 부서(departments)를 보내 주세요.', 400);
  const emails = body.emails === undefined ? null : parseShareEmails(body.emails);
  if (body.emails !== undefined && !emails) return fail(`함께 쓸 사람의 이메일을 ${AGENT_SHARES_MAX}명까지 적어 주세요.`, 400);
  const departments = body.departments === undefined ? null : parseShareDepartments(body.departments);
  if (body.departments !== undefined && !departments) return fail(`함께 쓸 부서를 ${AGENT_SHARES_MAX}곳까지 목록에서 골라 주세요.`, 400);
  // 함께 고칠 사람(0129) — 없으면 아무도 고치지 않음
  const editors = body.editors === undefined ? [] : parseShareEmails(body.editors);
  if (!editors) return fail('함께 고칠 사람의 이메일을 확인해 주세요.', 400);
  const actor = await actorScopeOr503(session);
  if (actor instanceof Response) return actor;
  if (!actor) return fail('소속을 확인할 수 없습니다.', 403);
  const io = defaultAgentSharesIo();
  if (departments) {
    const set = await setShareDepartments(io, actor, params.id, departments);
    if (!set.ok) return fail(set.message, set.status);
  }
  if (emails) {
    const out = await setAgentShares(io, actor, params.id, emails, editors);
    if (!out.ok) return fail(out.message, out.status);
  }
  // 저장한 뒤 다시 읽어 돌려준다(사람·부서 둘 다)
  const shares = await getAgentShares(io, actor, params.id);
  if (!shares.ok) return fail(shares.message, shares.status);
  const depts = await getShareDepartments(io, actor, params.id);
  if (!depts.ok) return fail(depts.message, depts.status);
  return NextResponse.json({ ok: true, data: { shares: shares.shares, max: AGENT_SHARES_MAX, departments: depts.selected, departmentChoices: depts.choices } });
}
