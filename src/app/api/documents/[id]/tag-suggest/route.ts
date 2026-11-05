import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { complete } from '@/lib/llm';
import { checkTokenLimit, limitMessage } from '@/lib/usage-limit';
import { resolveModelForDepartment } from '@/lib/model-policy';
import { buildUsageDetails, writeUsageLog } from '@/lib/assistant/persist';
import { documentTagAccess } from '@/lib/document-tag-access';
import { tagCounts } from '@/lib/document-tags';
import { canReadDocument } from '@/lib/document-files';
import { MAX_UPLOAD_BYTES } from '@/lib/file-types';
import { AttachmentReadError, readAttachment } from '@/lib/attachments/reader';
import {
  buildTagSuggestMessage, parseTagSuggestions, TAG_SUGGEST_MAX_TOKENS, TAG_SUGGEST_SYSTEM, TAG_SUGGEST_VOCABULARY,
} from '@/lib/document-tag-suggest';

export const dynamic = 'force-dynamic';
// 글자 층이 없는 PDF는 NODA /parse로 읽는다(한 번 60초)
export const maxDuration = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * AI 태그 초안(2026-11-05) — `POST`. 문서 앞부분과 기관이 이미 쓰는 태그를 보고 태그를 5개까지 제안한다. **저장하지 않는다**
 * (사람이 고쳐 PATCH /api/documents/[id]로 저장). 태그를 고칠 수 있는 사람만(documentTagAccess), 기관 한도 안에서만.
 * 모델 호출은 사용 기록(`document_tag_suggest` — 모델·토큰·원가)을 남긴다. 운영 기록에 문서 이름을 남기지 않는다.
 */
export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('로그인이 필요합니다.', 401);
    const actor = await getActorScope(session);
    if (!actor?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);
    if (!UUID.test(params.id)) return jsonError('문서를 찾을 수 없습니다.', 404);

    const { data: doc, error } = await supabaseAdmin
      .from('documents')
      .select('id, agent_id, department_id, organization_id, visibility, storage_path, file_name, title')
      .eq('id', params.id)
      .eq('organization_id', actor.organizationId)
      .maybeSingle();
    if (error) return jsonError('문서를 불러오지 못했습니다.', 500);
    const access = doc ? await documentTagAccess(doc, actor) : 'hidden';
    if (access === 'hidden') return jsonError('문서를 찾을 수 없습니다.', 404);
    if (access === 'forbidden') return jsonError('이 문서의 태그를 고칠 권한이 없습니다.', 403);
    if (!doc!.storage_path) return jsonError('원본 파일이 없어 초안을 만들 수 없습니다.', 404);

    // AI를 부르기 전에 한도를 본다(개인 한도 포함) — 초안도 토큰을 쓴다
    const limit = await checkTokenLimit(actor.departmentId, actor.userId);
    if (!limit.allowed) return jsonError(limitMessage(limit), 429);

    const { data: blob, error: downloadError } = await supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET).download(doc!.storage_path);
    if (downloadError || !blob) return jsonError('원본 파일을 찾을 수 없습니다.', 404);
    const bytes = Buffer.from(await blob.arrayBuffer());
    if (bytes.byteLength > MAX_UPLOAD_BYTES) return jsonError('원본 파일이 너무 커서 초안을 만들 수 없습니다.', 413);
    let text: string;
    try {
      text = (await readAttachment(bytes, doc!.file_name)).text;
    } catch (err) {
      if (err instanceof AttachmentReadError) return jsonError(`문서를 읽지 못했습니다: ${err.message}`, 422);
      throw err;
    }
    if (!text.trim()) return jsonError('문서에서 읽을 글이 없습니다.', 422);

    // 기관이 이미 쓰는 태그 — 표기를 맞추려고 모델에 함께 준다(많이 쓴 순). 요청자가 볼 수 있는 문서의 태그만(부서 제한 문서의 태그 이름도 새지 않게)
    const { data: tagged } = await supabaseAdmin
      .from('documents')
      .select('file_name, noda_status, tags, department_id, organization_id, visibility')
      .eq('organization_id', actor.organizationId)
      .neq('tags', '{}')
      .limit(1000);
    type TaggedRow = { file_name: string; noda_status: string | null; tags: string[]; department_id: string; organization_id: string | null; visibility: string | null };
    const visible = ((tagged ?? []) as TaggedRow[]).filter((r) => canReadDocument(r, actor));
    const vocabulary = tagCounts(visible).map((t) => t.tag).slice(0, TAG_SUGGEST_VOCABULARY);

    const result = await complete({
      model: await resolveModelForDepartment(actor.departmentId),
      system: TAG_SUGGEST_SYSTEM,
      maxTokens: TAG_SUGGEST_MAX_TOKENS,
      messages: [{ role: 'user', content: buildTagSuggestMessage({ title: doc!.title?.trim() || doc!.file_name, fileName: doc!.file_name, vocabulary, text }) }],
    });
    // 답을 못 읽어도 쓴 토큰은 기록한다(과금 규약)
    await writeUsageLog({
      departmentId: actor.departmentId,
      userId: actor.userId,
      action: 'document_tag_suggest',
      resourceType: 'document',
      resourceId: doc!.id,
      details: buildUsageDetails(result.usage, { agent_id: doc!.agent_id }),
    });
    const suggestions = parseTagSuggestions(result.text, vocabulary);
    if (!suggestions) return jsonError('태그 초안을 만들지 못했습니다. 다시 시도해 주세요.', 502);
    return NextResponse.json({ ok: true, data: { suggestions, fromVocabulary: suggestions.filter((s) => vocabulary.includes(s)) } });
  } catch (error) {
    console.error('[documents tag-suggest]', params.id, error instanceof Error ? error.message : error);
    return jsonError('태그 초안을 만들지 못했습니다.', 500);
  }
}
