import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { logSystem } from '@/lib/logger';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_SIZE_LABEL } from '@/lib/file-types';
import { noda, nodaFilename, nodaTenant, NodaError, type NodaClient, type NodaListing } from '@/lib/noda';
import type { NodaStatus } from '@/lib/db';

/**
 * 참고 문서의 NODA 읽기 상태 전이 (S4-a, 설계 4절).
 *
 * NODA 업로드는 읽기를 끝내고 응답하므로 Vercel 함수 안에서 끝까지 기다리다 끊길 수 있다.
 * 그래서 documents 행이 `reading`으로 시작하고, 아래 셋이 `ready`·`failed`로 끝낸다.
 *
 *   readDocument     — Supabase 원본을 NODA로 보낸다(차지로 중복을 막는다)
 *   reconcileReading — 문서 목록을 열 때 NODA `GET /documents`와 맞춘다(끝났는지·안 왔는지)
 *   decideReadState  — 맞추기의 판정(순수 함수)
 *
 * 모든 DB·저장소·NODA·시계 접근은 `ReadingDeps`를 거친다 — 테스트가 가짜로 바꾼다.
 *
 * 시계 둘 (0031 머리 주석 참고):
 *   noda_read_started_at — 이번 읽기 시작. 10분 포기 판정
 *   noda_last_attempt_at — NODA에 보낸 마지막 때. 2분 다시 걸기 판정과 중복 차지
 */

export const READ_KICK_AFTER_MS = 120_000;
export const READ_GIVE_UP_MS = 600_000;
export const READ_TIMEOUT_REASON = '읽기가 너무 오래 걸려 멈췄습니다. 다시 시도해 주세요.';
/** 한 번의 맞추기가 NODA 목록을 부르는 보관함 수 — 문서 목록 응답이 느려지지 않게 */
export const MAX_TENANTS_PER_RECONCILE = 5;
/** NODA가 알려 준 읽지 못한 이유를 저장하는 길이 */
const MAX_REASON_CHARS = 200;
const UNREADABLE_DEFAULT_REASON = '이 문서를 읽을 수 없습니다.';

export interface ReadingRow {
  id: string;
  agent_id: string | null;
  noda_status: NodaStatus | null;
  noda_filename: string | null;
  noda_read_started_at: string | null;
  noda_last_attempt_at: string | null;
  created_at: string;
}

/** `readDocument`가 저장소에서 읽는 행 */
export interface StoredDocument extends ReadingRow {
  storage_path: string;
  file_name: string;
  noda_reason: string | null;
  noda_doc_id: string | null;
  noda_read_at: string | null;
}

/** `finish`가 쓰는 칸 — 읽기를 끝내는 갱신 */
export interface FinishPatch {
  noda_status: 'ready' | 'unreadable' | 'failed';
  noda_reason?: string | null;
  noda_doc_id?: string | null;
  noda_read_at?: string | null;
}

/** 모든 갱신은 한 문서에 대한 조건부 갱신이고, 바뀐 행이 있었는지를 돌려준다 */
export interface ReadingStore {
  getRow(id: string): Promise<StoredDocument | null>;
  /** `failed` → `reading` (다시 시도). 바뀌었으면 true */
  restart(id: string, fields: ReturnType<typeof startReadingFields>): Promise<boolean>;
  /**
   * 차지: `reading`이고 마지막 시도가 없거나 `cutoffIso`보다 오래됐을 때만 마지막 시도를 `nowIso`로 바꾼다.
   * 두 호출이 겹쳐도 하나만 true — NODA 업로드가 한 번만 나가게 한다
   */
  claim(id: string, nowIso: string, cutoffIso: string): Promise<boolean>;
  /** `reading`인 행만 끝낸다. 그 사이 지워졌거나(`deleting`) 다른 경로가 끝냈으면 false */
  finish(id: string, patch: FinishPatch): Promise<boolean>;
  /** 저장소 원본. 없거나 못 읽으면 null */
  download(path: string): Promise<Uint8Array | null>;
}

