import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  UPLOAD_FORMATS_LABEL,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_SIZE_LABEL,
  MAX_AGENT_DOCUMENTS,
  hasAllowedUploadExtension,
} from '@/lib/file-types';
import { canEditAgent, type ActorScope, type AgentAccessInfo } from '@/lib/agent-permissions';
import { loadAgentAccess } from '@/lib/agent-store';
import { nodaFilename } from '@/lib/noda';
import { startReadingFields } from '@/lib/document-reading';

/**
 * 참고 문서 직접 올리기의 검사와 행 만들기 (S4-a).
 *
 * 브라우저가 원본을 저장소에 직접 올리므로(Vercel 요청 본문 상한 4.5MB) 같은 검사를
 * 주소 발급과 확인 두 곳에서 한다. 예전 `/api/upload`에 있던 검사를 그대로 옮겼다 —
 * 크기·개수 상한은 file-types.ts 한 곳에 있다.
 *
 * 스캔 판독(Anthropic)은 이 경로에 없다. 읽기는 NODA가 한다.
 */

/** 서명 주소 발급 뒤 확인을 받는 시간. 서명 주소는 2시간 살아 있어 짧게 끊는다 */
export const DOCUMENT_CONFIRM_WINDOW_MS = 600_000;

const DANGEROUS_FILENAME_PATTERNS = [
  /\.\./, // 디렉토리 트래버설
  /^[.-]/, // 점이나 대시로 시작
  /[<>:"|?*]/, // Windows 예약 문자
  /\s+$/, // 끝에 공백
  // eslint-disable-next-line no-control-regex
  /[\x00-\x1f\x7f-\x9f]/, // 제어 문자
];

const BLOCKED_EXTENSIONS = [
  'exe', 'bat', 'cmd', 'com', 'pif', 'scr', 'vbs', 'js', 'jar',
  'php', 'asp', 'jsp', 'cgi', 'pl', 'py', 'sh', 'dll', 'so',
];

export type UploadFileCheck =
  | { ok: true; ext: string }
  | {
      ok: false;
      status: 400 | 413 | 415;
      message: string;
      securityReason?: 'dangerous_filename' | 'blocked_extension';
      /** 보안 기록에 남길 자세한 값(패턴·확장자) */
      securityDetail?: Record<string, string>;
    };

/** 파일 이름·크기·형식 검사. 순서와 문구는 예전 업로드 라우트와 같다 */
export function checkUploadFile(input: { fileName: string; size: number; mimeType: string }): UploadFileCheck {
  const { fileName, size, mimeType } = input;
  if (typeof fileName !== 'string' || fileName.length === 0) {
    return { ok: false, status: 400, message: '유효하지 않은 파일명입니다.' };
  }
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
    return { ok: false, status: 400, message: '파일 크기가 올바르지 않습니다.' };
  }

  if (!hasAllowedUploadExtension(fileName) && !(ALLOWED_UPLOAD_MIME_TYPES as readonly string[]).includes(mimeType)) {
    return {
      ok: false,
      status: 415,
      message: `지원되지 않는 파일 형식입니다. ${UPLOAD_FORMATS_LABEL}만 허용됩니다.`,
    };
  }

  if (size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      status: 413,
      message: `파일 크기가 너무 큽니다. 최대 ${MAX_UPLOAD_SIZE_LABEL}까지 업로드할 수 있습니다.`,
    };
  }

  for (const pattern of DANGEROUS_FILENAME_PATTERNS) {
    if (pattern.test(fileName)) {
      return {
        ok: false,
        status: 400,
        message: '유효하지 않은 파일명입니다.',
        securityReason: 'dangerous_filename',
        securityDetail: { pattern: pattern.source },
      };
    }
  }

  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (BLOCKED_EXTENSIONS.includes(ext)) {
    return {
      ok: false,
      status: 415,
      message: '이 파일 형식은 보안상 허용되지 않습니다.',
      securityReason: 'blocked_extension',
      securityDetail: { extension: ext },
    };
  }
  return { ok: true, ext };
}

// ── 저장소 경로 ─────────────────────────────────────────────

const SEGMENT = /^[A-Za-z0-9-]{1,64}$/;
const PATH_RE = /^documents\/([A-Za-z0-9-]{1,64})\/([A-Za-z0-9-]{1,64})\/(\d{1,16})-([A-Za-z0-9-]{1,64})\.([a-z0-9]{1,8})$/;

/**
 * `documents/{부서}/{사용자}/{발급시각}-{id}.{확장자}` — 파일 이름은 경로에 넣지 않는다(한글·특수문자).
 * 확인이 부서·사용자·발급 시각을 경로에서 다시 읽어 요청자 것인지, 10분 안인지 판정한다.
 */
export function documentStoragePath(input: { departmentId: string; userId: string; ext: string; now: number; id: string }): string {
  const { departmentId, userId, ext, now, id } = input;
  for (const s of [departmentId, userId, id]) {
    if (!SEGMENT.test(s)) throw new Error('잘못된 경로 조각');
  }
  if (!/^[a-z0-9]{1,8}$/.test(ext)) throw new Error('잘못된 확장자');
  if (!Number.isInteger(now) || now < 0) throw new Error('잘못된 발급 시각');
  return `documents/${departmentId}/${userId}/${now}-${id}.${ext}`;
}

