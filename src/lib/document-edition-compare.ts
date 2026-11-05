// src/lib/document-edition-compare.ts
// 비서 문서의 새 판과 그 판이 바꾼 옛 판을 맞대 신구 대비를 만든다(GET /api/documents/[id]/compare).
// 권한·행 확인·원본 읽기를 맡고, 대조 자체는 edition-compare.ts(순수 함수)가 한다.

import type { ActorScope } from '@/lib/agent-permissions';
import { canReadDocument } from '@/lib/document-files';
import { MAX_UPLOAD_BYTES } from '@/lib/file-types';
import { AttachmentReadError, readAttachment } from '@/lib/attachments/reader';
import { compareEditions, EditionCompareError, type EditionComparison } from '@/lib/edition-compare';

export const COMPARE_DOCUMENT_COLUMNS =
  'id, agent_id, department_id, organization_id, visibility, storage_path, file_name, title, ' +
  'replaces_id, effective_from, noda_status, retired_at, created_at';

export interface CompareDocumentRow {
  id: string;
  agent_id: string | null;
  department_id: string;
  organization_id: string | null;
  visibility: string | null;
  storage_path: string | null;
  file_name: string;
  title: string | null;
  replaces_id: string | null;
  effective_from: string | null;
  noda_status: string | null;
  retired_at: string | null;
  created_at: string | null;
}

export interface CompareDeps {
  /** 요청자 기관으로 한정해 한 행을 읽는다. 없으면 null, 조회 실패는 던진다 */
  loadRow(id: string, organizationId: string): Promise<CompareDocumentRow | null>;
  /** 저장소 원본. 없으면 null */
  download(path: string): Promise<Uint8Array | null>;
  read?: typeof readAttachment;
}

export interface EditionSide {
  id: string;
  name: string;
  effective_from: string | null;
  /** 'retired'면 지난 판 */
  status: string | null;
  created_at: string | null;
}

export type CompareOutcome =
  | { ok: true; data: { old: EditionSide; new: EditionSide; warnings: string[]; comparison: EditionComparison } }
  | { ok: false; status: number; message: string };

const fail = (status: number, message: string): CompareOutcome => ({ ok: false, status, message });

function side(row: CompareDocumentRow): EditionSide {
  return {
    id: row.id,
    name: row.title?.trim() || row.file_name,
    effective_from: row.effective_from,
    status: row.noda_status,
    created_at: row.created_at,
  };
}

/**
 * 새 판(`newId`)과 그 `replaces_id`(옛 판)를 맞댄다.
 * - 두 행 모두 요청자 기관의 행이고 요청자가 볼 수 있어야 한다(문서 목록과 같은 기준 — 안 보이면 404, 있는지도 알리지 않는다)
 * - 같은 비서의 두 판만 맞댄다
 * - 원본을 읽지 못하면 어느 판인지와 첨부 읽기의 한국어 이유를 돌려준다(422)
 */
export async function compareDocumentEditions(newId: string, actor: ActorScope, deps: CompareDeps): Promise<CompareOutcome> {
  if (!actor.organizationId) return fail(403, '소속 기관을 확인할 수 없습니다.');
  const read = deps.read ?? readAttachment;

  const next = await deps.loadRow(newId, actor.organizationId);
  if (!next || !canReadDocument(next, actor)) return fail(404, '문서를 찾을 수 없습니다.');
  if (!next.replaces_id) return fail(409, '이 문서가 바꾼 옛 판이 없어 비교할 수 없습니다.');

  const prev = await deps.loadRow(next.replaces_id, actor.organizationId);
  if (!prev || !canReadDocument(prev, actor)) return fail(404, '옛 판을 찾을 수 없습니다.');
  if (!next.agent_id || prev.agent_id !== next.agent_id) return fail(409, '같은 비서의 두 판만 비교할 수 있습니다.');
  if (!prev.storage_path || !next.storage_path) return fail(404, '원본 파일이 없어 비교할 수 없습니다.');

  const [prevBytes, nextBytes] = await Promise.all([deps.download(prev.storage_path), deps.download(next.storage_path)]);
  if (!prevBytes) return fail(404, '옛 판의 원본 파일을 찾을 수 없습니다.');
  if (!nextBytes) return fail(404, '새 판의 원본 파일을 찾을 수 없습니다.');
  if (prevBytes.byteLength > MAX_UPLOAD_BYTES || nextBytes.byteLength > MAX_UPLOAD_BYTES) {
    return fail(413, '원본 파일이 너무 커서 비교할 수 없습니다.');
  }

  const extract = async (bytes: Uint8Array, row: CompareDocumentRow, label: string) => {
    try {
      return { ok: true as const, value: await read(Buffer.from(bytes), row.file_name) };
    } catch (err) {
      if (err instanceof AttachmentReadError) return { ok: false as const, message: `${label}을 읽지 못했습니다: ${err.message}` };
      throw err;
    }
  };
  const [a, b] = await Promise.all([extract(prevBytes, prev, '옛 판'), extract(nextBytes, next, '새 판')]);
  if (!a.ok) return fail(422, a.message);
  if (!b.ok) return fail(422, b.message);

  let comparison: EditionComparison;
  try {
    comparison = compareEditions(a.value.text, b.value.text);
  } catch (err) {
    if (err instanceof EditionCompareError) return fail(422, err.message);
    throw err;
  }

  const warnings = [
    ...a.value.warnings.map((w) => `옛 판: ${w}`),
    ...b.value.warnings.map((w) => `새 판: ${w}`),
  ];
  if (comparison.truncated) warnings.unshift('문단이 많아 앞부분만 맞댔습니다 — 뒷부분은 원본에서 확인하세요');
  return { ok: true, data: { old: side(prev), new: side(next), warnings, comparison } };
}
