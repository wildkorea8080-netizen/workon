import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_SIZE_LABEL } from '@/lib/file-types';
import { logSecurityEvent } from '@/lib/filter';
import { recordAgentEvent, enableAgentCapability } from '@/lib/agent-store';
import {
  DOCUMENT_CONFIRM_WINDOW_MS,
  buildNewDocumentRows,
  checkUploadFile,
  checkUploadTargets,
  parseDocumentStoragePath,
} from '@/lib/document-upload';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

function bucket() {
  return supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET);
}

/** 저장소가 아는 객체 크기. 객체가 없거나 알 수 없으면 null */
async function storedSize(path: string): Promise<number | null> {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash);
  const name = path.slice(slash + 1);
  try {
    const { data, error } = await bucket().list(dir, { search: name });
    if (error || !data) return null;
    const hit = data.find((o: { name: string }) => o.name === name) as { metadata?: { size?: unknown } } | undefined;
    const size = hit?.metadata?.size;
    return typeof size === 'number' ? size : null;
  } catch {
    return null;
  }
}

/** 지우지 못해도 확인 결과는 바꾸지 않는다 — 남은 객체는 저장 공간만 쓴다 */
async function discardObject(path: string): Promise<void> {
  try {
    const { error } = await bucket().remove([path]);
    if (error) console.error('[documents confirm] 객체 삭제 실패', path, error.message);
  } catch (e) {
    console.error('[documents confirm] 객체 삭제 실패', path, e);
  }
}

/**
 * ② 참고 문서 확인. 올린 원본이 요청자 것이고 발급 10분 안이며 크기가 상한 안인지 보고,
 * 비서마다 `reading` 행을 만든다. 읽기는 화면이 이어서 /api/documents/{id}/read로 건다.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('로그인이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    let body: {
      storage_path?: unknown;
      file_name?: unknown;
      file_type?: unknown;
      title?: unknown;
      visibility?: unknown;
      agent_ids?: unknown;
    };
    try {
      body = await request.json();
    } catch {
      return jsonError('요청 형식이 올바르지 않습니다.', 400);
    }

    // ── 경로: 요청자 것이고 이 모양인가 ──
    const storagePath = typeof body.storage_path === 'string' ? body.storage_path : '';
    const parsed = parseDocumentStoragePath(storagePath);
    if (!parsed) return jsonError('올린 파일의 경로가 올바르지 않습니다. 다시 올려 주세요.', 400);
    if (parsed.departmentId !== actor.departmentId || parsed.userId !== actor.userId) {
      return jsonError('본인이 올린 파일만 확인할 수 있습니다.', 403);
    }
    const now = Date.now();
    if (parsed.issuedAt > now + 60_000) return jsonError('올린 파일의 경로가 올바르지 않습니다. 다시 올려 주세요.', 400);

    // ── 이미 확인한 경로: 객체를 지우면 안 된다(그 행이 쓰는 원본이다) — 시간·크기 판정보다 먼저 본다 ──
    const { data: existing, error: existingError } = await supabaseAdmin
      .from('documents')
      .select('id')
      .eq('storage_path', storagePath)
      .limit(1);
    if (existingError) {
      console.error('[documents confirm] 기존 행 조회 실패:', existingError.message);
      return jsonError('잠시 뒤 다시 시도해 주세요.', 500);
    }
    if ((existing ?? []).length > 0) return jsonError('이미 등록된 파일입니다.', 409);

    // ── 서명 주소는 2시간 살아 있다. 확인을 짧게 받아 오래된 주소로 올린 것을 끊는다 ──
    if (now - parsed.issuedAt > DOCUMENT_CONFIRM_WINDOW_MS) {
      await discardObject(storagePath);
      return jsonError('업로드 후 확인 시간이 지났습니다. 다시 올려 주세요.', 410);
    }

    // ── 서명 주소는 크기를 강제하지 않는다. 저장소가 아는 실제 크기로 거른다 ──
    const size = await storedSize(storagePath);
    if (size === null) {
      await discardObject(storagePath);
      return jsonError('올린 파일의 크기를 확인하지 못했습니다. 다시 올려 주세요.', 413);
    }
    if (size > MAX_UPLOAD_BYTES) {
      await discardObject(storagePath);
      return jsonError(`파일 크기가 너무 큽니다. 최대 ${MAX_UPLOAD_SIZE_LABEL}까지 업로드할 수 있습니다.`, 413);
    }

    // ── 파일 이름·형식 다시 검사 ──
    const fileName = typeof body.file_name === 'string' ? body.file_name : '';
    const mimeType = typeof body.file_type === 'string' ? body.file_type : '';
    const file = checkUploadFile({ fileName, size, mimeType });
    if (!file.ok) {
      if (file.securityReason) {
        await logSecurityEvent(actor.departmentId, actor.userId, 'file_upload_blocked', {
          reason: file.securityReason,
          filename: fileName,
          ...file.securityDetail,
        }, 'high');
      }
      await discardObject(storagePath);
      return jsonError(file.message, file.status);
    }
    // 발급 때 정한 확장자와 다른 이름으로 확인하면 형식 검사를 우회할 수 있다
    if (file.ext !== parsed.ext) {
      await discardObject(storagePath);
      return jsonError('올린 파일과 파일 이름의 형식이 다릅니다. 다시 올려 주세요.', 400);
    }

    // ── 대상 비서 다시 검사(발급 뒤 권한·개수가 바뀌었을 수 있다). 객체는 남겨 다시 확인할 수 있게 한다 ──
    const targets = await checkUploadTargets(body.agent_ids, actor);
    if (!targets.ok) return jsonError(targets.message, targets.status);

    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const ids = targets.agentIds.map(() => randomUUID());
    const rows = buildNewDocumentRows({
      ids,
      agentIds: targets.agentIds,
      targets: targets.targets,
      departmentId: actor.departmentId,
      userId: actor.userId,
      storagePath,
      fileName,
      fileType: mimeType || null,
      title: title || fileName,
      visibility: body.visibility === 'department' ? 'department' : 'organization',
      now: new Date(now),
    });

    const { data: inserted, error: insertError } = await supabaseAdmin.from('documents').insert(rows).select('id');
    if (insertError || !inserted?.length) {
      console.error('[documents confirm] documents insert error:', insertError);
      return jsonError('문서를 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 500);
    }

    // 비서 타임라인에 남기고 문서 찾기를 켠다 — 켜는 일도 판에 남는다
    for (const id of targets.agentIds) {
      await recordAgentEvent(id, 'document_added', actor.userId, { file_name: fileName });
      await enableAgentCapability(id, 'doc_search', actor.userId);
    }

    return NextResponse.json(
      { ok: true, data: { documentIds: inserted.map((d: { id: string }) => d.id) } },
      { status: 201 },
    );
  } catch (error) {
    console.error('[documents confirm]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
