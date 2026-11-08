import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { canUseAgent, AGENT_ACCESS_COLUMNS } from '@/lib/agent-permissions';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { findBuiltinTemplate, loadBuiltinTemplate } from '@/lib/builtin-templates';
import { saveGeneratedFile, safeFileName } from '@/lib/generated-files';
import { AppExportTemplateError, buildAppResultHwpx, buildAppResultInTemplate } from '@/lib/apps/export';
import { appStepsCompleted } from '@/lib/apps/pipeline';
import { detectFormat } from '@/lib/doc-fill';

export const dynamic = 'force-dynamic';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });
type Session = NonNullable<Awaited<ReturnType<typeof getServerAuthSession>>>;
type TemplateRow = { id: string; name: string; file_name: string; storage_path: string };

/** 대화 주인·지금 그 앱을 쓸 수 있는 사람만 — 두 핸들러가 같은 검사를 거친다 */
async function conversationApp(session: Session, conversationId: string) {
  const actor = await getActorScope(session);
  if (!actor?.organizationId) return fail('기관 소속을 확인할 수 없습니다.', 403);
  const { data: conversation, error: conversationError } = await supabaseAdmin.from('conversations').select('id,agent_id,department_id').eq('id', conversationId).eq('user_id', session.user.id).maybeSingle();
  if (conversationError) return fail('대화를 확인하지 못했습니다.', 503);
  if (!conversation) return fail('대화를 찾을 수 없습니다.', 404);
  const { data: agent, error: agentError } = await supabaseAdmin.from('agents').select(`${AGENT_ACCESS_COLUMNS},name`).eq('id', conversation.agent_id).maybeSingle();
  if (agentError) return fail('앱 권한을 확인하지 못했습니다.', 503);
  if (!agent || !canUseAgent(agent, actor)) return fail('현재 사용할 수 없는 앱입니다.', 403);
  return { actor, conversation, agent };
}

/** 지금 판에 쓰는 이 앱의 양식 중 한글(HWPX) 파일만 — 기관 양식은 앱 비서에 올려 둔 것(`agent_templates`) */
async function hwpxTemplates(agentId: string) {
  return supabaseAdmin.from('agent_templates').select('id,name,file_name,storage_path').eq('agent_id', agentId).is('retired_at', null).order('created_at', { ascending: true });
}
const isHwpxName = (name: string) => /\.hwpx$/i.test(name);

/** 결과를 담을 수 있는 기관 양식 목록 — 이름만(저장소 경로는 내보내지 않는다) */
export async function GET(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  const conversationId = request.nextUrl.searchParams.get('conversationId') ?? '';
  if (!uuid.test(conversationId)) return fail('대화를 확인해 주세요.', 400);
  const app = await conversationApp(session, conversationId);
  if (app instanceof NextResponse) return app;
  const { data, error } = await hwpxTemplates(app.agent.id);
  if (error) return fail('양식 목록을 읽지 못했습니다.', 503);
  return NextResponse.json({ ok: true, data: { templates: ((data ?? []) as TemplateRow[]).filter(t => isHwpxName(t.file_name)).map(t => ({ id: t.id, name: t.name })) } });
}

