import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    // 금지어는 관리자가 정하는 보안 통제다. 직원이 끄거나 지울 수 있으면
    // 통제 자체가 무의미해진다. POST에는 이 검사가 있었는데 여기만 빠져 있었다.
    if (!isAdminSession(session)) {
      return NextResponse.json(
        { ok: false, error: { message: '관리자 권한이 필요합니다.' } },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { is_active } = body;

    if (typeof is_active !== 'boolean') {
      return NextResponse.json(
        { ok: false, error: { message: 'is_active 값은 필수입니다.' } },
        { status: 400 }
      );
    }

    // 사용자의 부서 확인
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('department_id')
      .eq('id', session.user.id)
      .single();

    if (userError || !user?.department_id) {
      return NextResponse.json(
        { ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } },
        { status: 403 }
      );
    }

    // 금지어 존재 및 권한 확인
    const { data: forbiddenWord, error: findError } = await supabase
      .from('forbidden_words')
      .select('*')
      .eq('id', params.id)
      .eq('department_id', user.department_id)
      .single();

    if (findError || !forbiddenWord) {
      return NextResponse.json(
        { ok: false, error: { message: '금지어를 찾을 수 없습니다.' } },
        { status: 404 }
      );
    }

    // 금지어 상태 업데이트
    const { data: updatedWord, error: updateError } = await supabase
      .from('forbidden_words')
      .update({
        is_active: is_active,
        updated_at: new Date().toISOString(),
      })
      .eq('id', params.id)
      .eq('department_id', user.department_id)
      .select()
      .single();

    if (updateError) {
      return NextResponse.json(
        { ok: false, error: { message: '금지어 업데이트 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    // 사용 로그 기록
    await supabase.from('usage_logs').insert({
      department_id: user.department_id,
      user_id: session.user.id,
      action: is_active ? 'activate_forbidden_word' : 'deactivate_forbidden_word',
      resource_type: 'forbidden_word',
      resource_id: params.id,
      details: { word: forbiddenWord.word, is_active },
    });

    return NextResponse.json({ ok: true, data: updatedWord });
  } catch (error) {
    console.error('금지어 업데이트 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    // 금지어는 관리자가 정하는 보안 통제다. 직원이 끄거나 지울 수 있으면
    // 통제 자체가 무의미해진다. POST에는 이 검사가 있었는데 여기만 빠져 있었다.
    if (!isAdminSession(session)) {
      return NextResponse.json(
        { ok: false, error: { message: '관리자 권한이 필요합니다.' } },
        { status: 403 }
      );
    }

    // 사용자의 부서 확인
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('department_id')
      .eq('id', session.user.id)
      .single();

    if (userError || !user?.department_id) {
      return NextResponse.json(
        { ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } },
        { status: 403 }
      );
    }

    // 금지어 존재 및 권한 확인
    const { data: forbiddenWord, error: findError } = await supabase
      .from('forbidden_words')
      .select('*')
      .eq('id', params.id)
      .eq('department_id', user.department_id)
      .single();

    if (findError || !forbiddenWord) {
      return NextResponse.json(
        { ok: false, error: { message: '금지어를 찾을 수 없습니다.' } },
        { status: 404 }
      );
    }

    // 금지어 삭제
    const { error: deleteError } = await supabase
      .from('forbidden_words')
      .delete()
      .eq('id', params.id)
      .eq('department_id', user.department_id);

    if (deleteError) {
      return NextResponse.json(
        { ok: false, error: { message: '금지어 삭제 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    // 사용 로그 기록
    await supabase.from('usage_logs').insert({
      department_id: user.department_id,
      user_id: session.user.id,
      action: 'delete_forbidden_word',
      resource_type: 'forbidden_word',
      resource_id: params.id,
      details: { word: forbiddenWord.word },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('금지어 삭제 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}