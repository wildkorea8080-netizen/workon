import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getActorScope } from '@/lib/actor-scope';
import { listManagedForbiddenWords } from '@/lib/forbidden-words-scope';
import { writeUsageLog } from '@/lib/assistant/persist';
import { cleanForbiddenContext, cleanForbiddenWord, FORBIDDEN_WORDS_PER_DEPARTMENT } from '@/lib/forbidden-match';

export async function GET(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    if (!isAdminSession(session)) {
      return NextResponse.json(
        { ok: false, error: { message: '관리자 권한이 필요합니다.' } },
        { status: 403 }
      );
    }

    // 금지어 목록 — 관리 범위 부서의 것만(2026-11-12 — 예전에는 조건이 없어 모든 기관의 금지어가 보였다)
    const actor = await getActorScope(session);
    if (!actor || !actor.organizationId) {
      return NextResponse.json(
        { ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } },
        { status: 403 }
      );
    }
    const listed = await listManagedForbiddenWords(actor.managedDepartmentIds);

    if ('error' in listed) {
      return NextResponse.json(
        { ok: false, error: { message: '금지어 목록 조회 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, data: listed.rows });
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

    if (!isAdminSession(session)) {
      return NextResponse.json(
        { ok: false, error: { message: '관리자 권한이 필요합니다.' } },
        { status: 403 }
      );
    }

    const body = (await request.json().catch(() => null)) as { word?: unknown; context?: unknown } | null;
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ ok: false, error: { message: '요청 형식이 올바르지 않습니다.' } }, { status: 400 });
    }

    // 다듬어 저장한다(2026-11-18) — 보이지 않는 글자가 딸려 온 금지어는 영영 걸리지 않고, 한 글자 금지어는 그 글자가 든 질문을 모두 막는다
    const cleaned = cleanForbiddenWord(body.word);
    if (!cleaned.ok) {
      return NextResponse.json({ ok: false, error: { message: cleaned.message } }, { status: 400 });
    }
    const word = cleaned.word;
    const context = cleanForbiddenContext(body.context);

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
      .eq('word', word)
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

    // 부서마다 상한 — 대화마다 이 부서와 상위 부서의 금지어를 모두 읽어 맞춘다. 못 세면 넣지 않는다
    const { count: wordCount, error: countError } = await supabaseAdmin
      .from('forbidden_words')
      .select('id', { count: 'exact', head: true })
      .eq('department_id', user.department_id);
    if (countError || typeof wordCount !== 'number') {
      return NextResponse.json(
        { ok: false, error: { message: '금지어 수를 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' } },
        { status: 500 }
      );
    }
    if (wordCount >= FORBIDDEN_WORDS_PER_DEPARTMENT) {
      return NextResponse.json(
        { ok: false, error: { message: `금지어는 부서마다 ${FORBIDDEN_WORDS_PER_DEPARTMENT}개까지 둘 수 있습니다. 쓰지 않는 금지어를 지운 뒤 추가해 주세요.` } },
        { status: 400 }
      );
    }

    // 금지어 추가
    const { data: newWord, error: insertError } = await supabaseAdmin
      .from('forbidden_words')
      .insert({
        department_id: user.department_id,
        word,
        context,
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
    await writeUsageLog({
      departmentId: user.department_id,
      userId: session.user.id,
      action: 'add_forbidden_word',
      resourceType: 'forbidden_word',
      resourceId: newWord.id,
      details: { word },
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