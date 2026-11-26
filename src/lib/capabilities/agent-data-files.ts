// src/lib/capabilities/agent-data-files.ts
// 비서 데이터 파일(2026-11-26) — 표 합치기(table_merge)가 직원이 첨부한 표뿐 아니라 **이 비서의 문서함에 올려 둔 표 파일**
// (엑셀·CSV·한글)로도 계산한다. 기관이 예산 집행 현황·사업 실적 같은 표를 비서에 올려 두면 직원이 첨부 없이 묻고, 숫자는 표 엔진이 낸다.
//
// - 비서마다 켤 때만(능력 설정 `table_merge.agent_documents`) — 문서함에 표를 올렸다는 것만으로 열지 않는다
// - 고르는 곳은 서버가 ctx의 비서·기관으로만 — 도구 입력은 ref(d1)뿐이다(uuid·경로를 받지 않는다)
// - 지금 근거로 쓰는 판만 — 읽힌(`ready`) 문서, 지난 판·지우는 중 빼고, 시행 중인 새 판이 대신한 옛 판·시행일 전의 새 판 빼고(문서 찾기와 같은 판 규칙)
// - 문서 찾기와 같은 범위다 — 그 비서를 쓸 수 있는 사람은 문서 찾기로 그 문서의 내용을 이미 본다(문서별 공개 범위로 따로 거르지 않음)
// - 원본은 저장소에서 내려받아 첨부와 같은 읽개로 표를 읽는다(한 턴에 파일마다 한 번). 10MB까지
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { MAX_ATTACHMENT_BYTES } from '@/lib/attachments/limits';
import { kstToday, notCitableEditionIds } from '@/lib/edition-dates';
import type { AttachmentExtract } from '@/lib/attachments/types';

/** 표를 읽을 수 있는 원본 형식 — 첨부 읽개가 표를 뽑는 것만(PDF·워드·파워포인트는 표 계산에 쓰지 않는다) */
export const DATA_FILE_EXTENSIONS = ['xlsx', 'xlsm', 'csv', 'hwpx', 'hwp'] as const;
/** 한 턴에 보일 데이터 파일 수 — 프롬프트에는 이름만 싣지만 끝없이 늘지 않게 */
export const MAX_DATA_FILES = 20;
/** 내려받아 읽을 원본 크기 상한 — 첨부 한 개 상한과 같다(함수 메모리) */
export const DATA_FILE_MAX_BYTES = MAX_ATTACHMENT_BYTES;
/** 후보로 읽을 문서 행 상한 */
const ROW_LIMIT = 1000;

export interface AgentDataFile {
  /** 'd1'… 올린 순서(만든 때, 같으면 id) — 파일이 그대로면 턴이 바뀌어도 같은 ref */
  ref: string;
  id: string;
  fileName: string;
  /** 문서 제목(있으면) */
  title: string | null;
}

export interface DataFileRow {
  id: string;
  title: string | null;
  file_name: string;
  storage_path: string | null;
  noda_status: string | null;
  replaces_id?: string | null;
  effective_from?: string | null;
  retired_at?: string | null;
  created_at: string;
}

export function isDataFileName(fileName: string): boolean {
  const ext = (fileName.toLowerCase().split('.').pop() ?? '').trim();
  return (DATA_FILE_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * 후보 문서 행 → 이번 턴의 데이터 파일. 판 규칙은 문서 찾기와 같은 `notCitableEditionIds`(오늘 KST).
 * 순서는 만든 때·id — ref가 턴마다 바뀌지 않게
 */
export function pickDataFiles(rows: DataFileRow[], today: string = kstToday()): AgentDataFile[] {
  const notCitable = notCitableEditionIds(rows, today);
  return rows
    .filter((r) => r.noda_status === 'ready' && !r.retired_at && typeof r.storage_path === 'string' && r.storage_path)
    .filter((r) => !notCitable.has(r.id.toLowerCase()))
    .filter((r) => isDataFileName(r.file_name))
    .sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1))
    .slice(0, MAX_DATA_FILES)
    .map((r, i) => ({ ref: `d${i + 1}`, id: r.id, fileName: r.file_name, title: r.title?.trim() || null }));
}

/** 이 비서의 데이터 파일 — 못 읽으면 던진다(부르는 쪽이 '지금 불러오지 못함'으로 알린다) */
export async function listAgentDataFiles(organizationId: string, agentId: string): Promise<AgentDataFile[]> {
  const { data, error } = await supabaseAdmin
    .from('documents')
    .select('id, title, file_name, storage_path, noda_status, replaces_id, effective_from, retired_at, created_at')
    .eq('agent_id', agentId)
    .eq('organization_id', organizationId)
    .order('created_at')
    .order('id')
    .limit(ROW_LIMIT);
  if (error) throw error;
  return pickDataFiles((data ?? []) as DataFileRow[]);
}

export type DataExtractResult = { ok: true; extract: AttachmentExtract } | { ok: false; message: string };

class ScanSkipped extends Error {}

/**
 * 데이터 파일 하나의 표 — 경로는 ctx에 싣지 않고 서버가 문서 id·비서·기관으로 다시 찾는다(그 사이 지웠거나 판이 바뀌었으면 닫힘).
 * 던지지 않는다 — 실패는 모델이 직원에게 전할 한국어 한 줄(원문·경로 없음)
 */
export async function loadAgentDataExtract(organizationId: string, agentId: string, file: AgentDataFile): Promise<DataExtractResult> {
  const { data, error } = await supabaseAdmin
    .from('documents')
    .select('storage_path, file_name, noda_status, retired_at')
    .eq('id', file.id)
    .eq('agent_id', agentId)
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) return { ok: false, message: '비서 데이터 파일을 지금 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  const row = data as { storage_path: string | null; file_name: string; noda_status: string | null; retired_at: string | null } | null;
  if (!row || !row.storage_path || row.noda_status !== 'ready' || row.retired_at) {
    return { ok: false, message: '그 데이터 파일은 지금 쓸 수 없습니다(지웠거나 새 판으로 바뀌었습니다).' };
  }
  const { data: blob, error: dlError } = await supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET).download(row.storage_path);
  if (dlError || !blob) return { ok: false, message: '비서 데이터 파일의 원본을 지금 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  if (blob.size > DATA_FILE_MAX_BYTES) {
    return { ok: false, message: `데이터 파일이 ${Math.round(DATA_FILE_MAX_BYTES / 1024 / 1024)}MB를 넘어 표로 계산하지 못합니다. 파일을 나눠 올려 달라고 관리자에게 전하세요.` };
  }
  const bytes = Buffer.from(await blob.arrayBuffer());
  const { readAttachment, AttachmentReadError } = await import('@/lib/attachments/reader');
  try {
    // 스캔 PDF 읽기(NODA)는 쓰지 않는다 — 표 파일만 고르므로 오지 않지만, 와도 바깥으로 보내지 않는다
    const extract = await readAttachment(bytes, row.file_name, { parseScanned: async () => { throw new ScanSkipped(); } });
    return { ok: true, extract };
  } catch (e) {
    if (e instanceof AttachmentReadError) return { ok: false, message: `데이터 파일을 읽지 못했습니다: ${e.message}` };
    return { ok: false, message: '데이터 파일을 읽지 못했습니다.' };
  }
}
