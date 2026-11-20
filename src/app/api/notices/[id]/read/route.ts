import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

    // uuid가 아니거나 없는 공지는 400·404(2026-11-19 — 예전엔 DB 오류 500)
    if (!UUID.test(params.id)) return NextResponse.json({ ok: false, error: '공지를 찾을 수 없습니다.' }, { status: 400 });
    // 대리 접근 중에는 기관 관리자 이름으로 읽음을 남기지 않는다(그 사람이 읽은 것이 아니다)
    if ((session.user as { isImpersonating?: boolean }).isImpersonating) return NextResponse.json({ ok: true });

    // Supabase는 실패를 던지지 않고 돌려준다 — 예전엔 못 적어도 읽음으로 답해 다음에 공지가 다시 떴다(2026-11-17)
    const { error } = await supabaseAdmin.from('notice_reads')
      .upsert({ notice_id: params.id, user_id: session.user.id }, { onConflict: 'notice_id,user_id' });
    if (error?.code === '23503') return NextResponse.json({ ok: false, error: '공지를 찾을 수 없습니다.' }, { status: 404 });
    if (error) return NextResponse.json({ ok: false, error: '읽음을 저장하지 못했습니다.' }, { status: 500 });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[notices read]', err?.code ?? 'exception');
    return NextResponse.json({ ok: false, error: '읽음을 저장하지 못했습니다.' }, { status: 500 });
  }
}
