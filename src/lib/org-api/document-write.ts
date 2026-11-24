// src/lib/org-api/document-write.ts
// 기관 API의 문서 올리기(0100, 2026-11-24) — 범위 documents_write.
//
// 기관의 문서관리시스템(EDMS)이 규정·지침을 비서 문서함에 올리거나 새 판으로 바꾼다. 화면 올리기와 같은 세 걸음이다:
//   ① POST /api/v1/documents/upload-url `{ agentId, fileName, size, fileType? }` → `{ path, uploadUrl, method:'PUT', headers, expiresAt }`
//   ② 밖의 시스템이 uploadUrl에 파일 바이트를 그대로 PUT(10분 안 — 저장소에 직접, Vercel 본문 상한을 거치지 않게)
//   ③ POST /api/v1/documents `{ path, agentId, fileName, fileType?, title?, replacesId?, effectiveFrom?, tags?, visibility? }`
//      → 화면 확인(`/api/documents/confirm`)과 같은 검사(경로·10분·실제 크기·형식·권한·비서당 개수·바꿀 옛 판)로 행을 만들고 읽기를 건다
//
// - 올린 사람은 **키를 만든 기관 전체 관리자**다(그 사람의 권한으로 판정 — 키가 아직 그 사람의 것인지는 handleOrgApiCall이 본다).
// - 나만의 비서·지운 비서·다른 기관 비서에는 올리지 않는다(있는지도 알려 주지 않는 404) — 목록 API(0099)가 감추는 비서와 같다.
// - **지우기는 API로 하지 않는다**(되돌릴 수 없다 — 사람이 화면에서). 바꾸기는 새 판(replacesId)으로: 새 판이 읽히는 순간 옛 판이 내려간다.
// - 올린 문서는 보안 로그 `org_api_document_uploaded`(키 id·문서·비서·옛 판)에 남는다. 막힌 파일은 화면과 같은 `file_upload_blocked`(high).
import { randomUUID } from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_SIZE_LABEL } from '@/lib/file-types';
import { logSecurityEvent } from '@/lib/security-log';
import { enableAgentCapability, loadAgentAccess, recordAgentEvent } from '@/lib/agent-store';
import { getVisibleDepartmentIds } from '@/lib/department-scope';
import { isDepartmentScopeReadError } from '@/lib/access-scope-error';
import type { ActorScope, AgentAccessInfo } from '@/lib/agent-permissions';
import {
  DOCUMENT_CONFIRM_WINDOW_MS, buildNewDocumentRows, checkUploadFile, checkUploadTargets, documentStoragePath, parseDocumentStoragePath,
} from '@/lib/document-upload';
import { parseEffectiveFrom, replaceTargetError } from '@/lib/document-editions';
import { applyVocabulary, normalizeDocumentTags } from '@/lib/document-tags';
import { loadTagVocabulary } from '@/lib/document-tag-vocabulary';
import { readDocument } from '@/lib/document-reading';
import { docStatusOf, parseDocCreate, parseDocUploadUrl, writableAgent, type OrgApiDocStatus } from './spec';
import type { OrgApiContext } from './keys';

type Out = { data: unknown } | { status: number; message: string };

export const ORG_API_AGENT_NOT_FOUND = '비서를 찾을 수 없습니다 — 이 기관의 공식·부서 비서 id인지 확인해 주세요(나만의 비서에는 올릴 수 없습니다).';
export const ORG_API_SCOPE_UNREAD = '키를 만든 관리자의 범위를 지금 확인하지 못했습니다. 잠시 뒤 다시 호출해 주세요.';
export const ORG_API_PATH_NOT_YOURS = '이 키로 받은 올리기 주소의 path만 등록할 수 있습니다. 올리기 주소부터 다시 받아 주세요.';

function bucket() {
  return supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET);
}