/** 이 모양이 아니면(옛 경로·거슬러 올라가는 조각 포함) null */
export function parseDocumentStoragePath(
  path: string,
): { departmentId: string; userId: string; issuedAt: number; ext: string } | null {
  if (typeof path !== 'string') return null;
  const m = PATH_RE.exec(path);
  if (!m) return null;
  const issuedAt = Number(m[3]);
  if (!Number.isSafeInteger(issuedAt)) return null;
  return { departmentId: m[1], userId: m[2], issuedAt, ext: m[5] };
}

// ── 대상 비서 ───────────────────────────────────────────────

export type UploadTargets =
  | { ok: true; agentIds: string[]; targets: Map<string, AgentAccessInfo> }
  | { ok: false; status: number; message: string };

/**
 * 고른 비서 전부를 검사한다 — 중복 제거 · 권한(canEditAgent) · 비서당 개수.
 *
 * 예전에는 첫 번째만 검사해, 내 비서를 앞에 두고 남의 비서를 뒤에 붙이면 권한 없이 문서가 붙었다.
 * 개수는 `deleting` 행도 센다(NODA에서 아직 지우는 중이라 자리를 차지한다).
 */
export async function checkUploadTargets(agentIdsInput: unknown, actor: ActorScope): Promise<UploadTargets> {
  if (!Array.isArray(agentIdsInput) || agentIdsInput.length === 0) {
    return { ok: false, status: 400, message: '에이전트를 하나 이상 선택해주세요.' };
  }
  if (!agentIdsInput.every((v) => typeof v === 'string' && v.length > 0)) {
    return { ok: false, status: 400, message: '에이전트 목록이 올바르지 않습니다.' };
  }
  // 같은 id가 두 번 오면 문서 행이 둘 생기고 상한 검사도 한 번만 센다. 한 번 걸러 모든 검사가 같은 목록을 쓴다
  const agentIds: string[] = [...new Set(agentIdsInput as string[])];

  // 읽은 비서 정보는 행을 만들 때 다시 쓴다(공개 범위를 비서 단계에 맞춘다)
  const targets = new Map<string, AgentAccessInfo>();
  for (const id of agentIds) {
    const target = await loadAgentAccess(id);
    if (!target || !canEditAgent(target, actor)) {
      return { ok: false, status: 403, message: '문서를 붙일 권한이 없는 비서가 포함돼 있습니다.' };
    }
    targets.set(id, target);
  }

  // 비서당 문서 수 상한. 문서는 비서마다 한 행씩 들어가므로 선택한 비서 전부를 본다.
  // 화면 검사는 표시일 뿐이고 서버가 판정한다.
  const { data: existing, error: countError } = await supabaseAdmin
    .from('documents')
    .select('agent_id')
    .in('agent_id', agentIds);

  const perAgent = new Map<string, number>();
  for (const row of existing ?? []) {
    const id = (row as { agent_id: string }).agent_id;
    perAgent.set(id, (perAgent.get(id) ?? 0) + 1);
  }
  const full = agentIds.filter((id) => (perAgent.get(id) ?? 0) >= MAX_AGENT_DOCUMENTS);

  // 세는 데 실패하면 막지 않는다. 집계 오류로 업로드가 멈추면 담당자는 원인을 알 수 없다
  if (!countError && full.length > 0) {
    return {
      ok: false,
      status: 400,
      message: `비서 하나에는 문서를 ${MAX_AGENT_DOCUMENTS}개까지 연결할 수 있습니다. 쓰지 않는 문서를 지운 뒤 다시 시도해주세요.`,
    };
  }

  return { ok: true, agentIds, targets };
}

// ── 새 문서 행 ──────────────────────────────────────────────

/**
 * 확인이 넣을 행. 비서마다 한 행이고 행마다 id와 NODA 파일 이름이 다르다(`{id}__{원래 이름}`).
 *
 * 부서·나만의 비서에 올린 문서는 그 비서의 부서 안에 둔다 — 올리는 사람이 '기관 전체'를 골라도
 * 따르지 않는다(문서 목록과 검색은 비서 단계가 아니라 visibility로 거른다).
 * **모든 행의 키 집합이 같다** — 다르면 PostgREST 배치 insert가 빠진 칸에 NULL을 넣는다(CLAUDE.md).
 * organization_id는 트리거(0016)가 채운다. 읽기는 NODA가 하므로 summary·metadata·embedding은 비운다.
 */
export function buildNewDocumentRows(input: {
  ids: string[];
  agentIds: string[];
  targets: Map<string, AgentAccessInfo>;
  departmentId: string;
  userId: string;
  storagePath: string;
  fileName: string;
  fileType: string | null;
  title: string;
  visibility: 'organization' | 'department';
  now: Date;
}): Record<string, unknown>[] {
  if (input.ids.length !== input.agentIds.length) throw new Error('문서 id와 비서 수가 다릅니다');
  return input.agentIds.map((agentId, i) => {
    const target = input.targets.get(agentId);
    if (!target) throw new Error('대상 비서 정보가 없습니다');
    const official = target.tier === 'official';
    const id = input.ids[i];
    return {
      id,
      department_id: official ? input.departmentId : target.department_id,
      visibility: official ? input.visibility : 'department',
      uploaded_by: input.userId,
      agent_id: agentId,
      storage_path: input.storagePath,
      file_name: input.fileName,
      file_type: input.fileType,
      title: input.title,
      summary: null,
      metadata: {},
      embedding: null,
      noda_filename: nodaFilename(id, input.fileName),
      ...startReadingFields(input.now),
    };
  });
}
