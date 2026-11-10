// src/lib/apps/schedule-files.ts
// 입력형 앱 예약의 올린 파일(0073). 예약은 파일 **사본**을 따로 갖는다.
//
// - 만들기·고치기: 직원이 실행 화면에 붙인 **읽힌 첨부**(`chat_attachments`, 그 직원의 것·`ready`만)를 예약 경로
//   `app-schedule-files/{기관}/{직원}/{id}.{확장자}`로 복사해 `app_schedules.files`에 적는다. 첨부는 한 대화에 묶이고
//   보내지 않으면 24시간 뒤 정리되므로 첨부 id를 그대로 저장하지 않는다.
// - 실행: 실행마다 사본을 **새 첨부로 다시 올린다**(`attachStoredObject` — 직접 올리기·지난 파일 다시 붙이기와 같은 발급·확인 길이라
//   형식·크기·읽기·스캔 PDF·사용 기록 규칙이 같다). 그 첨부를 그 실행의 대화에 붙이고, 실행이 시작 전에 거절되면 묘비로 지운다.
// - 지우기: 예약을 지우거나 고칠 때 뺀 파일·탈퇴한 직원의 예약 파일은 DB를 바꾼 뒤 사본을 지운다(실패는 기록만).
import { randomUUID } from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { logSystem } from '@/lib/logger';
import { attachmentExtension } from '@/lib/attachments/limits';
import { attachStoredObject } from '@/lib/attachments/reuse';
import { deleteAttachment } from '@/lib/attachments/store';
import { scheduleFilePath, type ScheduleFile } from './schedule-file-spec';

export { SCHEDULE_FILE_PREFIX, scheduleFilePath, scheduleFilesOf, scheduleFileViews, parseIdList, keptFiles, type ScheduleFile, type ScheduleFileView } from './schedule-file-spec';

type Failure = { ok: false; status: number; message: string };
export const SCHEDULE_FILES_NOT_FOUND = '예약에 붙일 파일을 찾을 수 없습니다. 파일을 다시 붙인 뒤 저장해 주세요.';
const SCHEDULE_FILES_RETRY = '예약에 붙일 파일을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';

/**
 * 직원의 읽힌 첨부를 예약 사본으로 복사한다. 하나라도 못 하면 이미 만든 사본을 지우고 실패.
 * 원본은 **요청자의 것·`ready`만**(관리자도 남의 첨부를 가져오지 못한다)
 */
export async function copyAttachmentsForSchedule(
  actor: { userId: string; organizationId: string },
  attachmentIds: string[]
): Promise<{ ok: true; files: ScheduleFile[] } | Failure> {
  return copyAttachmentsTo(actor, attachmentIds, (fileId, ext) => scheduleFilePath(actor.organizationId, actor.userId, fileId, ext));
}

/**
 * 직원의 읽힌 첨부를 `pathFor`가 정한 경로로 복사한다(예약 0073·일괄 실행의 파일마다 한 건 2026-11-10). 하나라도 못 하면 만든 사본을 지우고 실패.
 * 원본은 **요청자의 것·`ready`만**. 돌려주는 순서는 요청한 id 순서
 */
export async function copyAttachmentsTo(
  actor: { userId: string; organizationId: string },
  attachmentIds: string[],
  pathFor: (fileId: string, ext: string) => string
): Promise<{ ok: true; files: ScheduleFile[] } | Failure> {
  if (!attachmentIds.length) return { ok: true, files: [] };
  const { data, error } = await supabaseAdmin.from('chat_attachments').select('id, file_name, size_bytes, storage_path')
    .eq('user_id', actor.userId).eq('status', 'ready').in('id', attachmentIds);
  if (error) return { ok: false, status: 503, message: SCHEDULE_FILES_RETRY };
  const rows = (data ?? []) as { id: string; file_name: string; size_bytes: number | null; storage_path: string }[];
  const byId = new Map(rows.map((r) => [r.id.toLowerCase(), r]));
  if (attachmentIds.some((id) => !byId.has(id))) return { ok: false, status: 400, message: SCHEDULE_FILES_NOT_FOUND };
  const bucket = supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET);
  const made: ScheduleFile[] = [];
  for (const id of attachmentIds) {
    const row = byId.get(id)!;
    const ext = attachmentExtension(row.file_name);
    if (!ext) { await removeScheduleFileObjects(made, '예약 파일 복사 실패 뒤 정리'); return { ok: false, status: 400, message: SCHEDULE_FILES_NOT_FOUND }; }
    const fileId = randomUUID();
    const path = pathFor(fileId, ext);
    const { error: copyError } = await bucket.copy(row.storage_path, path);
    if (copyError) { await removeScheduleFileObjects(made, '예약 파일 복사 실패 뒤 정리'); return { ok: false, status: 503, message: SCHEDULE_FILES_RETRY }; }
    made.push({ id: fileId, name: row.file_name, size: Number(row.size_bytes ?? 0), path });
  }
  return { ok: true, files: made };
}

