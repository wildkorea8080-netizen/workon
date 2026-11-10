import { NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { cancelBatch, getBatch } from '@/lib/apps/batches';

export const dynamic = 'force-dynamic';
const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });

/** 일괄 실행 하나와 줄들(0077) — 만든 사람만(관리자도 남의 것은 보지 못한다) */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  const out = await getBatch(session.user.id, params.id);
  if (!out) return fail('일괄 실행을 찾을 수 없습니다.', 404);
  return NextResponse.json({ ok: true, data: out });
}

/** 그만두기 — 기다리던 줄은 건너뛰고, 이미 실행 중인 줄은 끝까지 간다 */
export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  const out = await cancelBatch(session.user.id, params.id);
  if (!out.ok) return fail(out.message, out.status);
  return NextResponse.json({ ok: true, data: { cancelled: true } });
}
