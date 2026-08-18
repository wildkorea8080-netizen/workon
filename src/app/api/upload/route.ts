import { NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { logSecurityEvent } from '@/lib/filter';
import type { ApiResponse } from '@/lib/db';
import { checkTokenLimit, limitMessage } from '@/lib/usage-limit';
import { estimateCostUsd, estimateCostKrw } from '@/lib/models';

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'application/x-hwp',
  'application/haansofthwp',
  'application/hwp+zip'
];

// HWP·DOCX는 브라우저가 MIME을 비우거나 application/octet-stream으로 보내는
// 경우가 많아 확장자를 1차 기준으로 삼는다.
const ALLOWED_EXTENSIONS = ['.pdf', '.docx', '.txt', '.hwp', '.hwpx'];

const DANGEROUS_FILENAME_PATTERNS = [
  /\.\./,           // 디렉토리 트래버설
  /^[.-]/,          // 점이나 대시로 시작
  /[<>:"|?*]/,      // Windows 예약 문자
  /\s+$/,           // 끝에 공백
  /[\x00-\x1f\x7f-\x9f]/,  // 제어 문자
];

const BLOCKED_EXTENSIONS = [
  'exe', 'bat', 'cmd', 'com', 'pif', 'scr', 'vbs', 'js', 'jar',
  'php', 'asp', 'jsp', 'cgi', 'pl', 'py', 'sh', 'dll', 'so'
];

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Vercel Pro: 최대 60초

export async function POST(request: Request) {
  const session = await getServerAuthSession();

  if (!session?.user?.id) {
    return NextResponse.json<ApiResponse<null>>(
      { ok: false, error: { message: '로그인이 필요합니다.' } },
      { status: 401 }
    );
  }

  const formData = await request.formData();
  const file = formData.get('file');
  // 단일 agentId 또는 복수 agentIds 모두 지원
  const agentIdSingle = formData.get('agentId')?.toString();
  const agentIdsRaw   = formData.getAll('agentIds').map(v => v.toString());
  const agentIds: string[] = agentIdsRaw.length > 0 ? agentIdsRaw
    : agentIdSingle ? [agentIdSingle] : [];
  const title = formData.get('title')?.toString() ?? '';

  if (agentIds.length === 0) {
    return NextResponse.json<ApiResponse<null>>(
      { ok: false, error: { message: '에이전트를 하나 이상 선택해주세요.' } },
      { status: 400 }
    );
  }
  // 권한 체크는 첫 번째 agentId 기준
  const agentId = agentIds[0];

  // 관리자이거나, 본인 소유의 개인 비서인 경우에만 허용
  if (session.user.role !== 'ADMIN') {
    const { data: agent } = await supabaseAdmin
      .from('agents')
      .select('is_personal, owner_id')
      .eq('id', agentId)
      .maybeSingle();

    if (!agent?.is_personal || agent.owner_id !== session.user.id) {
      return NextResponse.json<ApiResponse<null>>(
        { ok: false, error: { message: '권한이 없습니다.' } },
        { status: 403 }
      );
    }
  }

  if (!(file instanceof File)) {
    return NextResponse.json<ApiResponse<null>>(
      { ok: false, error: { message: '파일을 업로드해야 합니다.' } },
      { status: 400 }
    );
  }

  // MIME 타입 검증 (departmentId 불필요)
  const lowerFileName = file.name.toLowerCase();
  const hasAllowedExtension = ALLOWED_EXTENSIONS.some((ext) => lowerFileName.endsWith(ext));

  if (!hasAllowedExtension && !ALLOWED_MIME_TYPES.includes(file.type)) {
    return NextResponse.json<ApiResponse<null>>(
      { ok: false, error: { message: '지원되지 않는 파일 형식입니다. PDF, DOCX, TXT, HWP, HWPX만 허용됩니다.' } },
      { status: 415 }
    );
  }

  // 파일 크기 검증 (departmentId 불필요)
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json<ApiResponse<null>>(
      { ok: false, error: { message: '파일 크기가 너무 큽니다. 최대 20MB까지 업로드할 수 있습니다.' } },
      { status: 413 }
    );
  }

  const fileExtension = file.name.toLowerCase().split('.').pop() ?? '';

  // departmentId 조회 — 보안 이벤트 로그에 필요하므로 파일명 검증 전에 가져옴
  const userResponse = await supabaseAdmin
    .from('users')
    .select('department_id')
    .eq('id', session.user.id)
    .maybeSingle();

  if (userResponse.error || !userResponse.data) {
    return NextResponse.json<ApiResponse<null>>(
      { ok: false, error: { message: '사용자 정보를 찾을 수 없습니다.' } },
      { status: 500 }
    );
  }

  const departmentId = userResponse.data.department_id;
  if (!departmentId) {
    return NextResponse.json<ApiResponse<null>>(
      { ok: false, error: { message: '사용자에 할당된 부서가 없습니다.' } },
      { status: 400 }
    );
  }

  // 위험한 파일명 패턴 체크 (departmentId 확보 후 로그 기록 가능)
  for (const pattern of DANGEROUS_FILENAME_PATTERNS) {
    if (pattern.test(file.name)) {
      await logSecurityEvent(departmentId, session.user.id, 'file_upload_blocked', {
        reason: 'dangerous_filename',
        filename: file.name,
        pattern: pattern.source,
      }, 'high');

      return NextResponse.json<ApiResponse<null>>(
        { ok: false, error: { message: '유효하지 않은 파일명입니다.' } },
        { status: 400 }
      );
    }
  }

  // 차단된 확장자 체크
  if (BLOCKED_EXTENSIONS.includes(fileExtension)) {
    await logSecurityEvent(departmentId, session.user.id, 'file_upload_blocked', {
      reason: 'blocked_extension',
      filename: file.name,
      extension: fileExtension,
    }, 'high');

    return NextResponse.json<ApiResponse<null>>(
      { ok: false, error: { message: '이 파일 형식은 보안상 허용되지 않습니다.' } },
      { status: 415 }
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // 스캔 PDF는 판독에 토큰을 쓴다. 페이지당 1,500~3,000 토큰이라 적지 않다.
  // 토큰을 소비하는 경로에는 한도 검사를 함께 둔다(CLAUDE.md 규약).
  // 파싱 전이라 스캔 여부를 아직 모르지만, 한도를 넘긴 기관이라면 어차피
  // 판독을 시작하면 안 되므로 여기서 막는 것이 맞다.
  const limit = await checkTokenLimit(departmentId);
  if (!limit.allowed) {
    return NextResponse.json<ApiResponse<null>>(
      { ok: false, error: { message: limitMessage(limit) } },
      { status: 429 }
    );
  }

  // 문서 처리 + 임베딩 (Voyage AI 실패 시 임베딩 없이 저장)
  let processingResult: Awaited<ReturnType<typeof import('@/lib/document-processor').processDocumentFile>>;
  try {
    processingResult = await (await import('@/lib/document-processor')).processDocumentFile(buffer, file.type, file.name);
  } catch (procErr: any) {
    console.error('[upload] 문서 처리 실패:', procErr.message);
    return NextResponse.json<ApiResponse<null>>(
      { ok: false, error: { message: `문서 처리 중 오류가 발생했습니다: ${procErr.message}` } },
      { status: 500 }
    );
  }

  // 파일명에서 한글·특수문자 제거 → Supabase Storage 허용 문자만 사용
  const ext        = file.name.split('.').pop() ?? 'bin';
  const safeName   = file.name
    .replace(/\.[^.]+$/, '')          // 확장자 제거
    .replace(/[^\w\s-]/g, '')         // 영문/숫자/공백/하이픈 외 제거
    .replace(/\s+/g, '_')             // 공백 → 언더스코어
    .slice(0, 80)                     // 최대 80자
    || 'document';
  const storagePath = `documents/${departmentId}/${Date.now()}-${safeName}.${ext}`;
  const { error: uploadError } = await supabaseAdmin.storage
    .from(SUPABASE_DOCUMENTS_BUCKET)
    .upload(storagePath, buffer, { contentType: file.type });

  if (uploadError) {
    return NextResponse.json<ApiResponse<null>>(
      { ok: false, error: { message: `파일 저장 중 오류가 발생했습니다: ${uploadError.message}` } },
      { status: 500 }
    );
  }

  // 공통 문서 메타데이터 (모든 에이전트에 동일)
  const baseRecord = {
    department_id: departmentId,
    visibility: formData.get('visibility')?.toString() === 'department' ? 'department' : 'organization',
    uploaded_by: session.user.id,
    storage_path: storagePath,
    file_name: file.name,
    file_type: file.type,
    title: title || file.name,
    summary: processingResult.summary,
    metadata: {
      chunk_count: processingResult.chunks.length,
      chunks: processingResult.chunks.map((chunk) => ({
        index: chunk.index,
        text: chunk.text,
        embedding: chunk.embedding?.length > 0 ? chunk.embedding : null,
      })),
    },
    embedding: processingResult.averageEmbedding?.length > 0
      ? processingResult.averageEmbedding : null,
  };

  // 선택한 모든 에이전트에 문서 레코드 생성 (storage 파일은 공유)
  const insertRows = agentIds.map(aid => ({ ...baseRecord, agent_id: aid }));
  const { data: insertedDocs, error: insertError } = await supabaseAdmin
    .from('documents')
    .insert(insertRows)
    .select('id');

  if (insertError || !insertedDocs?.length) {
    console.error('[upload] documents insert error:', insertError);
    return NextResponse.json<ApiResponse<null>>(
      { ok: false, error: { message: `문서 레코드 저장 실패: ${insertError?.message ?? '알 수 없는 오류'}` } },
      { status: 500 }
    );
  }

  // 스캔 판독에 쓴 토큰을 기록한다. model 없이 토큰만 남기면 나중에 모델을
  // 추가했을 때 과거 사용량을 어디에 귀속시킬지 알 수 없게 된다(CLAUDE.md 규약).
  const ocrUsage = processingResult.ocrUsage;
  if (ocrUsage) {
    await supabaseAdmin.from('usage_logs').insert({
      department_id: departmentId,
      user_id: session.user.id,
      action: 'document_ocr',
      resource_type: 'document',
      resource_id: insertedDocs[0]?.id ?? null,
      details: {
        file_name: file.name,
        pages: processingResult.ocrPages ?? null,
        model: ocrUsage.model,
        input_tokens: ocrUsage.input_tokens,
        output_tokens: ocrUsage.output_tokens,
        cost_usd: estimateCostUsd(ocrUsage, ocrUsage.model),
        cost_krw: estimateCostKrw(ocrUsage, ocrUsage.model),
      },
    });
  }

  const notices: string[] = [];
  if (processingResult.embeddingError) {
    notices.push('임베딩(Voyage AI)이 실패해 이 문서는 검색되지 않습니다. 크레딧을 확인하세요.');
  }
  if (ocrUsage) {
    // 판독을 거쳤다는 사실을 알려야 한다. 원문과 다르게 읽혔을 수 있으므로
    // 담당자가 결과를 한 번 확인할 근거가 된다.
    notices.push(
      `텍스트 레이어가 없어 스캔 문서로 판독했습니다 (${processingResult.ocrPages ?? '?'}쪽). 내용을 확인해주세요.`
    );
  }
  const warning = notices.length > 0 ? notices.join(' ') : null;

  return NextResponse.json(
    { ok: true, data: { documentIds: insertedDocs.map((d: { id: string }) => d.id), count: insertedDocs.length, warning } },
    { status: 201 }
  );
}
