// src/lib/work/client.ts
/**
 * 업무 화면용 도우미 — 브라우저 코드다. config.ts(서버 비밀값)를 가져오지 않는다(config-public-guard 시험).
 * 상태값은 영문 그대로 보이지 않고 한국어 문구로 바꾼다(개편 05 문서 4절).
 */
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config-public';
import { storageClient } from '@/lib/browser-storage';
import { MAX_ATTACHMENT_BYTES, attachmentExtension, refusedFormatMessage } from '@/lib/attachments/limits';

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export type ApiResult<T> = { ok: true; data: T; status: number } | { ok: false; error: ApiError; status: number };

export async function api<T>(url: string, init?: RequestInit & { json?: unknown; idempotencyKey?: string }): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (init?.json !== undefined) headers['Content-Type'] = 'application/json';
  if (init?.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  try {
    const res = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string>) }, body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body });
    const body = await res.json().catch(() => null);
    if (body?.ok === true) return { ok: true, data: body.data as T, status: res.status };
    const err = body?.error ?? {};
    return { ok: false, status: res.status, error: { code: String(err.code ?? 'HTTP_' + res.status), message: String(err.message ?? '요청을 처리하지 못했습니다.'), details: err.details } };
  } catch {
    return { ok: false, status: 0, error: { code: 'NETWORK', message: '네트워크 오류가 발생했습니다. 다시 시도해 주세요.' } };
  }
}

export function newIdempotencyKey(): string {
  return (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9_-]/g, '');
}

export const TASK_STATUS_LABEL: Record<string, string> = {
  draft: '입력 필요',
  ready: '만들 준비됨',
  processing: '처리 중',
  needs_review: '검토 필요',
  approved: '검토 완료',
  completed: '완료',
  archived: '보관됨',
};

export const RUN_STATUS_LABEL: Record<string, string> = {
  queued: '처리 대기',
  running: '처리 중',
  succeeded: '끝남',
  failed: '실패',
  canceled: '취소됨',
  superseded: '새 요청으로 대체됨',
};

export const PREVIEW_STATUS_LABEL: Record<string, string> = {
  pending: '실제 파일 미리보기 준비 중',
  ready: '실제 파일 미리보기 있음',
  failed: '실제 파일 미리보기 실패',
  unsupported: '실제 파일 미리보기 없음(이 서버에 렌더러 없음)',
};

export const SEVERITY_LABEL: Record<string, string> = { blocking: '반드시 고칠 것', warning: '확인 필요', info: '참고' };

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function formatBytes(n: number | null | undefined): string {
  if (!n) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export function checkSourceFile(file: { name: string; size: number }): string | null {
  const refused = refusedFormatMessage(file.name);
  if (refused) return refused;
  if (!attachmentExtension(file.name)) return '엑셀·CSV·한글·워드·PDF·파워포인트·TXT 파일만 올릴 수 있습니다.';
  if (file.size <= 0) return '빈 파일입니다.';
  if (file.size > MAX_ATTACHMENT_BYTES) return `파일이 너무 큽니다. ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB 이하로 올려 주세요.`;
  return null;
}

/** 원자료 올리기: 주소 발급 → 저장소에 직접 → 서버 확인(읽기). 바이트는 함수 본문을 거치지 않는다 */
export async function uploadSource(taskId: string, file: File, purpose: string, onStage: (s: 'uploading' | 'reading') => void): Promise<{ ok: true; source: unknown } | { ok: false; message: string }> {
  const local = checkSourceFile(file);
  if (local) return { ok: false, message: local };
  if (!PUBLIC_SUPABASE_URL || !PUBLIC_SUPABASE_ANON_KEY) return { ok: false, message: '파일 올리기 설정이 없습니다. 관리자에게 문의하세요.' };
  const issued = await api<{ sourceId: string; path: string; token: string }>(`/api/work/tasks/${taskId}/sources/upload-url`, {
    method: 'POST',
    json: { fileName: file.name, size: file.size, purpose },
  });
  if (!issued.ok) return { ok: false, message: issued.error.message };
  onStage('uploading');
  const { error } = await storageClient().storage.from(SUPABASE_DOCUMENTS_BUCKET).uploadToSignedUrl(issued.data.path, issued.data.token, file);
  if (error) return { ok: false, message: '파일을 올리지 못했습니다. 다시 시도해 주세요.' };
  onStage('reading');
  const confirmed = await api<unknown>(`/api/work/tasks/${taskId}/sources/confirm`, { method: 'POST', json: { sourceId: issued.data.sourceId } });
  if (!confirmed.ok) return { ok: false, message: confirmed.error.message };
  return { ok: true, source: confirmed.data };
}
