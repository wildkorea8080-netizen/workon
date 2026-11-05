// src/lib/apps/library-documents.ts
// 입력형 앱의 '문서함에서 고르기'(2026-11-05) — 직원이 그 앱(비서)에 올려 둔 참고 문서를 골라 원자료로 쓴다.
// 알리웍스 답변형 앱의 '문서(지식베이스 문서 선택)' 입력 꼴. 고른 문서는 원본을 첨부와 같은 읽기(readAttachment)로 읽어
// 첨부 원자료와 같은 자리에 넣는다(긴 자료는 맵-리듀스로 추린다 — long-input.ts).
//
// 지키는 것
// - 그 앱 비서의 문서만. 요청자가 문서 목록에서 볼 수 있어야 한다(canReadDocument). 기관 밖·다른 비서 문서는 없는 것처럼 거절.
// - 근거로 쓰는 판만: 읽힌(`ready`) 현재 판이고, 판·시행일 규칙(notCitableEditionIds — 오늘 기준)으로 근거가 아닌 판은 고를 수 없다.
//   지난 판·시행일 전인 새 판·읽는 중·실패한 문서는 목록에도 없고 보내도 거절한다.
// - 서버가 다시 본다. 화면 목록은 표시일 뿐이다.
import type { ActorScope } from '@/lib/agent-permissions';
import { canReadDocument } from '@/lib/document-files';
import { kstToday, notCitableEditionIds } from '@/lib/edition-dates';
import { MAX_UPLOAD_BYTES } from '@/lib/file-types';
import { AttachmentReadError, readAttachment } from '@/lib/attachments/reader';
import type { AttachmentExtract } from '@/lib/attachments/types';

export const LIBRARY_DOCUMENT_COLUMNS =
  'id, agent_id, department_id, organization_id, visibility, storage_path, file_name, file_type, title, noda_status, replaces_id, effective_from, retired_at';

export interface LibraryDocumentRow {
  id: string;
  agent_id: string | null;
  department_id: string;
  organization_id: string | null;
  visibility: string | null;
  storage_path: string | null;
  file_name: string;
  file_type: string | null;
  title: string | null;
  noda_status: string | null;
  replaces_id?: string | null;
  effective_from?: string | null;
  retired_at?: string | null;
}