/** 키를 만든 기관 전체 관리자의 권한 범위 — 판정 함수(canEditAgent·checkUploadTargets)를 화면과 같이 쓴다 */
export async function creatorActor(ctx: OrgApiContext): Promise<ActorScope | null> {
  try {
    const visibleDepartmentIds = await getVisibleDepartmentIds(ctx.creatorDepartmentId);
    return {
      userId: ctx.creatorId,
      isAdmin: true,
      departmentId: ctx.creatorDepartmentId,
      organizationId: ctx.organizationId,
      visibleDepartmentIds,
      managedDepartmentIds: ctx.departmentIds,
      // handleOrgApiCall이 '최상위 부서의 활성 관리자'임을 확인한 뒤에만 여기 온다
      managesWholeOrganization: true,
    };
  } catch (error) {
    if (isDepartmentScopeReadError(error)) return null;
    throw error;
  }
}

// API로 쓸 수 있는 비서인가 — 규칙은 spec.ts 한 곳(묻기 0101도 같은 규칙)
export { writableAgent };

async function targetFor(ctx: OrgApiContext, agentId: string, actor: ActorScope): Promise<{ ok: true; targets: Map<string, AgentAccessInfo> } | { ok: false; status: number; message: string }> {
  const agent = await loadAgentAccess(agentId);
  if (!writableAgent(agent, ctx.organizationId)) return { ok: false, status: 404, message: ORG_API_AGENT_NOT_FOUND };
  // 권한(canEditAgent)·비서당 문서 수는 화면과 같은 함수로
  const checked = await checkUploadTargets([agentId], actor);
  if (!checked.ok) return checked;
  return { ok: true, targets: checked.targets };
}

/** ① 올리기 주소 — 경로는 서버가 정하고(키 주인의 부서·사람·발급 시각), 서명 주소는 저장소가 준다 */
export async function issueDocumentUploadUrl(ctx: OrgApiContext, raw: unknown, nowMs = Date.now()): Promise<Out> {
  const parsed = parseDocUploadUrl(raw);
  if (!parsed.ok) return { status: 400, message: parsed.message };
  const input = parsed.value;
  const actor = await creatorActor(ctx);
  if (!actor) return { status: 503, message: ORG_API_SCOPE_UNREAD };

  const file = checkUploadFile({ fileName: input.fileName, size: input.size, mimeType: input.fileType });
  if (!file.ok) {
    if (file.securityReason) {
      await logSecurityEvent(ctx.creatorDepartmentId, ctx.creatorId, 'file_upload_blocked', {
        reason: file.securityReason, filename: input.fileName, via: 'org_api', key_id: ctx.keyId, ...file.securityDetail,
      }, 'high');
    }
    return { status: file.status, message: file.message };
  }
  const target = await targetFor(ctx, input.agentId, actor);
  if (!target.ok) return { status: target.status, message: target.message };

  const path = documentStoragePath({ departmentId: ctx.creatorDepartmentId, userId: ctx.creatorId, ext: file.ext, now: nowMs, id: randomUUID() });
  const { data, error } = await bucket().createSignedUploadUrl(path);
  if (error || !data?.signedUrl) throw new Error(`createSignedUploadUrl: ${error?.message ?? 'no url'}`);
  return {
    data: {
      path,
      uploadUrl: data.signedUrl,
      method: 'PUT',
      headers: { 'Content-Type': input.fileType || 'application/octet-stream' },
      // 서명 주소 자체는 더 살지만 등록(③)은 발급 10분 안에만 받는다
      expiresAt: new Date(nowMs + DOCUMENT_CONFIRM_WINDOW_MS).toISOString(),
    },
  };
}

/** 저장소가 아는 객체 크기 — 없거나 모르면 null(확인 라우트와 같은 규칙) */
async function storedSize(path: string): Promise<number | null> {
  const slash = path.lastIndexOf('/');
  try {
    const { data, error } = await bucket().list(path.slice(0, slash), { search: path.slice(slash + 1) });
    if (error || !data) return null;
    const hit = (data as { name: string; metadata?: { size?: unknown } }[]).find((o) => o.name === path.slice(slash + 1));
    return typeof hit?.metadata?.size === 'number' ? hit.metadata.size : null;
  } catch {
    return null;
  }
}

async function discard(path: string): Promise<void> {
  try {
    const { error } = await bucket().remove([path]);
    if (error) console.error('[org-api documents] 객체 삭제 실패', error.message);
  } catch (e) {
    console.error('[org-api documents] 객체 삭제 실패', e instanceof Error ? e.message : e);
  }
}

