import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function GET(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    if (!isAdminSession(session)) {
      return NextResponse.json(
        { success: false, error: { message: '관리자 권한이 필요합니다.' } },
        { status: 403 }
      );
    }

    // 금지어 목록 조회
    const { data: forbiddenWords, error } = await supabaseAdmin
      .from('forbidden_words')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json(
        { ok: false, error: { message: '금지어 목록 조회 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, data: forbiddenWords });
  } catch (error) {
    console.error('금지어 목록 조회 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { word, context } = body;

    if (!word || typeof word !== 'string' || !word.trim()) {
      return NextResponse.json(
        { ok: false, error: { message: '금지어는 필수 입력 항목입니다.' } },
        { status: 400 }
      );
    }

    // 사용자의 부서 확인
    const { data: user, error: userError } = await supabaseAdmin
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

    // 중복 체크
    const { data: existing, error: checkError } = await supabaseAdmin
      .from('forbidden_words')
      .select('id')
      .eq('department_id', user.department_id)
      .eq('word', word.trim())
      .single();

    if (checkError && checkError.code !== 'PGRST116') { // PGRST116 = no rows returned
      return NextResponse.json(
        { ok: false, error: { message: '중복 체크 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    if (existing) {
      return NextResponse.json(
        { ok: false, error: { message: '이미 등록된 금지어입니다.' } },
        { status: 409 }
      );
    }

    // 금지어 추가
    const { data: newWord, error: insertError } = await supabaseAdmin
      .from('forbidden_words')
      .insert({
        department_id: user.department_id,
        word: word.trim(),
        context: context?.trim() || null,
      })
      .select()
      .single();

    if (insertError) {
      return NextResponse.json(
        { ok: false, error: { message: '금지어 추가 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    // 사용 로그 기록
    await supabaseAdmin.from('usage_logs').insert({
      department_id: user.department_id,
      user_id: session.user.id,
      action: 'add_forbidden_word',
      resource_type: 'forbidden_word',
      resource_id: newWord.id,
      details: { word: word.trim() },
    });

    return NextResponse.json({ ok: true, data: newWord });
  } catch (error) {
    console.error('금지어 추가 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}