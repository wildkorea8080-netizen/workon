/**
 * 화면용 참고 문서 올리기 — ① 주소 발급 → ② 저장소에 직접 올리기 → ③ 확인(서버가 문서 행을 만든다).
 * 읽기는 확인 뒤 `startReading`이 문서마다 한꺼번에 건다(읽기는 NODA가 하고 오래 걸린다).
 *
 * 파일을 서버 함수로 보내지 않는 이유는 Vercel 요청 본문 상한(4.5MB) 때문이다.
 * 여기 검사(형식·크기)는 표시일 뿐이고 서버가 다시 본다.
 * 화면 코드이므로 config.ts를 가져오지 않는다(config-public-guard.test.ts).
 */
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config-public';
import { storageClient } from '@/lib/browser-storage';
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_SIZE_LABEL,
  UPLOAD_FORMATS_LABEL,
  hasAllowedUploadExtension,
} from '@/lib/file-types';

export type DocumentUploadStage = 'uploading' | 'registering';
export type DocumentUploadResult = { ok: true; documentIds: string[] } | { ok: false; message: string };

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
export function checkReferenceFile(file: { name: string; size: number }): string | null {
  if (!hasAllowedUploadExtension(file.name)) {
    return `지원하지 않는 형식입니다. ${UPLOAD_FORMATS_LABEL} 파일을 올려 주세요.`;
  }
  if (file.size <= 0) return '빈 파일입니다.';
  if (file.size > MAX_UPLOAD_BYTES) {
    return `파일 크기가 너무 큽니다. 최대 ${MAX_UPLOAD_SIZE_LABEL}까지 업로드할 수 있습니다.`;
  }
  return null;
}

export async function uploadReferenceDocument(
  file: File,
  meta: { agentIds: string[]; title?: string; visibility?: 'organization' | 'department' },
  onStage?: (stage: DocumentUploadStage) => void
): Promise<DocumentUploadResult> {
  const local = checkReferenceFile(file);
  if (local) return { ok: false, message: local };

  // 설정이 비면 주소 발급부터 하지 않는다 — 올릴 수 없는 파일의 발급만 남는다
  if (!PUBLIC_SUPABASE_URL || !PUBLIC_SUPABASE_ANON_KEY) return { ok: false, message: MISSING_CONFIG };

  onStage?.('uploading');
  let issued: { path: string; token: string };
  try {
    const res = await postJson('/api/documents/upload-url', {
      file_name: file.name,
      size: file.size,
      file_type: file.type,
      agent_ids: meta.agentIds,
    });
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
    // 발급만 하고 올리지 못한 경로는 서버에 행이 없다 — 지울 것이 없다
    return { ok: false, message: UPLOAD_ERROR };
  }

  onStage?.('registering');
  try {
    const body: Record<string, unknown> = {
      storage_path: issued.path,
      file_name: file.name,
      file_type: file.type,
      agent_ids: meta.agentIds,
    };
    if (meta.title) body.title = meta.title;
    if (meta.visibility) body.visibility = meta.visibility;
    const res = await postJson('/api/documents/confirm', body);
    if (!res.ok) return { ok: false, message: errorMessage(res.json, '문서를 등록하지 못했습니다.') };
    return { ok: true, documentIds: res.json.data.documentIds as string[] };
  } catch {
    return { ok: false, message: NETWORK_ERROR };
  }
}

/**
 * 문서마다 읽기 라우트를 **한꺼번에** 부른다(각각 `keepalive`). 호출한 쪽은 기다리지 않는다 — 읽기는 오래 걸리고
 * `keepalive`라 화면을 떠나도 요청이 이어진다. 차례로 부르면 앞 읽기가 끝나기 전에 화면을 떠났을 때 뒤 문서의
 * 요청은 아예 나가지 않아, 목록을 열 수 없는 직원 비서의 문서가 '읽는 중'에 남는다.
 * 같은 문서를 두 번 불러도 서버의 차지가 NODA 업로드를 한 번으로 막는다.
 * 실패는 삼킨다: 읽는 중 상태는 문서 목록이 맞춰 주고 오래 멈춘 행은 목록이 다시 걸어 준다(`kick`).
 */
export function startReading(documentIds: string[], opts?: { retry?: boolean }): void {
  if (documentIds.length === 0) return;
  const body = JSON.stringify(opts?.retry ? { retry: true } : {});
  for (const id of documentIds) {
    try {
      fetch(`/api/documents/${id}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {
        // 삼킨다 — 위 설명 참고
      });
    } catch {
      // fetch가 곧바로 던져도(keepalive 본문 상한 등) 나머지 문서는 보낸다
    }
  }
}
