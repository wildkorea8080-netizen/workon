/**
 * 화면용 첨부 올리기 — ① 주소 발급 → ② 저장소에 직접 올리기 → ③ 확인(서버가 읽음).
 *
 * 파일을 서버 함수로 보내지 않는 이유는 Vercel 요청 본문 상한(4.5MB) 때문이다(설계 4.1).
 * 여기 검사(형식·크기)는 표시일 뿐이고 서버가 다시 본다.
 */
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config-public';
import { storageClient } from '@/lib/browser-storage';
import { MAX_ATTACHMENT_BYTES, attachmentExtension, refusedFormatMessage } from './limits';
import type { AttachmentRow } from './types';

export type UploadStage = 'uploading' | 'reading';
export type UploadResult = { ok: true; attachment: AttachmentRow } | { ok: false; message: string };

const NETWORK_ERROR = '네트워크 오류가 발생했습니다. 다시 시도해 주세요.';
const UPLOAD_ERROR = '파일을 올리지 못했습니다. 다시 시도해 주세요.';

const MISSING_CONFIG = '파일 올리기 설정이 없습니다. 관리자에게 문의하세요.';

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok && json?.ok === true, json };
}

function errorMessage(json: unknown, fallback: string): string {
  const message = (json as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === 'string' && message ? message : fallback;
}

/** 올리기 전에 화면에서 거르는 검사. 통과하면 null */
export function checkAttachmentFile(file: { name: string; size: number }): string | null {
  const refused = refusedFormatMessage(file.name);
  if (refused) return refused;
  if (!attachmentExtension(file.name)) return '지원하지 않는 형식입니다. 엑셀·한글·워드·PDF·파워포인트·텍스트 파일을 올려 주세요.';
  if (file.size <= 0) return '빈 파일입니다.';
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `파일이 너무 큽니다. ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB 이하로 올려 주세요.`;
  }
  return null;
}

export async function uploadAttachment(
  file: File,
  onStage: (stage: UploadStage) => void
): Promise<UploadResult> {
  const local = checkAttachmentFile(file);
  if (local) return { ok: false, message: local };

  // 설정이 비면 주소 발급(서버 기록)부터 만들지 않는다 — 올릴 수 없는 첨부가 상한만 차지한다
  if (!PUBLIC_SUPABASE_URL || !PUBLIC_SUPABASE_ANON_KEY) return { ok: false, message: MISSING_CONFIG };

  onStage('uploading');
  let issued: { id: string; path: string; token: string };
  try {
    const res = await postJson('/api/attachments/upload-url', { file_name: file.name, size: file.size });
    if (!res.ok) return { ok: false, message: errorMessage(res.json, '업로드 주소를 받지 못했습니다.') };
    issued = res.json.data;
  } catch {
    return { ok: false, message: NETWORK_ERROR };
  }

  try {
    const { error } = await storageClient()
      .storage.from(SUPABASE_DOCUMENTS_BUCKET)
      .uploadToSignedUrl(issued.path, issued.token, file);
    if (error) throw error;
  } catch {
    // 삭제하면 서버 기록이 바로 묘비(failed)가 된다 — 확인(읽기)을 시도할 일이 없고, 묘비는 서명 주소 시한
    // (약 2시간)이 지나면 '보내지 않은 첨부' 상한에서 빠진다. 이 호출이 실패해도 기록은 pending으로 남아
    // 24시간 뒤 정리된다(그동안 상한을 차지한다).
    void fetch(`/api/attachments/${issued.id}`, { method: 'DELETE' }).catch(() => {});
    return { ok: false, message: UPLOAD_ERROR };
  }

  onStage('reading');
  try {
    const res = await postJson('/api/attachments', { id: issued.id });
    if (!res.ok) return { ok: false, message: errorMessage(res.json, '파일을 읽지 못했습니다.') };
    return { ok: true, attachment: res.json.data as AttachmentRow };
  } catch {
    return { ok: false, message: NETWORK_ERROR };
  }
}
