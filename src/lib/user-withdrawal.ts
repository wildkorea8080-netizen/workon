// src/lib/user-withdrawal.ts
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { listUserFilePaths, removeUserFiles } from '@/lib/generated-files';
import { listUserAttachmentPaths, removeUserAttachmentObjects } from '@/lib/attachments/store';
import { softDeleteAgent } from '@/lib/agent-store';
import { logSystem } from '@/lib/logger';

/**
 * 사용자 탈퇴 처리 — 슈퍼관리자 '계정 삭제'의 실제 동작 (0047).
 *
 * 행을 지우지 않는다. conversations·messages·usage_logs·documents·agents 등이 users를
 * ON DELETE 없이 가리켜, 대화나 사용 기록이 있는 사용자는 지우려 하면 23503으로 막힌다.
 * 외래 키를 SET NULL로 풀면 사용 기록은 남아도 누가 썼는지가 사라진다 — 사용 기록은
 * 과금·감사 근거라 귀속(이름·부서)을 남기고, 로그인과 개인 내용만 없앤다.
 *
 *   ① 생성 파일·채팅 첨부의 저장소 경로를 모은다 (대화를 지우면 generated_files·chat_attachments 행이 연쇄 삭제돼 경로를 잃는다)
 *   ② 대화를 지운다 → messages·generated_files·묶인 chat_attachments 연쇄 삭제. 대화에 안 묶인 첨부 행(pending·묘비)은
 *      user_id로 따로 지운다 — 사용자 행이 남는 탈퇴에서는 연쇄 삭제가 닿지 않는다
 *   ③ 개인 비서를 숨긴다 (softDeleteAgent — 비서 문서도 정리)
 *   ④ 행에 도장: deleted_at · is_active=false · 이메일을 비석 주소로 (같은 주소로 다시 가입할 수 있게)
 *   ⑤ DB가 끝난 뒤에야 저장소 파일을 지운다 — DB 단계가 실패하면 행은 남고 파일만 사라지면 안 된다
 *   ⑥ Supabase Auth 계정을 지운다 (실패해도 ④의 is_active=false가 로그인을 막는다)
 *
 * ②가 ④보다 먼저인 이유: ④ 뒤에 실패하면 이미 탈퇴로 보여 다시 시도할 수 없다.
 * ②에서 실패하면 아무것도 바뀌지 않았고, ③·④에서 실패해도 deleted_at이 비어 있어 다시 시도할 수 있다.
 */

/** 탈퇴한 사용자의 이메일 자리. 원래 주소를 비워 같은 주소로 다시 가입할 수 있게 한다 */
export function withdrawnEmail(userId: string): string {
  return `withdrawn+${userId}@deleted.invalid`;
}

export type WithdrawOutcome =
  | { ok: true; before: { email: string; full_name: string | null } }
  | { ok: false; status: number; message: string };

/** DB 오류를 사용자에게 보일 한국어 문장으로. 원문은 로그에만 남긴다 */
export function withdrawErrorMessage(error: { code?: string } | null | undefined): string {
  if (error?.code === '23503') {
    return '이 계정을 가리키는 기록이 있어 처리하지 못했습니다. 시스템 로그를 확인해 주세요.';
  }
  return '계정 삭제 중 오류가 발생했습니다.';
}

function fail(status: number, message: string): WithdrawOutcome {
  return { ok: false, status, message };
}

async function dbFailure(step: string, userId: string, error: { code?: string; message: string }): Promise<WithdrawOutcome> {
  await logSystem({
    level: 'error',
    category: 'database',
    message: `사용자 탈퇴 처리 실패 (${step})`,
    details: { userId, code: error.code ?? null, error: error.message },
  });
  return fail(error.code === '23503' ? 409 : 500, withdrawErrorMessage(error));
}

