import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

    // Supabase는 실패를 던지지 않고 돌려준다 — 예전엔 못 적어도 읽음으로 답해 다음에 공지가 다시 떴다(2026-11-17)
    const { error } = await supabaseAdmin.from('notice_reads')
      .upsert({ notice_id: params.id, user_id: session.user.id }, { onConflict: 'notice_id,user_id' });
    if (error) return NextResponse.json({ ok: false, error: '읽음을 저장하지 못했습니다.' }, { status: 500 });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