export interface ReadingDeps {
  store: ReadingStore;
  noda: Pick<NodaClient, 'uploadDocument' | 'listDocuments' | 'deleteDocument'>;
  now: () => number;
  log: (p: Parameters<typeof logSystem>[0]) => Promise<void>;
}

const READ_COLUMNS =
  'id, agent_id, storage_path, file_name, noda_status, noda_reason, noda_filename, noda_doc_id, ' +
  'noda_read_started_at, noda_last_attempt_at, noda_read_at, created_at';

function defaultStore(): ReadingStore {
  return {
    async getRow(id) {
      const { data, error } = await supabaseAdmin.from('documents').select(READ_COLUMNS).eq('id', id).maybeSingle();
      if (error) throw new Error(`문서 조회 실패: ${error.message}`);
      return (data as unknown as StoredDocument | null) ?? null;
    },
    async restart(id, fields) {
      const { data, error } = await supabaseAdmin
        .from('documents')
        .update(fields)
        .eq('id', id)
        .eq('noda_status', 'failed')
        .select('id');
      if (error) throw new Error(`문서 읽기 다시 시작 실패: ${error.message}`);
      return (data?.length ?? 0) > 0;
    },
    async claim(id, nowIso, cutoffIso) {
      const { data, error } = await supabaseAdmin
        .from('documents')
        .update({ noda_last_attempt_at: nowIso })
        .eq('id', id)
        .eq('noda_status', 'reading')
        .or(`noda_last_attempt_at.is.null,noda_last_attempt_at.lt.${cutoffIso}`)
        .select('id');
      if (error) throw new Error(`문서 읽기 차지 실패: ${error.message}`);
      return (data?.length ?? 0) > 0;
    },
    async finish(id, patch) {
      const { data, error } = await supabaseAdmin
        .from('documents')
        .update(patch)
        .eq('id', id)
        .eq('noda_status', 'reading')
        .select('id');
      if (error) throw new Error(`문서 읽기 결과 저장 실패: ${error.message}`);
      return (data?.length ?? 0) > 0;
    },
    async download(path) {
      try {
        const { data, error } = await supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET).download(path);
        if (error || !data) return null;
        return new Uint8Array(await data.arrayBuffer());
      } catch {
        return null;
      }
    },
  };
}

export function defaultReadingDeps(): ReadingDeps {
  return { store: defaultStore(), noda, now: () => Date.now(), log: logSystem };
}

/** 읽기를 (다시) 시작하는 행 칸. 확인 라우트와 '다시 시도'가 같은 값을 쓴다 */
export function startReadingFields(now: Date): {
  noda_status: 'reading';
  noda_read_started_at: string;
  noda_last_attempt_at: null;
  noda_reason: null;
} {
  return {
    noda_status: 'reading',
    noda_read_started_at: now.toISOString(),
    noda_last_attempt_at: null,
    noda_reason: null,
  };
}

export type ReadDecision = 'ready' | 'reading' | 'kick' | 'give_up';

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** 이번 읽기 시작 시각(없으면 만든 때) */
function startedAt(row: ReadingRow): number {
  return ms(row.noda_read_started_at) ?? ms(row.created_at) ?? 0;
}

/**
 * 읽는 중인 행이 지금 어떤 상태인지 NODA 목록으로 가른다.
 *
 * 순서가 중요하다: **`receiving`을 먼저 본다** — 같은 이름을 바꿔 넣는 중이면 옛 판은 `documents`에,
 * 새 판은 `receiving`에 함께 있어서 `documents`부터 보면 아직 읽는 중인 문서를 ready로 잘못 본다.
 * 둘 다 없고 10분이 지났으면 포기, 마지막 시도가 2분 지났으면 다시 걸기(kick).
 */
export function decideReadState(row: ReadingRow, listing: NodaListing, now: number): ReadDecision {
  const name = row.noda_filename;
  if (name && listing.receiving.some((r) => r.filename === name)) return 'reading';
  if (name && listing.documents.some((d) => d.filename === name)) return 'ready';
  if (now - startedAt(row) > READ_GIVE_UP_MS) return 'give_up';
  const lastTry = ms(row.noda_last_attempt_at) ?? startedAt(row);
  if (now - lastTry > READ_KICK_AFTER_MS) return 'kick';
  return 'reading';
}