export async function POST(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  let body;
  try { body = await request.json(); } catch { return fail('요청 형식을 확인해 주세요.', 400); }
  if (!body || typeof body.conversationId !== 'string' || !uuid.test(body.conversationId) || typeof body.expectedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(body.expectedHash) || (body.messageId !== undefined && (typeof body.messageId !== 'string' || !uuid.test(body.messageId))) || (body.templateId !== undefined && (typeof body.templateId !== 'string' || !uuid.test(body.templateId)))) return fail('내보낼 대화와 결과를 확인해 주세요.', 400);
  const app = await conversationApp(session, body.conversationId);
  if (app instanceof NextResponse) return app;
  const { actor, conversation, agent } = app;
  let query = supabaseAdmin.from('messages').select('id,content,source_references,agent_version').eq('conversation_id', conversation.id).eq('role', 'assistant');
  if (body.messageId) query = query.eq('id', body.messageId);
  const { data: message, error: messageError } = await query.order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (messageError) return fail('결과를 확인하지 못했습니다.', 503);
  if (!message || typeof message.content !== 'string' || !message.content.trim()) return fail('저장된 결과를 찾을 수 없습니다.', 404);
  const hash = createHash('sha256').update(message.content).digest('hex');
  if (hash !== body.expectedHash.toLowerCase()) return fail('화면과 저장된 결과가 다릅니다. 대화를 다시 열어 내려받아 주세요.', 409);
  const refs = message.source_references ?? {};
  if (!appStepsCompleted(refs.app_steps)) return fail('완료되지 않은 단계의 결과는 파일로 만들 수 없습니다.', 409);

  // 기관 양식은 이 대화의 앱이 지금 쓰는 것만(다른 앱의 양식 id를 넣어도 찾지 못한다). 양식 행은 바뀌지 않으므로 id가 파일 내용을 정한다
  let template: TemplateRow | null = null;
  if (body.templateId) {
    const { data, error } = await hwpxTemplates(agent.id);
    if (error) return fail('양식을 확인하지 못했습니다.', 503);
    template = ((data ?? []) as TemplateRow[]).find(t => t.id.toLowerCase() === body.templateId.toLowerCase()) ?? null;
    if (!template) return fail('이 앱에서 쓸 수 있는 양식이 아닙니다.', 404);
    if (!isHwpxName(template.file_name)) return fail('한글(HWPX) 양식에만 결과를 담을 수 있습니다.', 422);
  }
  const ref = `app-result:${message.id}:${hash}${template ? `:${template.id}` : ''}`;
  async function cached() {
    return supabaseAdmin.from('generated_files').select('id,file_name,size_bytes').eq('user_id', session!.user.id).eq('conversation_id', conversation.id).eq('template_ref', ref).maybeSingle();
  }
  const existing = await cached();
  if (existing.error) return fail('파일 기록을 확인하지 못했습니다.', 503);
  if (existing.data) return NextResponse.json({ ok: true, data: existing.data });
  const input = { name: agent.name, version: message.agent_version, content: message.content, references: refs, createdAt: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) };
  let bytes: Buffer;
  let emptied: string[] = [];
  try {
    if (template) {
      const { data: blob, error } = await supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET).download(template.storage_path);
      if (error || !blob) return fail('양식 파일을 받지 못했습니다. 잠시 후 다시 시도해 주세요.', 503);
      const source = Buffer.from(await blob.arrayBuffer());
      if (detectFormat(template.file_name, source) !== 'hwpx') return fail('한글(HWPX) 양식에만 결과를 담을 수 있습니다.', 422);
      ({ bytes, emptied } = await buildAppResultInTemplate(source, input));
    } else {
      const standard = await loadBuiltinTemplate(findBuiltinTemplate('builtin:report')!);
      if (!standard) return fail('기본 한글 양식이 준비되지 않았습니다.', 503);
      bytes = await buildAppResultHwpx(standard, input);
    }
  } catch (err) {
    if (err instanceof AppExportTemplateError) return fail(err.message, 422);
    return fail('파일을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.', 503);
  }
  try {
    const file = await saveGeneratedFile({ organizationId: actor.organizationId!, departmentId: actor.departmentId, userId: session.user.id, agentId: agent.id, conversationId: conversation.id, templateRef: ref, templateName: template ? template.name : '앱 실행 결과', fileName: safeFileName(`${agent.name} 작성 결과`, 'hwpx'), extension: 'hwpx', mimeType: 'application/hwp+zip', bytes });
    return NextResponse.json({ ok: true, data: { ...file, ...(emptied.length ? { emptied } : {}) } });
  } catch {
    // A concurrent insert may have won; the storage helper removes its losing upload.
    const winner = await cached();
    if (!winner.error && winner.data) return NextResponse.json({ ok: true, data: winner.data });
    return fail('파일을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.', 503);
  }
}