/** 화면 목록 한 줄 — 저장소 경로는 싣지 않는다 */
export interface LibraryDocumentOption {
  id: string;
  title: string;
  file_type: string | null;
  effective_from: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 고를 수 있는 문서 — 이 비서의 `ready` 현재 판이고 요청자가 볼 수 있으며 판·시행일 규칙으로 근거인 것 */
export function selectableLibraryDocuments(rows: LibraryDocumentRow[], agentId: string, actor: ActorScope, today: string = kstToday()): LibraryDocumentRow[] {
  const mine = rows.filter((r) => r.agent_id === agentId);
  const notCitable = notCitableEditionIds(mine, today);
  return mine.filter(
    (r) => r.noda_status === 'ready' && !r.retired_at && !notCitable.has(r.id.toLowerCase()) && canReadDocument(r, actor) && !!r.storage_path
  );
}

export function libraryOption(row: LibraryDocumentRow): LibraryDocumentOption {
  return { id: row.id, title: row.title?.trim() || row.file_name, file_type: row.file_type, effective_from: row.effective_from ?? null };
}

/** 요청 값 검사 — 없으면 빈 배열, 꼴이 틀리면 null(400) */
export function parseLibraryIds(raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string' || !UUID.test(v))) return null;
  const ids = [...new Set((raw as string[]).map((v) => v.toLowerCase()))];
  return ids.length === raw.length ? ids : null;
}

export interface LibraryDeps {
  /** 이 비서의 문서 행(요청자 기관으로 한정해 읽는다) */
  documentsOf(agentId: string, organizationId: string): Promise<LibraryDocumentRow[]>;
  download(path: string): Promise<Uint8Array | null>;
  read?: typeof readAttachment;
}

export type LibraryLoad =
  | { ok: true; files: { name: string; extract: AttachmentExtract }[]; refs: { id: string; title: string }[] }
  | { ok: false; status: number; message: string };

/**
 * 고른 문서를 읽는다 — 하나라도 고를 수 없는 문서면 아무것도 읽지 않고 거절한다.
 * 원본이 없거나 너무 크거나 읽지 못하면 그 문서 이름과 함께 거절한다(조용히 빼지 않는다)
 */
export async function loadLibraryDocuments(ids: string[], agentId: string, actor: ActorScope, deps: LibraryDeps): Promise<LibraryLoad> {
  if (!ids.length) return { ok: true, files: [], refs: [] };
  if (!actor.organizationId) return { ok: false, status: 403, message: '소속 기관을 확인할 수 없습니다.' };
  const rows = await deps.documentsOf(agentId, actor.organizationId);
  const selectable = new Map(selectableLibraryDocuments(rows, agentId, actor).map((r) => [r.id.toLowerCase(), r]));
  const chosen = ids.map((id) => selectable.get(id));
  if (chosen.some((r) => !r)) return { ok: false, status: 400, message: '고를 수 없는 문서가 있습니다. 문서 목록을 새로 열어 다시 골라 주세요.' };

  const read = deps.read ?? readAttachment;
  const files: { name: string; extract: AttachmentExtract }[] = [];
  for (const row of chosen as LibraryDocumentRow[]) {
    const name = row.title?.trim() || row.file_name;
    const bytes = await deps.download(row.storage_path!);
    if (!bytes) return { ok: false, status: 404, message: `${name}: 원본 파일을 찾을 수 없습니다.` };
    if (bytes.byteLength > MAX_UPLOAD_BYTES) return { ok: false, status: 413, message: `${name}: 원본 파일이 너무 커서 읽을 수 없습니다.` };
    try {
      files.push({ name, extract: await read(Buffer.from(bytes), row.file_name) });
    } catch (err) {
      if (err instanceof AttachmentReadError) return { ok: false, status: 400, message: `${name}: ${err.message}` };
      throw err;
    }
  }
  return { ok: true, files, refs: (chosen as LibraryDocumentRow[]).map((r) => ({ id: r.id, title: r.title?.trim() || r.file_name })) };
}

/**
 * 예약 실행(0062)이 저장한 문서 → 지금 쓸 판. 저장한 문서에 새 판이 나와 근거가 되면(바꿀 옛 판 `replaces_id`로 이어짐) 새 판을 쓴다.
 * 판 사슬을 앞으로 따라가며 **근거로 쓸 수 있는 마지막 판**을 고른다 — 새 판이 아직 읽는 중이거나 시행일 전이면 옛 판 그대로.
 * 사슬 어디에도 쓸 판이 없으면(지움·읽기 실패·지난 판만) 실패. 볼 수 있는지(canReadDocument)는 실행(prepare)이 요청자로 다시 본다
 */
export function currentEditionIds(
  storedIds: string[],
  rows: LibraryDocumentRow[],
  agentId: string,
  today: string = kstToday()
): { ok: true; ids: string[]; changed: boolean } | { ok: false; missing: string[] } {
  const mine = rows.filter((r) => r.agent_id === agentId);
  const notCitable = notCitableEditionIds(mine, today);
  const usable = (r: LibraryDocumentRow) => r.noda_status === 'ready' && !r.retired_at && !notCitable.has(r.id.toLowerCase()) && !!r.storage_path;
  const byId = new Map(mine.map((r) => [r.id.toLowerCase(), r]));
  const successor = new Map<string, LibraryDocumentRow>();
  for (const r of mine) if (r.replaces_id) successor.set(r.replaces_id.toLowerCase(), r);

  const ids: string[] = [];
  const missing: string[] = [];
  for (const stored of storedIds) {
    let cur = stored.toLowerCase();
    let pick: string | null = byId.get(cur) && usable(byId.get(cur)!) ? cur : null;
    const seen = new Set([cur]);
    for (let next = successor.get(cur); next && !seen.has(next.id.toLowerCase()); next = successor.get(cur)) {
      cur = next.id.toLowerCase();
      seen.add(cur);
      if (usable(next)) pick = cur;
    }
    if (!pick) missing.push(stored);
    else if (!ids.includes(pick)) ids.push(pick);
  }
  if (missing.length) return { ok: false, missing };
  const changed = ids.length !== storedIds.length || ids.some((id, i) => id !== storedIds[i].toLowerCase());
  return { ok: true, ids, changed };
}
