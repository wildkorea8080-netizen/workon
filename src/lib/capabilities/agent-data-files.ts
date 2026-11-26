// src/lib/capabilities/agent-data-files.ts
// 비서 데이터 파일(2026-11-26) — 표 합치기(table_merge)가 직원이 첨부한 표뿐 아니라 **이 비서의 문서함에 올려 둔 표 파일**
// (엑셀·CSV·한글)로도 계산한다. 기관이 예산 집행 현황·사업 실적 같은 표를 비서에 올려 두면 직원이 첨부 없이 묻고, 숫자는 표 엔진이 낸다.
//
// - 비서마다 켤 때만(능력 설정 `table_merge.agent_documents`) — 문서함에 표를 올렸다는 것만으로 열지 않는다
// - 고르는 곳은 서버가 ctx의 비서·기관으로만 — 도구 입력은 ref(d1)뿐이다(uuid·경로를 받지 않는다)
// - 지금 근거로 쓰는 판만 — 읽힌(`ready`) 문서, 지난 판·지우는 중 빼고, 시행 중인 새 판이 대신한 옛 판·시행일 전의 새 판 빼고(문서 찾기와 같은 판 규칙)
// - 문서 찾기와 같은 범위다 — 그 비서를 쓸 수 있는 사람은 문서 찾기로 그 문서의 내용을 이미 본다(문서별 공개 범위로 따로 거르지 않음)
// - 원본은 저장소에서 내려받아 첨부와 같은 읽개로 표를 읽는다(한 턴에 파일마다 한 번). 10MB까지
// - 읽은 표는 저장소에 읽어 두고(`data-extracts/{문서 id}.json`) 다음부터 그것을 쓴다. 5분 실행기가 아직 안 읽은 파일을 미리 읽어 둔다(2026-11-26)
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { MAX_ATTACHMENT_BYTES } from '@/lib/attachments/limits';
import { kstToday, notCitableEditionIds } from '@/lib/edition-dates';
import type { AttachmentExtract } from '@/lib/attachments/types';
import { gunzipSync, gzipSync } from 'zlib';

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

// ── 읽어 둔 표(2026-11-26) ─────────────────────────────────────
// 데이터 파일을 묻는 턴마다 원본을 내려받아 읽으면 큰 엑셀은 그 턴이 느리다. 한 번 읽은 표는 저장소에 gzip JSON으로 두고
// 다음부터는 그것을 쓴다. 문서 행은 판이 바뀌면 새 id라(같은 id의 원본은 바뀌지 않는다) 문서 id로 열쇠를 삼으면 낡지 않는다.
// 읽개를 바꾸면 `DATA_EXTRACT_VERSION`을 올린다 — 다른 판의 사본은 버리고 다시 읽는다.
// 다시 해도 같은 실패(10MB 초과·읽지 못하는 파일)도 적어 두어 매번 원본을 내려받지 않는다. 저장소가 잠깐 안 된 것은 적지 않는다.
// 사본은 원본과 같은 권한으로만 읽는다 — 문서 행(비서·기관·지금 판)을 먼저 확인한 뒤에만 연다. 문서를 지우면 함께 지운다.

export const DATA_EXTRACT_VERSION = 1;
export const DATA_EXTRACT_PREFIX = 'data-extracts';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 읽어 둔 표의 저장소 경로 — 서버가 문서 id(uuid)로만 만든다 */
export function dataExtractPath(documentId: string): string {
  if (!UUID_RE.test(documentId)) throw new Error('문서 id가 아닙니다.');
  return `${DATA_EXTRACT_PREFIX}/${documentId.toLowerCase()}.json`;
}

type CachedExtract = { v: number; extract?: AttachmentExtract; error?: string };