/** 읽기 결과 → 밖에 보일 상태(바쁨·못 찾음은 '읽는 중' — 행은 reading으로 남아 있다) */
export function createdStatus(outcome: { status: string } | null): OrgApiDocStatus {
  const s = outcome?.status;
  return s === 'ready' || s === 'unreadable' || s === 'failed' ? docStatusOf(s) : 'reading';
}

/** ③ 등록 — 올린 원본을 확인하고 행을 만든 뒤 읽기를 건다(NODA 비동기 넣기라 대개 바로 돌아온다) */
export async function createOrgApiDocument(ctx: OrgApiContext, raw: unknown, nowMs = Date.now()): Promise<Out> {
  const parsedBody = parseDocCreate(raw);
  if (!parsedBody.ok) return { status: 400, message: parsedBody.message };
  const input = parsedBody.value;

  // ── 경로: 이 키 주인의 것이고 이 모양인가 ──
  const parsed = parseDocumentStoragePath(input.path);
  if (!parsed) return { status: 400, message: 'path가 올바르지 않습니다 — 올리기 주소 응답의 path를 그대로 넣어 주세요.' };
  if (parsed.departmentId !== ctx.creatorDepartmentId || parsed.userId !== ctx.creatorId) return { status: 403, message: ORG_API_PATH_NOT_YOURS };
  if (parsed.issuedAt > nowMs + 60_000) return { status: 400, message: 'path가 올바르지 않습니다 — 올리기 주소 응답의 path를 그대로 넣어 주세요.' };

  // ── 이미 등록한 경로(같은 호출을 다시 보냄): 원본을 지우면 안 된다 — 시간·크기 판정보다 먼저 ──
  const { data: existing, error: existingError } = await supabaseAdmin.from('documents').select('id').eq('storage_path', input.path).limit(1);
  if (existingError) throw new Error(`documents(existing): ${existingError.message}`);
  if ((existing ?? []).length > 0) return { status: 409, message: `이미 등록한 파일입니다(문서 id ${(existing as { id: string }[])[0].id}).` };

  if (nowMs - parsed.issuedAt > DOCUMENT_CONFIRM_WINDOW_MS) {
    await discard(input.path);
    return { status: 410, message: '올리기 주소를 받은 지 10분이 지났습니다. 올리기 주소부터 다시 받아 주세요.' };
  }
  // 서명 주소는 크기를 강제하지 않는다 — 저장소가 아는 실제 크기로
  const size = await storedSize(input.path);
  if (size === null) {
    await discard(input.path);
    return { status: 413, message: '올린 파일을 찾지 못했거나 크기를 확인하지 못했습니다. uploadUrl에 PUT한 뒤 등록해 주세요.' };
  }
  if (size > MAX_UPLOAD_BYTES) {
    await discard(input.path);
    return { status: 413, message: `파일 크기가 너무 큽니다. 최대 ${MAX_UPLOAD_SIZE_LABEL}까지 올릴 수 있습니다.` };
  }
  const file = checkUploadFile({ fileName: input.fileName, size, mimeType: input.fileType });
  if (!file.ok) {
    if (file.securityReason) {
      await logSecurityEvent(ctx.creatorDepartmentId, ctx.creatorId, 'file_upload_blocked', {
        reason: file.securityReason, filename: input.fileName, via: 'org_api', key_id: ctx.keyId, ...file.securityDetail,
      }, 'high');
    }
    await discard(input.path);
    return { status: file.status, message: file.message };
  }
  // 받은 주소의 확장자와 다른 이름으로 등록하면 형식 검사를 비껴간다
  if (file.ext !== parsed.ext) {
    await discard(input.path);
    return { status: 400, message: '올린 파일과 fileName의 형식(확장자)이 다릅니다. 올리기 주소부터 다시 받아 주세요.' };
  }

  // ── 비서·권한·개수(주소를 받은 뒤 바뀌었을 수 있다 — 원본은 남겨 다시 등록할 수 있게) ──
  const actor = await creatorActor(ctx);
  if (!actor) return { status: 503, message: ORG_API_SCOPE_UNREAD };
  const target = await targetFor(ctx, input.agentId, actor);
  if (!target.ok) return { status: target.status, message: target.message };

  // ── 판(0055): 시행일·바꿀 옛 판 ──
  const effectiveFrom = parseEffectiveFrom(input.effectiveFrom);
  if (effectiveFrom === undefined) return { status: 400, message: 'effectiveFrom은 2026-01-01처럼 있는 날짜로 적어 주세요(2000~2100년).' };
  if (input.replacesId) {
    const [{ data: old, error: oldError }, { count, error: countError }] = await Promise.all([
      supabaseAdmin.from('documents').select('id, agent_id, noda_status, retired_at').eq('id', input.replacesId).eq('organization_id', ctx.organizationId).maybeSingle(),
      supabaseAdmin.from('documents').select('id', { count: 'exact', head: true }).eq('replaces_id', input.replacesId).in('noda_status', ['reading', 'ready']),
    ]);
    if (oldError || countError) throw new Error(`documents(replaces): ${(oldError ?? countError)!.message}`);
    const replaceError = replaceTargetError({ agentIds: [input.agentId], target: old, competing: count ?? 0 });
    if (replaceError) return { status: 409, message: replaceError };
  }

  // ── 태그(0060·0061): 분류표 표기로 맞추고, '분류표의 태그만'이면 밖의 태그는 거절. 분류표를 못 읽으면 등록하지 않는다 ──
  let tags: string[] = [];
  if (input.tags !== undefined && input.tags !== null) {
    const normalized = normalizeDocumentTags(input.tags);
    if (!normalized.ok) return { status: 400, message: `tags: ${normalized.message}` };
    if (normalized.tags.length) {
      let vocabulary;
      try {
        vocabulary = await loadTagVocabulary(ctx.organizationId);
      } catch {
        return { status: 503, message: '태그 분류표를 지금 읽지 못했습니다. 잠시 뒤 다시 등록해 주세요.' };
      }
      const fitted = applyVocabulary(normalized.tags, vocabulary);
      if (!fitted.ok) return { status: 400, message: fitted.message };
      tags = fitted.tags;
    }
  }

  const id = randomUUID();
  const rows = buildNewDocumentRows({
    ids: [id],
    agentIds: [input.agentId],
    targets: target.targets,
    departmentId: ctx.creatorDepartmentId,
    userId: ctx.creatorId,
    storagePath: input.path,
    fileName: input.fileName,
    fileType: input.fileType || null,
    title: input.title ?? input.fileName,
    visibility: input.visibility,
    now: new Date(nowMs),
  }).map((row) => ({ ...row, replaces_id: input.replacesId, effective_from: effectiveFrom, tags }));
  const { error: insertError } = await supabaseAdmin.from('documents').insert(rows);
  if (insertError) throw new Error(`documents(insert): ${insertError.message}`);

  // 비서 타임라인·문서 찾기 켜기(판에 남음)·보안 로그 — 화면 확인과 같다. 실패해도 등록은 됐다
  await recordAgentEvent(input.agentId, 'document_added', ctx.creatorId, { file_name: input.fileName, via: 'org_api' }).catch(() => {});
  await enableAgentCapability(input.agentId, 'doc_search', ctx.creatorId).catch(() => {});
  await logSecurityEvent(ctx.creatorDepartmentId, ctx.creatorId, 'org_api_document_uploaded', {
    key_id: ctx.keyId, document_id: id, agent_id: input.agentId, replaces_id: input.replacesId,
  }, 'medium');

  // 읽기를 건다 — 실패해도 행은 reading으로 남고 문서 화면·웹훅이 이어 받는다
  let outcome: { status: string } | null = null;
  try {
    outcome = await readDocument(id);
  } catch (error) {
    console.error('[org-api documents] 읽기 걸기 실패', error instanceof Error ? error.message : error);
  }
  return { data: { id, agentId: input.agentId, status: createdStatus(outcome), replacesId: input.replacesId, effectiveFrom, tags } };
}