export async function withdrawUser(userId: string, actorId: string): Promise<WithdrawOutcome> {
  const { data: user, error: loadError } = await supabaseAdmin
    .from('users')
    .select('id, email, full_name, is_super_admin, deleted_at')
    .eq('id', userId)
    .maybeSingle();
  if (loadError) return dbFailure('조회', userId, loadError);
  if (!user) return fail(404, '사용자를 찾을 수 없습니다.');
  if (user.deleted_at) return fail(409, '이미 삭제된 계정입니다.');
  // 슈퍼관리자는 활동 기록(super_admin_logs 등)이 얽혀 있고 마지막 한 명을 지키는 검사가 저쪽에 있다
  if (user.is_super_admin) return fail(400, '슈퍼관리자 계정은 슈퍼관리자 탭에서 비활성화해 주세요.');

  // ① 경로 먼저 (DB 연쇄 삭제는 저장소를 지우지 않는다) — 생성 파일(앱 결과 내보내기 포함)과 채팅 첨부
  const filePaths = await listUserFilePaths(userId);
  const attachmentPaths = await listUserAttachmentPaths(userId);

  // ② 대화 — messages·generated_files·묶인 chat_attachments는 conversation_id로 연쇄 삭제된다
  const { error: convError } = await supabaseAdmin.from('conversations').delete().eq('user_id', userId);
  if (convError) return dbFailure('대화 삭제', userId, convError);
  // 대화에 안 묶인 첨부 행(보내지 않은 것·묘비) — 사용자 행은 남으므로 user_id로 직접 지운다
  const { error: attachError } = await supabaseAdmin.from('chat_attachments').delete().eq('user_id', userId);
  if (attachError) return dbFailure('첨부 삭제', userId, attachError);

  // ③ 개인 비서. 실패해도 계속한다 — 개인 비서는 주인만 보는데 주인은 이제 로그인하지 못한다
  const { data: agents, error: agentsError } = await supabaseAdmin
    .from('agents')
    .select('id')
    .eq('owner_id', userId)
    .eq('tier', 'personal')
    .is('deleted_at', null);
  const agentIds = ((agents ?? []) as { id: string }[]).map((a) => a.id);
  const leftAgents: string[] = [];
  for (const id of agentIds) {
    if (!(await softDeleteAgent(id, actorId))) leftAgents.push(id);
  }
  if (agentsError || leftAgents.length) {
    await logSystem({
      level: 'error',
      category: 'database',
      message: '사용자 탈퇴 처리 중 개인 비서 숨기기 실패 — 아래 비서를 손으로 지워야 함',
      details: { userId, agentIds: leftAgents, error: agentsError?.message ?? null },
    });
  }

  // ④ 도장. deleted_at이 빈 행만 — 동시에 두 번 눌러도 한 번만 처리한다
  const { data: stamped, error: stampError } = await supabaseAdmin
    .from('users')
    .update({
      deleted_at: new Date().toISOString(),
      is_active: false,
      email: withdrawnEmail(userId),
      favorite_agent_ids: [],
    })
    .eq('id', userId)
    .is('deleted_at', null)
    .select('id');
  if (stampError) return dbFailure('계정 표시', userId, stampError);
  if (!stamped || stamped.length === 0) return fail(409, '이미 삭제된 계정입니다.');

  // ⑤ 저장소 (실패는 시스템 로그에 남기고 계속) — 생성 파일과 첨부 원본·읽은 내용
  await removeUserFiles(userId, filePaths);
  await removeUserAttachmentObjects(userId, attachmentPaths);

  // ⑥ 로그인 계정
  const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (authError) {
    await logSystem({
      level: 'warning',
      category: 'auth',
      message: '사용자 탈퇴 처리 뒤 Supabase Auth 계정 삭제 실패 — 로그인은 is_active로 막힘',
      details: { userId, error: authError.message },
    });
  }

  return { ok: true, before: { email: user.email, full_name: user.full_name ?? null } };
}

/** 로그인 허용 여부. 비활성(is_active=false)과 삭제(deleted_at) 둘 다 막는다 — nextAuthOptions가 쓴다 */
export function canSignIn(user: { is_active?: boolean | null; deleted_at?: string | null }): boolean {
  return user.is_active !== false && !user.deleted_at;
}