/** 읽어 둔 표의 몸 → 결과. 판이 다르거나 꼴이 틀리면 null(다시 읽는다) */
export function decodeDataExtract(bytes: Buffer): DataExtractResult | null {
  try {
    const json = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
    const parsed = JSON.parse(json.toString('utf8')) as CachedExtract;
    if (!parsed || parsed.v !== DATA_EXTRACT_VERSION) return null;
    if (typeof parsed.error === 'string' && parsed.error) return { ok: false, message: parsed.error };
    const ex = parsed.extract;
    if (!ex || typeof ex !== 'object' || !Array.isArray(ex.tables)) return null;
    return { ok: true, extract: ex };
  } catch {
    return null;
  }
}

export function encodeDataExtract(result: DataExtractResult): Buffer {
  const body: CachedExtract = result.ok ? { v: DATA_EXTRACT_VERSION, extract: result.extract } : { v: DATA_EXTRACT_VERSION, error: result.message };
  return gzipSync(Buffer.from(JSON.stringify(body), 'utf8'));
}

const bucket = () => supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET);

async function readCachedExtract(documentId: string): Promise<DataExtractResult | null> {
  try {
    const { data, error } = await bucket().download(dataExtractPath(documentId));
    if (error || !data) return null;
    return decodeDataExtract(Buffer.from(await data.arrayBuffer()));
  } catch {
    return null;
  }
}

async function writeCachedExtract(documentId: string, result: DataExtractResult): Promise<void> {
  try {
    await bucket().upload(dataExtractPath(documentId), encodeDataExtract(result), { contentType: 'application/gzip', upsert: true });
  } catch {
    // 읽어 두지 못해도 이번 답은 그대로 — 다음에 다시 읽는다
  }
}

/** 문서를 지울 때 읽어 둔 표도 — 던지지 않는다(없으면 그만) */
export async function removeDataExtracts(documentIds: string[]): Promise<void> {
  const paths = documentIds.filter((id) => UUID_RE.test(id)).map(dataExtractPath);
  if (!paths.length) return;
  try {
    const { error } = await bucket().remove(paths);
    if (error) console.error('[agent-data-files] 읽어 둔 표를 지우지 못했습니다', paths.length);
  } catch {
    console.error('[agent-data-files] 읽어 둔 표를 지우지 못했습니다', paths.length);
  }
}

