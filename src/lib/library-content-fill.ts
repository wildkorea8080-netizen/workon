// src/lib/library-content-fill.ts
// 자료함 내용 글 채우기(2026-11-25, 0120) — 0117 전에 담은 파일·담을 때 읽지 못한 파일은 내용 글이 없어 이름으로만 찾혔다.
// 5분 실행기가 `content_checked_at`이 빈 파일을 몇 개씩 **자료함 사본**에서 다시 읽어(`readOriginalText` — 스캔 PDF는 NODA로 보내지 않음) 채운다.
// 읽었으면(글이 없었어도) 그때를 적어 다시 읽지 않고, 저장소가 잠깐 안 될 때(503)만 다음 차례에 다시 본다. 모델 호출 없음. 던지지 않는다.
import { libraryContentText } from '@/lib/my-library-spec';

/** 한 차례에 채우는 파일 수 — 원본 읽기가 무거워(10MB까지) 적게 */
export const LIBRARY_FILL_BATCH = 2;
/** 후보로 받는 수 — 섞어서 고른다(계속 실패하는 한 파일이 매번 앞을 차지하지 않게) */
export const LIBRARY_FILL_CANDIDATES = 20;
/** 한 차례에 쓰는 시간 상한 */
export const LIBRARY_FILL_BUDGET_MS = 25_000;

export type LibraryFillRow = { id: string; storage_path: string; file_name: string };
export type LibraryFillTick = { filled: number; empty: number; deferred: number };

export interface LibraryFillDeps {
  /** 내용을 아직 확인하지 않은 파일(최근 것부터) — 못 읽으면 던진다 */
  listPending(limit: number): Promise<LibraryFillRow[]>;
  /** 자료함 사본을 글로 — 실패면 상태 코드(503 = 지금 못 받음) */
  read(row: LibraryFillRow): Promise<{ ok: true; text: string } | { ok: false; status: number }>;
  /** 내용 글과 확인한 때를 적는다 — 아직 확인하지 않은 행일 때만. 적었으면 true, 못 쓰면 던진다 */
  save(id: string, content: string | null, checkedAt: string): Promise<boolean>;
  now(): number;
  random(): number;
}

export async function fillLibraryContent(deps: LibraryFillDeps): Promise<LibraryFillTick> {
  const tick: LibraryFillTick = { filled: 0, empty: 0, deferred: 0 };
  let rows: LibraryFillRow[];
  try { rows = await deps.listPending(LIBRARY_FILL_CANDIDATES); } catch { return tick; }
  const pool = rows.filter((r) => typeof r.id === 'string' && typeof r.storage_path === 'string' && r.storage_path.startsWith('my-library/'));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(deps.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const started = deps.now();
  for (const row of pool.slice(0, LIBRARY_FILL_BATCH)) {
    if (deps.now() - started > LIBRARY_FILL_BUDGET_MS) break;
    try {
      const read = await deps.read(row);
      // 저장소가 잠깐 안 됨 — 확인하지 않은 채로 두어 다음 차례에 다시
      if (!read.ok && read.status === 503) { tick.deferred += 1; continue; }
      // 읽었거나(글이 없었어도) 다시 해도 같은 실패(너무 큼·스캔 PDF·깨진 파일) — 확인한 때를 적는다
      const content = read.ok ? libraryContentText(read.text) : null;
      const saved = await deps.save(row.id, content, new Date(deps.now()).toISOString());
      if (saved) tick[content ? 'filled' : 'empty'] += 1;
    } catch {
      tick.deferred += 1;
    }
  }
  return tick;
}

/** 실제 DB·저장소 — 실행기 라우트가 쓴다 */
export async function libraryFillDeps(): Promise<LibraryFillDeps> {
  const { supabaseAdmin } = await import('@/lib/supabaseAdmin');
  const { readOriginalText } = await import('@/lib/source-original');
  return {
    async listPending(limit) {
      const { data, error } = await supabaseAdmin.from('my_library_files').select('id, storage_path, file_name')
        .is('content_checked_at', null).order('created_at', { ascending: false }).limit(limit);
      if (error) throw new Error(`my_library_files: ${error.message}`);
      return (data ?? []) as LibraryFillRow[];
    },
    async read(row) {
      const result = await readOriginalText(row.storage_path, row.file_name);
      return result.ok ? { ok: true, text: result.text } : { ok: false, status: result.status };
    },
    async save(id, content, checkedAt) {
      const { data, error } = await supabaseAdmin.from('my_library_files')
        .update({ content_text: content, content_checked_at: checkedAt })
        .eq('id', id).is('content_checked_at', null).select('id');
      if (error) throw new Error(`my_library_files: ${error.message}`);
      return Boolean(data?.length);
    },
    now: () => Date.now(),
    random: () => Math.random(),
  };
}
