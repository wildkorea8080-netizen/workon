import { NextRequest, NextResponse } from 'next/server';
import { BAD_BODY_MESSAGE, readJsonObject } from '@/lib/request-body';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { pagedRows } from '@/lib/paged-select';
import { getAccessScope, visibilityFilter } from '@/lib/department-scope';
import { isAccessScopeReadError } from '@/lib/access-scope-error';
import { getActorScope } from '@/lib/actor-scope';
import { canDeleteAgent } from '@/lib/agent-permissions';
import { loadAgentAccess } from '@/lib/agent-store';
import { deleteAgentDocument } from '@/lib/document-delete';
import { reconcileReading } from '@/lib/document-reading';
import { pendingRetirements, retireReplacedDocument } from '@/lib/document-editions';
import { replayNodaEvents } from '@/lib/noda-events';
import { logSystem } from '@/lib/logger';
import type { NodaStatus } from '@/lib/db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


export async function GET(request: NextRequest) {
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

    // `?agent_id=`면 그 비서의 문서만(비서 편집 창의 '문서' 탭, 2026-11-06) — 보이는 범위(visibilityFilter)는 그대로 건다
    const agentParam = request.nextUrl.searchParams.get('agent_id');
    if (agentParam !== null && !UUID_RE.test(agentParam)) {
      return NextResponse.json({ ok: false, error: { message: '비서 id가 올바르지 않습니다.' } }, { status: 400 });
    }

    // 놓친 웹훅을 먼저 받아 둔다 — 1분에 한 번만 돌고 짧게(3초) 끝나며 던지지 않는다(noda-events.ts)
    await replayNodaEvents();

    // 기관 전체 공개 문서 + 내 부서 계통에 걸린 부서 제한 문서
    // 공개 범위를 못 읽으면 줄어든 목록 대신 503(2026-11-20)
    const scope = await getAccessScope(departmentId).catch((err) => {
      if (isAccessScopeReadError(err)) return null;
      throw err;
    });
    if (!scope) {
      return NextResponse.json({ ok: false, error: { message: '문서 목록을 지금 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' } }, { status: 503 });
    }
    const visibleFilter = visibilityFilter(scope);

    // 문서가 1,000개를 넘는 기관에서도 목록이 잘리지 않게 쪽마다 끝까지(API 상한 1,000행, 2026-11-05)
    const { data, error } = await pagedRows<any>((a, b, w) => {
      let query = supabaseAdmin
        .from('documents')
        .select(
          'id, department_id, agent_id, uploaded_by, file_name, file_type, title, summary, visibility, created_at, updated_at, ' +
            'noda_status, noda_reason, noda_filename, noda_read_started_at, noda_last_attempt_at, replaces_id, retired_at, effective_from, tags',
          w ? { count: 'exact' } : undefined
        )
        .or(visibleFilter);
      if (agentParam) query = query.eq('agent_id', agentParam.toLowerCase());
      return query.order('created_at', { ascending: false }).order('id').range(a, b);
    });

    if (error) {
      return NextResponse.json(
        { ok: false, error: { message: '문서 목록을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' } },
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

    // 판 바꾸기(0055)가 남은 새 판 — 갈고리가 던졌으면 여기서 다시 건다(여러 번 불러도 안전). 바뀐 옛 판은 다시 읽어 싣는다
    const pending = pendingRetirements(rows as unknown as Parameters<typeof pendingRetirements>[0]);
    if (pending.length) {
      for (const id of pending.slice(0, 5)) {
        try {
          await retireReplacedDocument(id);
        } catch (retireError) {
          await logSystem({ level: 'warning', category: 'api', message: '문서 판 바꾸기 다시 걸기 실패', details: { document_id: id, error: retireError instanceof Error ? retireError.message : String(retireError) } });
        }
      }
      const olds = rows.filter((r) => pending.includes(String(r.id))).map((r) => String(r.replaces_id));
      const { data: fresh } = await supabaseAdmin.from('documents').select('id, noda_status, retired_at').in('id', olds);
      const byId = new Map(((fresh ?? []) as Array<{ id: string; noda_status: NodaStatus; retired_at: string | null }>).map((f) => [f.id, f]));
      rows = rows.map((r) => (byId.has(String(r.id)) ? { ...r, ...byId.get(String(r.id)) } : r));
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

    const body = await readJsonObject(request);
    if (!body) return NextResponse.json({ ok: false, error: { message: BAD_BODY_MESSAGE } }, { status: 400 });
    const { documentId } = body;
    if (!documentId) {
      return NextResponse.json({ ok: false, error: { message: 'documentId가 필요합니다.' } }, { status: 400 });
    }

    const { data: doc, error: docError } = await supabaseAdmin
      .from('documents')
      .select('id, storage_path, agent_id, department_id, file_name, noda_filename, noda_status')
      .eq('id', documentId)
      .maybeSingle();

    // 읽기 실패를 '없는 문서'(404)로 답하지 않는다 — 화면은 404를 '이미 지워짐'으로 보고 목록에서 뺄 수 있다(2026-11-19)
    if (docError) {
      return NextResponse.json({ ok: false, error: { message: '문서를 지금 읽지 못했습니다. 잠시 뒤 다시 지워 주세요.' } }, { status: 503 });
    }
    if (!doc) {
      return NextResponse.json({ ok: false, error: { message: '문서를 찾을 수 없습니다.' } }, { status: 404 });
    }

    // 문서는 되돌리기 대상이 아니다(결정 3). 되돌릴 수 없는 것은 좁게 연다 —
    // 그 비서를 지울 수 있는 사람만 문서도 지운다(결정 4의 원칙).
    // 비서에 걸리지 않은 문서는 그 부서를 관리하는 관리자만.
    let allowed = false;
    if (doc.agent_id) {
      const agent = await loadAgentAccess(doc.agent_id);
      // 지운 비서에 남은 문서(비서를 지울 때 NODA를 못 비워 deleting으로 남은 것)는 그 부서를 관리하는 관리자가 치운다 —
      // canDeleteAgent는 지운 비서에 거짓이라 그대로 두면 아무도 못 지운다
      allowed = agent?.deleted_at
        ? actor.isAdmin && actor.managedDepartmentIds.includes(doc.department_id)
        : Boolean(agent) && canDeleteAgent(agent!, actor);
    } else {
      allowed = actor.isAdmin && actor.managedDepartmentIds.includes(doc.department_id);
    }
    if (!allowed) {
      return NextResponse.json({ ok: false, error: { message: '이 문서를 지울 권한이 없습니다.' } }, { status: 403 });
    }

    // 순서(NODA → DB 행 → 저장소 원본)는 기관 API 지우기(0104)와 함께 쓰는 한 곳에 — src/lib/document-delete.ts
    const removed = await deleteAgentDocument(doc, actor.userId);
    if (!removed.ok) return NextResponse.json({ ok: false, error: { message: removed.message } }, { status: removed.status });

    return NextResponse.json({ ok: true, data: { deleted: true } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: { message: '서버 오류가 발생했습니다.' } }, { status: 500 });
  }
}
