import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { canUseAgent, AGENT_ACCESS_COLUMNS } from '@/lib/agent-permissions';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { findBuiltinTemplate, loadBuiltinTemplate } from '@/lib/builtin-templates';
import { saveGeneratedFile, safeFileName } from '@/lib/generated-files';
import { buildAppResultHwpx } from '@/lib/apps/export';
import { appStepsCompleted } from '@/lib/apps/pipeline';

export const dynamic = 'force-dynamic';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });

export async function POST(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  let body;
  try { body = await request.json(); } catch { return fail('요청 형식을 확인해 주세요.', 400); }
  if (!body || typeof body.conversationId !== 'string' || !uuid.test(body.conversationId) || typeof body.expectedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(body.expectedHash) || (body.messageId !== undefined && (typeof body.messageId !== 'string' || !uuid.test(body.messageId)))) return fail('내보낼 대화와 결과를 확인해 주세요.', 400);
  const actor = await getActorScope(session);
  if (!actor?.organizationId) return fail('기관 소속을 확인할 수 없습니다.', 403);
  const { data: conversation, error: conversationError } = await supabaseAdmin.from('conversations').select('id,agent_id,department_id').eq('id', body.conversationId).eq('user_id', session.user.id).maybeSingle();
  if (conversationError) return fail('대화를 확인하지 못했습니다.', 503);
  if (!conversation) return fail('대화를 찾을 수 없습니다.', 404);
  const { data: agent, error: agentError } = await supabaseAdmin.from('agents').select(`${AGENT_ACCESS_COLUMNS},name`).eq('id', conversation.agent_id).maybeSingle();
  if (agentError) return fail('앱 권한을 확인하지 못했습니다.', 503);
  if (!agent || !canUseAgent(agent, actor)) return fail('현재 사용할 수 없는 앱입니다.', 403);
  let query = supabaseAdmin.from('messages').select('id,content,source_references,agent_version').eq('conversation_id', conversation.id).eq('role', 'assistant');
  if (body.messageId) query = query.eq('id', body.messageId);
  const { data: message, error: messageError } = await query.order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (messageError) return fail('결과를 확인하지 못했습니다.', 503);
  if (!message || typeof message.content !== 'string' || !message.content.trim()) return fail('저장된 결과를 찾을 수 없습니다.', 404);
  const hash = createHash('sha256').update(message.content).digest('hex');
  if (hash !== body.expectedHash.toLowerCase()) return fail('화면과 저장된 결과가 다릅니다. 대화를 다시 열어 내려받아 주세요.', 409);
  const refs = message.source_references ?? {};
  if (!appStepsCompleted(refs.app_steps)) return fail('완료되지 않은 단계의 결과는 파일로 만들 수 없습니다.', 409);
  const ref = `app-result:${message.id}:${hash}`;
  async function cached() {
    return supabaseAdmin.from('generated_files').select('id,file_name,size_bytes').eq('user_id', session!.user.id).eq('conversation_id', conversation.id).eq('template_ref', ref).maybeSingle();
  }
  const existing = await cached();
  if (existing.error) return fail('파일 기록을 확인하지 못했습니다.', 503);
  if (existing.data) return NextResponse.json({ ok: true, data: existing.data });
  try {
    const template = await loadBuiltinTemplate(findBuiltinTemplate('builtin:report')!);
    if (!template) return fail('기본 한글 양식이 준비되지 않았습니다.', 503);
    const bytes = await buildAppResultHwpx(template, { name: agent.name, version: message.agent_version, content: message.content, references: refs, createdAt: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) });
    const file = await saveGeneratedFile({ organizationId: actor.organizationId, departmentId: actor.departmentId, userId: session.user.id, agentId: agent.id, conversationId: conversation.id, templateRef: ref, templateName: '앱 실행 결과', fileName: safeFileName(`${agent.name} 작성 결과`, 'hwpx'), extension: 'hwpx', mimeType: 'application/hwp+zip', bytes });
    return NextResponse.json({ ok: true, data: file });
  } catch {
    // A concurrent insert may have won; the storage helper removes its losing upload.
    const winner = await cached();
    if (!winner.error && winner.data) return NextResponse.json({ ok: true, data: winner.data });
    return fail('파일을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.', 503);
  }
}
