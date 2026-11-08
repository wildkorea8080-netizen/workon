// src/lib/apps/schedule-file-spec.ts
// 예약의 올린 파일(0073) — 꼴 읽기만(순수). 화면(예약 꼴 schedule-spec.ts)도 쓰므로 서버 모듈을 가져오지 않는다.
import { APP_MAX_FILES } from './definition';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SCHEDULE_FILE_PREFIX = 'app-schedule-files';

/** 예약이 가진 파일 사본 하나 — `path`는 화면으로 내보내지 않는다 */
export type ScheduleFile = { id: string; name: string; size: number; path: string };
/** 화면용(경로 없음) */
export type ScheduleFileView = { id: string; name: string; size: number };

export function scheduleFilePath(organizationId: string, userId: string, fileId: string, ext: string): string {
  return `${SCHEDULE_FILE_PREFIX}/${organizationId}/${userId}/${fileId}.${ext}`;
}

/** DB 칸 → 파일 목록. 꼴이 틀린 원소는 버린다(경로는 예약 접두사 안만) */
export function scheduleFilesOf(raw: unknown): ScheduleFile[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((f) => {
    if (!f || typeof f !== 'object') return [];
    const { id, name, size, path } = f as Record<string, unknown>;
    if (typeof id !== 'string' || !UUID.test(id) || typeof name !== 'string' || !name || typeof size !== 'number' || !Number.isFinite(size)
      || typeof path !== 'string' || !path.startsWith(`${SCHEDULE_FILE_PREFIX}/`) || path.includes('..')) return [];
    return [{ id: id.toLowerCase(), name, size, path }];
  }).slice(0, APP_MAX_FILES);
}

export const scheduleFileViews = (files: ScheduleFile[]): ScheduleFileView[] => files.map(({ id, name, size }) => ({ id, name, size }));

/** 요청의 uuid 목록(없으면 빈 목록, 꼴이 틀리면 null) — 겹친 id는 한 번 */
export function parseIdList(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > APP_MAX_FILES || raw.some((v) => typeof v !== 'string' || !UUID.test(v))) return null;
  return [...new Set((raw as string[]).map((v) => v.toLowerCase()))];
}

/**
 * 고치기의 '남길 파일' — `file_ids`가 없으면 지금 파일을 모두 남긴다(옛 화면과 맞음). 지금 예약에 없는 id가 있으면 null
 */
export function keptFiles(current: ScheduleFile[], raw: unknown): ScheduleFile[] | null {
  if (raw === undefined) return current;
  const ids = parseIdList(raw);
  if (!ids) return null;
  const byId = new Map(current.map((f) => [f.id, f]));
  if (ids.some((id) => !byId.has(id))) return null;
  return ids.map((id) => byId.get(id)!);
}
