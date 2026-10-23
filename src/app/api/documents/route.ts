import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getAccessScope, visibilityFilter } from '@/lib/department-scope';
import { getActorScope } from '@/lib/actor-scope';
import { canDeleteAgent } from '@/lib/agent-permissions';
import { loadAgentAccess, recordAgentEvent } from '@/lib/agent-store';
import { removeStorageFileIfUnused } from '@/lib/document-files';
import { noda, nodaTenant } from '@/lib/noda';
import { reconcileReading } from '@/lib/document-reading';
import { logSystem } from '@/lib/logger';

const NODA_DELETE_FAILED_MESSAGE = '문서 보관소에서 지우지 못했습니다. 잠시 뒤 다시 지워 주세요.';

export async function GET(_request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    const departmentId = session.user.departmentId;
    if (!departmentId) {
      return NextResponse.json(
        { ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } },
        { status: 403 }
      );
    }

    // 기관 전체 공개 문서 + 내 부서 계통에 걸린 부서 제한 문서
    const scope = await getAccessScope(departmentId);
    const visibleFilter = visibilityFilter(scope);

    const { data, error } = await supabaseAdmin
      .from('documents')
      .select(
        'id, department_id, agent_id, uploaded_by, file_name, file_type, title, summary, visibility, created_at, updated_at, ' +
          'noda_status, noda_reason, noda_filename, noda_read_started_at, noda_last_attempt_at'
      )
      .or(visibleFilter)
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json(
        { ok: false, error: { message: '문서 목록 조회 실패', details: error } },
        { status: 500 }
      );
    }

    // 읽는 중인 행만 NODA와 맞춘다(방금 조회한 범위 안의 행만). 맞추기 실패는 목록을 막지 않는다.
    // 맞추기는 noda_status를 바꾸므로, 실패하면 맞추기 전 값 그대로 내려보낸다.
    let rows = (data ?? []) as unknown as Array<Record<string, any> & Parameters<typeof reconcileReading>[0][number]>;
    try {
      rows = await reconcileReading(rows);
    } catch (reconcileError) {
      await logSystem({
        level: 'warning',
        category: 'database',
        message: '문서 읽기 상태 맞추기 실패 — 맞추기 전 목록을 그대로 보냄',
        details: { error: reconcileError instanceof Error ? reconcileError.message : String(reconcileError) },
      });
    }

    // 보관함 파일 이름(`{id}__…`)은 서버 안에서만 쓴다 — 화면에는 내보내지 않는다.
    const out = rows.map(({ noda_filename, noda_read_started_at, noda_last_attempt_at, ...rest }) => rest);
    return NextResponse.json({ ok: true, data: out });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json({ ok: false, error: { message: '인증이 필요합니다.' } }, { status: 401 });
    }

    const actor = await getActorScope(session);
    if (!actor) {
      return NextResponse.json({ ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } }, { status: 403 });
    }

    const { documentId } = await request.json();
    if (!documentId) {
      return NextResponse.json({ ok: false, error: { message: 'documentId가 필요합니다.' } }, { status: 400 });
    }

    const { data: doc } = await supabaseAdmin
      .from('documents')
      .select('id, storage_path, agent_id, department_id, file_name, noda_filename, noda_status')
      .eq('id', documentId)
      .maybeSingle();

    if (!doc) {
      return NextResponse.json({ ok: false, error: { message: '문서를 찾을 수 없습니다.' } }, { status: 404 });
    }

    // 문서는 되돌리기 대상이 아니다(결정 3). 되돌릴 수 없는 것은 좁게 연다 —
    // 그 비서를 지울 수 있는 사람만 문서도 지운다(결정 4의 원칙).
    // 비서에 걸리지 않은 문서는 그 부서를 관리하는 관리자만.
    let allowed = false;
    if (doc.agent_id) {
      const agent = await loadAgentAccess(doc.agent_id);
      allowed = Boolean(agent) && canDeleteAgent(agent!, actor);
    } else {
      allowed = actor.isAdmin && actor.managedDepartmentIds.includes(doc.department_id);
    }
    if (!allowed) {
      return NextResponse.json({ ok: false, error: { message: '이 문서를 지울 권한이 없습니다.' } }, { status: 403 });
    }

    // 순서: NODA → DB 행 → 저장소 원본. NODA 사본을 남긴 채 행을 지우면 찾을 수 없는 고아가 남고,
    // 그 조각이 근거로 오는 턴은 근거 없이 답하게 된다(문서 찾기가 고아를 알아보고 버린 뒤 지운다 — 판정 H).
    // 그래서 NODA가 먼저 성공해야 행을 지운다.
    // NODA에 간 적 없는 옛 행(noda_status NULL)은 건너뛴다. 이미 없는 사본(404)은 지운 것과 같다.
    if (doc.agent_id && doc.noda_filename && doc.noda_status) {
      let nodaFailed = false;
      let nodaError: unknown = null;
      try {
        await noda.deleteDocument(nodaTenant(doc.agent_id), doc.noda_filename);
      } catch (e) {
        nodaFailed = true;
        nodaError = e;
      }
      if (nodaFailed) {
        // 지우는 중임을 남긴다 — 읽기 라우트가 이 행을 되살리지 않고, 다시 지우면 같은 길을 다시 탄다.
        const { error: markError } = await supabaseAdmin
          .from('documents')
          .update({ noda_status: 'deleting' })
          .eq('id', documentId);
        await logSystem({
          level: 'error',
          category: 'api',
          message: markError
            ? 'NODA 문서 삭제 실패 — 행을 deleting으로 표시하지 못함'
            : 'NODA 문서 삭제 실패 — 행을 deleting으로 남김',
          details: {
            document_id: doc.id,
            error: nodaError instanceof Error ? nodaError.message : String(nodaError),
            ...(markError ? { mark_failed: true, mark_error: markError.message } : {}),
          },
        });
        return NextResponse.json({ ok: false, error: { message: NODA_DELETE_FAILED_MESSAGE } }, { status: 502 });
      }
    }

    // NODA 삭제가 끝난 뒤 이 DB 삭제가 실패하면 다시 지워도 안전하다 — NODA는 이미 없는 사본에 404를 주고, 그건 성공으로 센다.
    const { error } = await supabaseAdmin.from('documents').delete().eq('id', documentId);
    if (error) {
      return NextResponse.json({ ok: false, error: { message: '문서 삭제 실패', details: error } }, { status: 500 });
    }

    // 여러 비서에 한 번에 올린 문서는 저장소 파일 하나를 함께 쓴다.
    // 다른 행이 남아 있거나 세지 못하면 파일을 지우지 않는다.
    if (doc.storage_path) await removeStorageFileIfUnused(doc.storage_path);

    if (doc.agent_id) {
      await recordAgentEvent(doc.agent_id, 'document_removed', actor.userId, { file_name: doc.file_name });
    }

    return NextResponse.json({ ok: true, data: { deleted: true } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: { message: '서버 오류가 발생했습니다.' } }, { status: 500 });
  }
}