export type ReadOutcome = { status: NodaStatus | 'not_found' | 'busy'; reason?: string | null };

/** 파일 이름·본문은 남기지 않는다 — 문서 id와 오류 종류만 */
async function logNodaError(deps: ReadingDeps, err: unknown, documentId?: string): Promise<void> {
  const nodaErr = err instanceof NodaError ? err : null;
  await deps.log({
    level: 'warning',
    category: 'api',
    message: 'NODA 문서 읽기 호출 실패',
    details: {
      ...(documentId ? { document_id: documentId } : {}),
      code: nodaErr?.code ?? 'unknown',
      status: nodaErr?.status ?? null,
    },
  });
}

/**
 * 한 문서를 NODA로 읽힌다 — Supabase 원본을 서버끼리 보낸다.
 *
 * - `retry`면 `failed`인 행만 읽는 중으로 되돌려 시작 시각을 새로 찍고 읽는다. 그 밖 상태는 바꾸지 않는다.
 * - **차지**가 중복을 막는다: 두 탭·두 번 클릭이 겹쳐도 NODA 업로드는 한 번(두 번째는 `busy`).
 * - NODA 쪽 실패(NodaError)는 던지지 않고 `reading`으로 둔다 — 다음 맞추기·다시 걸기가 이어 받는다.
 *   (DB 오류 같은 예상 밖 실패는 던진다.)
 * - 읽는 도중 문서가 지워졌으면(행 없음) NODA에 남은 사본을 지운다 — 고아를 남기지 않는다.
 */
export async function readDocument(
  documentId: string,
  opts: { retry?: boolean } = {},
  deps: ReadingDeps = defaultReadingDeps(),
): Promise<ReadOutcome> {
  const { store } = deps;
  const row = await store.getRow(documentId);
  // 비서 없는 문서(보관함 없음)·옮기기 전 문서(NULL)는 읽을 일이 없다
  if (!row || !row.agent_id || row.noda_status === null) return { status: 'not_found' };

  const current = (r: StoredDocument): ReadOutcome => ({ status: r.noda_status ?? 'not_found', reason: r.noda_reason });

  if (opts.retry) {
    if (row.noda_status !== 'failed') return current(row);
    const restarted = await store.restart(documentId, startReadingFields(new Date(deps.now())));
    if (!restarted) {
      const again = await store.getRow(documentId);
      return again ? current(again) : { status: 'not_found' };
    }
  } else if (row.noda_status !== 'reading') {
    return current(row);
  }

  const now = deps.now();
  const claimed = await store.claim(documentId, new Date(now).toISOString(), new Date(now - READ_KICK_AFTER_MS).toISOString());
  if (!claimed) return { status: 'busy' };

  const tenant = nodaTenant(row.agent_id);
  const filename = row.noda_filename ?? nodaFilename(row.id, row.file_name);
  const finishedAt = () => new Date(deps.now()).toISOString();

  /** 읽기 결과를 쓴다. 이미 달라진 행이면 덮지 않고 지금 상태를 돌려준다 */
  async function conclude(patch: FinishPatch, sentToNoda: boolean): Promise<ReadOutcome> {
    if (await store.finish(documentId, patch)) {
      return { status: patch.noda_status, ...(patch.noda_reason ? { reason: patch.noda_reason } : {}) };
    }
    const after = await store.getRow(documentId);
    if (!after) {
      // 읽는 도중 지워짐 — NODA에 사본이 생겼다면 지운다
      if (sentToNoda) {
        try {
          await deps.noda.deleteDocument(tenant, filename);
        } catch (err) {
          await logNodaError(deps, err, documentId);
        }
      }
      return { status: 'not_found' };
    }
    return current(after);
  }

  const bytes = await store.download(row.storage_path);
  if (!bytes) {
    return conclude(
      { noda_status: 'failed', noda_reason: '원본 파일을 저장소에서 가져오지 못했습니다. 다시 시도해 주세요.' },
      false,
    );
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return conclude(
      { noda_status: 'unreadable', noda_reason: `문서는 ${MAX_UPLOAD_SIZE_LABEL}까지 읽을 수 있습니다.` },
      false,
    );
  }

  let result;
  try {
    result = await deps.noda.uploadDocument({ tenant, filename, bytes });
  } catch (err) {
    if (!(err instanceof NodaError)) throw err;
    await logNodaError(deps, err, documentId);
    const after = await store.getRow(documentId);
    return after ? current(after) : { status: 'not_found' };
  }

  if (result.readable) {
    return conclude(
      { noda_status: 'ready', noda_reason: null, noda_doc_id: result.doc_id, noda_read_at: finishedAt() },
      true,
    );
  }
  const reason = (result.reason ?? '').trim().slice(0, MAX_REASON_CHARS) || UNREADABLE_DEFAULT_REASON;
  return conclude({ noda_status: 'unreadable', noda_reason: reason }, result.stored);
}

