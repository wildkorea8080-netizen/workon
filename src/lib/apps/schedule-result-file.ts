// src/lib/apps/schedule-result-file.ts
// 예약 실행 결과를 한글(HWPX) 파일로도 만든다(0071) — 직원이 예약마다 고른 경우만.
//
// - 손으로 내보내기(`/api/apps/export`)와 **같은 규칙**: 저장된 답을 모델 없이 담고, 끝나지 않은 단계가 있으면 만들지 않으며,
//   같은 열쇠(`app-result:{메시지}:{답 해시}`, 기관 양식이면 `:{양식 id}`)로 한 벌만 둔다 — 나중에 대화에서 같은 양식으로
//   '한글 파일 만들기'를 눌러도 새로 만들지 않고 이 파일을 돌려준다.
// - 양식(2026-11-08): 앱 설정의 결과 한글 파일 양식(`app_definition.exportTemplateId`)이 그 앱의 지금 HWPX 양식이면 그 양식에,
//   아니면(없음·지운 양식·본문 표시 없음·읽기 실패) **표준 보고서**로 만든다 — 예약 결과 파일이 양식 문제로 빠지지 않게.
// - 파일은 그 직원의 '대화에서 만든 파일'(`generated_files`)에 남고, 내려받기는 주인만(`/api/files/[id]`).
import { createHash } from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { findBuiltinTemplate, loadBuiltinTemplate } from '@/lib/builtin-templates';
import { saveGeneratedFile, safeFileName } from '@/lib/generated-files';
import { detectFormat } from '@/lib/doc-fill';
import { buildAppResultHwpx, buildAppResultInTemplate, type AppResultInput } from './export';
import { appStepsCompleted } from './pipeline';

export type ScheduleResultRow = { user_id: string; organization_id: string; department_id: string; agent_id: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 앱 설정의 양식이 이 앱의 지금 HWPX 양식이면 그 바이트로 담아 본다. 쓸 수 없으면 null(표준 보고서로) */
async function inAppTemplate(agentId: string, templateId: unknown, input: AppResultInput): Promise<{ id: string; name: string; bytes: Buffer } | null> {
  if (typeof templateId !== 'string' || !UUID.test(templateId)) return null;
  const { data, error } = await supabaseAdmin.from('agent_templates').select('id,name,file_name,storage_path')
    .eq('id', templateId).eq('agent_id', agentId).is('retired_at', null).maybeSingle();
  const t = data as { id: string; name: string; file_name: string; storage_path: string } | null;
  if (error || !t || !/\.hwpx$/i.test(t.file_name)) return null;
  const { data: blob, error: downloadError } = await supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET).download(t.storage_path);
  if (downloadError || !blob) return null;
  const source = Buffer.from(await blob.arrayBuffer());
  if (detectFormat(t.file_name, source) !== 'hwpx') return null;
  try {
    return { id: t.id, name: t.name, bytes: (await buildAppResultInTemplate(source, input)).bytes };
  } catch {
    return null; // 본문 표시 없음·패키지 검사 실패 — 표준 보고서로
  }
}

/** 결과 파일 id를 돌려준다. 만들 수 없는 결과(끝나지 않은 단계·빈 답)는 null. DB·저장 오류는 던진다 */
export async function saveScheduledResultFile(row: ScheduleResultRow, conversationId: string): Promise<string | null> {
  const [{ data: message, error: messageError }, { data: agent, error: agentError }] = await Promise.all([
    supabaseAdmin.from('messages').select('id,content,source_references,agent_version').eq('conversation_id', conversationId).eq('role', 'assistant')
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabaseAdmin.from('agents').select('name,app_definition').eq('id', row.agent_id).maybeSingle(),
  ]);
  if (messageError) throw new Error(`messages: ${messageError.message}`);
  if (agentError) throw new Error(`agents: ${agentError.message}`);
  const m = message as { id: string; content: unknown; source_references: Record<string, unknown> | null; agent_version: number | null } | null;
  if (!m || typeof m.content !== 'string' || !m.content.trim()) return null;
  const refs = m.source_references ?? {};
  if (!appStepsCompleted(refs.app_steps)) return null;
  const a = agent as { name?: unknown; app_definition?: { exportTemplateId?: unknown } | null } | null;
  const name = typeof a?.name === 'string' ? a.name : '입력형 앱';
  const hash = createHash('sha256').update(m.content).digest('hex');
  const input: AppResultInput = { name, version: m.agent_version, content: m.content, references: refs, createdAt: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) };

  const cached = (ref: string) => supabaseAdmin.from('generated_files').select('id').eq('user_id', row.user_id).eq('conversation_id', conversationId).eq('template_ref', ref).maybeSingle();
  const templateId = a?.app_definition?.exportTemplateId;
  // 같은 양식으로 이미 만든 파일이 있으면 그것(손 내보내기와 같은 열쇠)
  if (typeof templateId === 'string' && UUID.test(templateId)) {
    const hit = await cached(`app-result:${m.id}:${hash}:${templateId.toLowerCase()}`);
    if (hit.error) throw new Error(`generated_files: ${hit.error.message}`);
    if (hit.data) return (hit.data as { id: string }).id;
  }
  const custom = await inAppTemplate(row.agent_id, templateId, input);
  const ref = `app-result:${m.id}:${hash}${custom ? `:${custom.id}` : ''}`;
  if (!custom) {
    const existing = await cached(ref);
    if (existing.error) throw new Error(`generated_files: ${existing.error.message}`);
    if (existing.data) return (existing.data as { id: string }).id;
  }
  let bytes = custom?.bytes;
  if (!bytes) {
    const standard = await loadBuiltinTemplate(findBuiltinTemplate('builtin:report')!);
    if (!standard) throw new Error('기본 한글 양식이 준비되지 않았습니다.');
    bytes = await buildAppResultHwpx(standard, input);
  }
  try {
    const file = await saveGeneratedFile({
      organizationId: row.organization_id, departmentId: row.department_id, userId: row.user_id, agentId: row.agent_id, conversationId,
      templateRef: ref, templateName: custom ? custom.name : '앱 실행 결과', fileName: safeFileName(`${name} 작성 결과`, 'hwpx'), extension: 'hwpx', mimeType: 'application/hwp+zip', bytes,
    });
    return file.id;
  } catch (error) {
    // 같은 답을 동시에 만들었으면 먼저 들어간 것을 쓴다(저장 도우미가 진 쪽 업로드를 지운다)
    const winner = await cached(ref);
    if (!winner.error && winner.data) return (winner.data as { id: string }).id;
    throw error;
  }
}