/** 원본을 내려받아 표로 — 다시 해도 같은 실패면 `permanent`(읽어 둔다) */
async function readOriginal(storagePath: string, fileName: string): Promise<{ result: DataExtractResult; permanent: boolean }> {
  const { data: blob, error: dlError } = await bucket().download(storagePath);
  if (dlError || !blob) return { result: { ok: false, message: '비서 데이터 파일의 원본을 지금 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }, permanent: false };
  if (blob.size > DATA_FILE_MAX_BYTES) {
    return { result: { ok: false, message: `데이터 파일이 ${Math.round(DATA_FILE_MAX_BYTES / 1024 / 1024)}MB를 넘어 표로 계산하지 못합니다. 파일을 나눠 올려 달라고 관리자에게 전하세요.` }, permanent: true };
  }
  const bytes = Buffer.from(await blob.arrayBuffer());
  const { readAttachment, AttachmentReadError } = await import('@/lib/attachments/reader');
  try {
    // 스캔 PDF 읽기(NODA)는 쓰지 않는다 — 표 파일만 고르므로 오지 않지만, 와도 바깥으로 보내지 않는다
    const extract = await readAttachment(bytes, fileName, { parseScanned: async () => { throw new ScanSkipped(); } });
    return { result: { ok: true, extract }, permanent: true };
  } catch (e) {
    if (e instanceof AttachmentReadError) return { result: { ok: false, message: `데이터 파일을 읽지 못했습니다: ${e.message}` }, permanent: true };
    return { result: { ok: false, message: '데이터 파일을 읽지 못했습니다.' }, permanent: false };
  }
}

/**
 * 데이터 파일 하나의 표 — 경로는 ctx에 싣지 않고 서버가 문서 id·비서·기관으로 다시 찾는다(그 사이 지웠거나 판이 바뀌었으면 닫힘).
 * 읽어 둔 표가 있으면 그것을, 없으면 원본을 읽고 읽어 둔다(2026-11-26).
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
  const cached = await readCachedExtract(file.id);
  if (cached) return cached;
  const { result, permanent } = await readOriginal(row.storage_path, row.file_name);
  if (permanent) await writeCachedExtract(file.id, result);
  return result;
}

// ── 미리 읽어 두기(2026-11-26) — 5분 실행기가 아직 읽어 두지 않은 데이터 파일을 몇 개씩 ──

/** 한 차례에 읽어 둘 파일 수 — 원본 읽기가 무거워(10MB까지) 적게 */
export const DATA_PREFILL_BATCH = 2;
/** 한 차례에 살펴볼 비서 수 */
export const DATA_PREFILL_AGENTS = 5;
/** 한 차례에 쓰는 시간 상한 */
export const DATA_PREFILL_BUDGET_MS = 25_000;

export type DataPrefillAgent = { id: string; organization_id: string };
export type DataPrefillTick = { filled: number; failed: number; checked: number };

export interface DataPrefillDeps {
  /** 데이터 파일을 켠 비서(지우지 않은 것) — 못 읽으면 던진다 */
  listAgents(): Promise<DataPrefillAgent[]>;
  listFiles(organizationId: string, agentId: string): Promise<AgentDataFile[]>;
  /** 읽어 둔 표가 있는가(판이 맞는지는 읽을 때 본다) — 모르면 true(건드리지 않음) */
  hasExtract(documentId: string): Promise<boolean>;
  load(organizationId: string, agentId: string, file: AgentDataFile): Promise<DataExtractResult>;
  now(): number;
  random(): number;
}

/** 던지지 않는다. 비서를 섞어 고른다(한 비서가 매번 앞을 차지하지 않게) */
export async function prefillDataExtracts(deps: DataPrefillDeps): Promise<DataPrefillTick> {
  const tick: DataPrefillTick = { filled: 0, failed: 0, checked: 0 };
  let agents: DataPrefillAgent[];
  try { agents = await deps.listAgents(); } catch { return tick; }
  const pool = agents.filter((a) => UUID_RE.test(a.id) && UUID_RE.test(a.organization_id));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(deps.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const started = deps.now();
  const full = () => tick.filled + tick.failed >= DATA_PREFILL_BATCH || deps.now() - started > DATA_PREFILL_BUDGET_MS;
  for (const agent of pool.slice(0, DATA_PREFILL_AGENTS)) {
    if (full()) break;
    let files: AgentDataFile[];
    try { files = await deps.listFiles(agent.organization_id, agent.id); } catch { continue; }
    for (const file of files) {
      if (full()) break;
      tick.checked++;
      let has = true;
      try { has = await deps.hasExtract(file.id); } catch { has = true; }
      if (has) continue;
      const out = await deps.load(agent.organization_id, agent.id, file).catch((): DataExtractResult => ({ ok: false, message: '' }));
      if (out.ok) tick.filled++; else tick.failed++;
    }
  }
  return tick;
}

export function dataPrefillDeps(): DataPrefillDeps {
  return {
    async listAgents() {
      const { data, error } = await supabaseAdmin.from('agents').select('id, organization_id')
        .eq('capabilities->table_merge->>agent_documents', 'true').is('deleted_at', null).limit(200);
      if (error) throw error;
      return ((data ?? []) as Array<{ id: string; organization_id: string | null }>).filter((r): r is DataPrefillAgent => typeof r.organization_id === 'string');
    },
    listFiles: listAgentDataFiles,
    async hasExtract(documentId) {
      const name = `${documentId.toLowerCase()}.json`;
      const { data, error } = await bucket().list(DATA_EXTRACT_PREFIX, { search: name, limit: 1 });
      if (error) return true;
      return (data ?? []).some((o) => o.name === name);
    },
    load: loadAgentDataExtract,
    now: () => Date.now(),
    random: Math.random,
  };
}
