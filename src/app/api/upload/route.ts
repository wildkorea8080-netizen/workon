import { NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { logSecurityEvent } from '@/lib/filter';
import type { ApiResponse } from '@/lib/db';

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain'
];

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
  const agentId = formData.get('agentId')?.toString();
  const title = formData.get('title')?.toString() ?? '';

  if (!agentId) {
    return NextResponse.json<ApiResponse<null>>(
      { ok: false, error: { message: '에이전트 ID가 필요합니다.' } },
      { status: 400 }
    );
  }

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
  if (!ALLOWED_MIME_TYPES.includes(file.type) && !file.name.toLowerCase().endsWith('.docx')) {
    return NextResponse.json<ApiResponse<null>>(
      { ok: false, error: { message: '지원되지 않는 파일 형식입니다. PDF, DOCX, TXT만 허용됩니다.' } },
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

  const storagePath = `documents/${departmentId}/${Date.now()}-${file.name}`;
  const { error: uploadError } = await supabaseAdmin.storage
    .from(SUPABASE_DOCUMENTS_BUCKET)
    .upload(storagePath, buffer, { contentType: file.type });

  if (uploadError) {
    return NextResponse.json<ApiResponse<null>>(
      { ok: false, error: { message: `파일 저장 중 오류가 발생했습니다: ${uploadError.message}` } },
      { status: 500 }
    );
  }

  const documentRecord = {
    department_id: departmentId,
    uploaded_by: session.user.id,
    agent_id: agentId,
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
        embedding: chunk.embedding
      }))
    },
    embedding: processingResult.averageEmbedding
  };

  const { data: insertedDocument, error: insertError } = await supabaseAdmin
    .from('documents')
    .insert(documentRecord)
    .select('id')
    .single();

  if (insertError || !insertedDocument) {
    return NextResponse.json<ApiResponse<null>>(
      { ok: false, error: { message: '문서 레코드 저장에 실패했습니다.', details: insertError } },
      { status: 500 }
    );
  }

  const warning = (processingResult as any).embeddingError
    ? '문서는 저장됐지만 임베딩(Voyage AI)이 실패했습니다. Voyage AI 크레딧을 확인하세요.'
    : null;

  return NextResponse.json(
    { ok: true, data: { documentId: insertedDocument.id, warning } },
    { status: 201 }
  );
}
