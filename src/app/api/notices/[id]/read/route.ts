import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

    await supabaseAdmin.from('notice_reads')
      .upsert({ notice_id: params.id, user_id: session.user.id }, { onConflict: 'notice_id,user_id' });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
