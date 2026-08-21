import { NextRequest, NextResponse } from 'next/server';
import { resolveModelForDepartment } from '@/lib/model-policy';
import { getServerAuthSession } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { callClaudeAPI, type ClaudeMessage } from '@/lib/claude';
import type { ReportTemplate } from '@/lib/db';
import { estimateCostUsd, estimateCostKrw } from '@/lib/models';
import { checkTokenLimit, limitMessage } from '@/lib/usage-limit';

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
    const { template_id, form_data } = body;

    if (!template_id || typeof template_id !== 'string') {
      return NextResponse.json(
        { ok: false, error: { message: '템플릿 ID는 필수입니다.' } },
        { status: 400 }
      );
    }

    if (!form_data || typeof form_data !== 'object') {
      return NextResponse.json(
        { ok: false, error: { message: '양식 데이터는 필수입니다.' } },
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


    // 토큰을 소비하는 라우트는 한도를 확인해야 한다. 이 검사가 없어서
    // 예산을 소진한 기관도 이 경로로는 계속 쓸 수 있었다 — 차단이
    // 동작한다고 믿는데 새는 구멍이 남아 있던 자리다.
    const limitStatus = await checkTokenLimit(user.department_id, session.user.id);
    if (!limitStatus.allowed) {
      return NextResponse.json(
        { ok: false, error: { message: limitMessage(limitStatus) } },
        { status: 429 }
      );
    }

    // 템플릿 확인 및 권한 체크
    const { data: template, error: templateError } = await supabase
      .from('report_templates')
      .select('*')
      .eq('id', template_id)
      .eq('is_active', true)
      .single();

    if (templateError || !template) {
      return NextResponse.json(
        { ok: false, error: { message: '템플릿을 찾을 수 없습니다.' } },
        { status: 404 }
      );
    }

    if (template.department_id !== user.department_id) {
      return NextResponse.json(
        { ok: false, error: { message: '해당 템플릿에 접근할 권한이 없습니다.' } },
        { status: 403 }
      );
    }

    // 템플릿 콘텐츠에서 플레이스홀더 교체
    let prompt = template.content;
    for (const [key, value] of Object.entries(form_data)) {
      const placeholder = `{{${key}}}`;
      prompt = prompt.replace(new RegExp(placeholder, 'g'), String(value));
    }

    // Claude를 사용하여 보고서 생성
    const systemPrompt = `당신은 전문적인 비즈니스 보고서 작성자입니다. 
다음 지침을 따라 보고서를 작성하세요:
- 정중하고 전문적인 한국어 비즈니스 문체를 사용하세요
- 구조화된 형식을 유지하세요
- 객관적이고 사실에 기반한 내용을 작성하세요
- 불필요한 수사나 과장된 표현을 피하세요
- 보고서의 목적과 맥락에 맞는 적절한 톤을 유지하세요`;

    const claudeMessages: ClaudeMessage[] = [
      { role: 'user', content: prompt },
    ];

    const modelId = await resolveModelForDepartment(user.department_id);
    const claudeResponse = await callClaudeAPI(claudeMessages, systemPrompt, 4096, modelId);

    // 보고서 내용 포함하여 사용 로그 기록
    const { data: savedLog } = await supabaseAdmin.from('usage_logs').insert({
      department_id: user.department_id,
      user_id: session.user.id,
      action: 'generate_report',
      resource_type: 'report_template',
      resource_id: template.id,
      details: {
        template_name: template.name,
        template_id: template.id,
        report_content: claudeResponse.content,
        model: claudeResponse.usage.model,
        input_tokens: claudeResponse.usage.input_tokens,
        output_tokens: claudeResponse.usage.output_tokens,
        cost_usd: estimateCostUsd(claudeResponse.usage, claudeResponse.usage.model),
        cost_krw: estimateCostKrw(claudeResponse.usage, claudeResponse.usage.model),
      },
    }).select('id').single();

    return NextResponse.json({
      ok: true,
      data: {
        report: claudeResponse.content,
        template_name: template.name,
        saved_id: savedLog?.id ?? null,
        usage: claudeResponse.usage,
      },
    });
  } catch (error) {
    console.error('보고서 생성 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}

// 템플릿 목록 조회
export async function GET(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
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

    // 부서의 활성 템플릿 목록 조회
    const { data: templates, error } = await supabase
      .from('report_templates')
      .select('*')
      .eq('department_id', user.department_id)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json(
        { ok: false, error: { message: '템플릿 목록 조회 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, data: templates });
  } catch (error) {
    console.error('템플릿 목록 조회 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}