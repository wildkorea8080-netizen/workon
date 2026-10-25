/**
 * 화면용 공통 문서 올리기(운영자, S5) — ① 주소 발급 → ② 저장소에 직접 올리기 → ③ 확인(서버가 문서 행을 만든다) → ④ 읽기 걸기.
 * `document-upload-client.ts`와 같은 꼴이다. 읽기는 NODA가 하고 오래 걸려 `keepalive`로 걸고 기다리지 않는다.
 *
 * 여기 검사(형식·크기)는 표시일 뿐이고 서버가 다시 본다. 화면 코드이므로 config.ts를 가져오지 않는다(config-public-guard.test.ts).
 */
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config-public';
import { storageClient } from '@/lib/browser-storage';
import { checkReferenceFile } from '@/lib/document-upload-client';
import type { OrgType } from '@/lib/org-types';

export type CommonUploadStage = 'uploading' | 'registering';
export type CommonUploadResult = { ok: true; id: string } | { ok: false; message: string };

export interface CommonUploadMeta {
  org_type: OrgType;
  title: string;
  edition_year: number;
  usage_terms: string;
  /** 바꿀 옛 판(같은 유형의 현재 판). 없으면 새 문서 */
  replaces_id?: string;
}

const BASE = '/api/super/common-documents';
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

/** 공통 문서마다 읽기 라우트를 한꺼번에 건다(각각 `keepalive`). 기다리지 않고 실패는 삼킨다 — 목록이 상태를 맞춘다 */
export function startCommonReading(ids: string[], opts?: { retry?: boolean }): void {
  if (ids.length === 0) return;
  const body = JSON.stringify(opts?.retry ? { retry: true } : {});
  for (const id of ids) {
    try {
      fetch(`${BASE}/${id}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {
        // 삼킨다 — 읽는 중 상태는 문서 목록이 맞춰 주고 오래 멈춘 행은 목록이 다시 걸어 준다(`kick`)
      });
    } catch {
      // fetch가 곧바로 던져도 나머지 문서는 보낸다
    }
  }
}

export async function uploadCommonDocument(
  file: File,
  meta: CommonUploadMeta,
  onStage?: (stage: CommonUploadStage) => void
): Promise<CommonUploadResult> {
  const local = checkReferenceFile(file);
  if (local) return { ok: false, message: local };

  // 설정이 비면 주소 발급부터 하지 않는다 — 올릴 수 없는 파일의 발급만 남는다
  if (!PUBLIC_SUPABASE_URL || !PUBLIC_SUPABASE_ANON_KEY) return { ok: false, message: MISSING_CONFIG };

  onStage?.('uploading');
  let issued: { path: string; token: string };
  try {
    const res = await postJson(`${BASE}/upload-url`, {
      file_name: file.name,
      size: file.size,
      file_type: file.type,
      org_type: meta.org_type,
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
  let id: string;
  try {
    const body: Record<string, unknown> = {
      storage_path: issued.path,
      file_name: file.name,
      file_type: file.type,
      org_type: meta.org_type,
      title: meta.title,
      edition_year: meta.edition_year,
      usage_terms: meta.usage_terms,
    };
    if (meta.replaces_id) body.replaces_id = meta.replaces_id;
    const res = await postJson(BASE, body);
    if (!res.ok) return { ok: false, message: errorMessage(res.json, '문서를 등록하지 못했습니다.') };
    id = res.json.data.id as string;
  } catch {
    return { ok: false, message: NETWORK_ERROR };
  }

  // 읽기는 기다리지 않고 건다 — 목록이 '읽는 중'을 보여 주고 다 읽으면 바뀐다
  startCommonReading([id]);
  return { ok: true, id };
}