/** 사본 지우기 — 실패는 기록만(경로를 남겨 손으로 지울 수 있게). 던지지 않는다 */
export async function removeScheduleFileObjects(files: ScheduleFile[], context: string): Promise<void> {
  const paths = files.map((f) => f.path);
  if (!paths.length) return;
  try {
    const { error } = await supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET).remove(paths);
    if (error) throw new Error(error.message);
  } catch (e) {
    await logSystem({ level: 'warning', category: 'database', message: `${context} — 파일 사본이 남았을 수 있음`, details: { paths, error: e instanceof Error ? e.message : String(e) } }).catch(() => undefined);
  }
}

export const SCHEDULE_FILE_UNREADABLE = (name: string, reason: string | null) => `예약에 저장한 파일 '${name}'을 읽지 못했습니다${reason ? `(${reason})` : ''}.`;
export const SCHEDULE_FILE_MISSING = (name: string) => `예약에 저장한 파일 '${name}'을 불러오지 못했습니다.`;

export interface ScheduleFileIo {
  attach(actor: { userId: string; departmentId: string; organizationId: string }, file: ScheduleFile): ReturnType<typeof attachStoredObject>;
  discard(userId: string, attachmentId: string): Promise<unknown>;
}
export const defaultScheduleFileIo: ScheduleFileIo = {
  attach: (actor, file) => attachStoredObject(actor, { storage_path: file.path, file_name: file.name }),
  discard: (userId, id) => deleteAttachment(userId, id),
};

/**
 * 실행 때 — 사본마다 새 첨부를 올린다. 하나라도 못 하면 만든 첨부를 묘비로 지우고 그 이유(예약은 '실패', 다음 차례에 다시 —
 * 연속 3회면 멈춤). 올린 첨부는 직원이 직접 올린 것과 같다(보내지 않으면 24시간 뒤 정리)
 */
export async function attachScheduleFiles(
  actor: { userId: string; departmentId: string; organizationId: string },
  files: ScheduleFile[],
  io: ScheduleFileIo = defaultScheduleFileIo
): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  const ids: string[] = [];
  for (const file of files) {
    let error: string | null = null;
    try {
      const result = await io.attach(actor, file);
      if (!result.ok) error = result.status === 404 ? SCHEDULE_FILE_MISSING(file.name) : result.message;
      else if (result.attachment.status !== 'ready') { ids.push(result.attachment.id); error = SCHEDULE_FILE_UNREADABLE(file.name, result.attachment.error); }
      else ids.push(result.attachment.id);
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 200) : SCHEDULE_FILE_MISSING(file.name);
    }
    if (error) {
      await discardAttachments(actor.userId, ids, io);
      return { ok: false, error };
    }
  }
  return { ok: true, ids };
}

/** 대화에 묶이지 못한 첨부를 묘비로 — 묶인 것은 건드리지 않는다(`deleteAttachment`가 묶이지 않은 것만 바꾼다) */
export async function discardAttachments(userId: string, ids: string[], io: ScheduleFileIo = defaultScheduleFileIo): Promise<void> {
  for (const id of ids) {
    try { await io.discard(userId, id); } catch { /* 24시간 정리가 치운다 */ }
  }
}