/**
 * 문서 목록을 열 때 `reading` 행을 NODA 목록과 맞춘다.
 *
 * - 보관함(비서)마다 목록을 한 번만 부르고, 한 번에 5개 보관함까지 본다.
 * - 끝났으면 `ready`, 10분 지나도 안 오면 `failed`로 행에 쓴다(조건부 — 그 사이 바뀐 행은 덮지 않는다).
 * - 다시 걸 대상(kick)은 **가장 오래된 하나**에만 `kick: true`를 단다 — 서버는 응답 뒤 일을 이어 가지 못하므로
 *   목록을 받은 화면이 읽기 라우트를 부른다(중복은 차지가 막는다).
 * - NODA 목록을 못 받으면 그 보관함 행은 그대로 둔다(포기하지도 않는다).
 */
export async function reconcileReading<T extends ReadingRow>(
  rows: T[],
  deps: ReadingDeps = defaultReadingDeps(),
): Promise<(T & { kick?: true })[]> {
  const byTenant = new Map<string, T[]>();
  for (const r of rows) {
    if (r.noda_status !== 'reading' || !r.agent_id || !r.noda_filename) continue;
    const list = byTenant.get(r.agent_id) ?? [];
    list.push(r);
    byTenant.set(r.agent_id, list);
  }

  const replaced = new Map<string, T & { kick?: true }>();
  let kickCandidate: T | null = null;

  for (const [agentId, group] of Array.from(byTenant).slice(0, MAX_TENANTS_PER_RECONCILE)) {
    let listing: NodaListing;
    try {
      listing = await deps.noda.listDocuments(nodaTenant(agentId));
    } catch (err) {
      await logNodaError(deps, err);
      continue;
    }
    const now = deps.now();
    for (const r of group) {
      const decision = decideReadState(r, listing, now);
      if (decision === 'ready') {
        const found = listing.documents.find((d) => d.filename === r.noda_filename);
        const wrote = await deps.store.finish(r.id, {
          noda_status: 'ready',
          noda_reason: null,
          ...(found?.doc_id ? { noda_doc_id: found.doc_id } : {}),
          noda_read_at: new Date(now).toISOString(),
        });
        if (wrote) replaced.set(r.id, { ...r, noda_status: 'ready' });
      } else if (decision === 'give_up') {
        const wrote = await deps.store.finish(r.id, { noda_status: 'failed', noda_reason: READ_TIMEOUT_REASON });
        if (wrote) replaced.set(r.id, { ...r, noda_status: 'failed' });
      } else if (decision === 'kick') {
        if (!kickCandidate || startedAt(r) < startedAt(kickCandidate)) kickCandidate = r;
      }
    }
  }

  return rows.map((r) => {
    const changed = replaced.get(r.id);
    if (changed) return changed;
    if (kickCandidate && r.id === kickCandidate.id) return { ...r, kick: true as const };
    return r;
  });
}
