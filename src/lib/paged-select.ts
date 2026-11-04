// src/lib/paged-select.ts
// PostgREST(Supabase API)는 한 번에 최대 행 수(기본 1,000)까지만 돌려준다 — 그보다 많으면 **오류 없이 앞부분만** 온다.
// 사용 기록을 앱으로 읽어 합계를 내는 화면은 기록이 1,000건을 넘는 순간 조용히 덜 센다(2026-11-05 발견).
// 이 헬퍼는 같은 조회를 쪽마다(`range`) 끝까지 읽는다.
//
// - 첫 쪽에서 전체 수(`count: 'exact'`)를 받고, 나머지 쪽을 4개씩 동시에 읽는다.
// - 쪽이 서로 겹치거나 빠지지 않게 부르는 쪽이 **정렬(유일한 칸, 보통 id)** 을 건다.
// - 상한(`cap`, 기본 50,000행)에서 멈추고 `truncated: true`를 돌려준다 — 부르는 쪽이 화면에 '일부만' 표시를 할 수 있게.
// - 한 쪽이라도 실패하면 그 오류를 돌려준다(일부만 센 합계를 맞는 것처럼 내지 않는다).
// 실시간으로 자주 도는 판정(한도·예산)은 이 헬퍼가 아니라 DB 함수로 센다(usage-limit.ts).

export const PAGE_SIZE = 1000;
export const DEFAULT_ROW_CAP = 50_000;
const CONCURRENCY = 4;

type PageResult<T> = { data: T[] | null; error: { message: string } | null; count?: number | null };

export interface PagedRows<T> {
  data: T[];
  error: { message: string } | null;
  /** 상한에 닿아 뒤쪽을 읽지 않았다 */
  truncated: boolean;
  /** 조건에 맞는 전체 행 수(알 수 없으면 null) */
  total: number | null;
}

/**
 * `page(from, to, withCount)` — 같은 조회에 `.range(from, to)`를 붙여 돌려주는 함수. `withCount`가 참이면 `select(…, { count: 'exact' })`로 만든다.
 * 예: `pagedRows((a, b, c) => db.from('usage_logs').select('details', c ? { count: 'exact' } : undefined).eq(...).order('id').range(a, b))`
 */
export async function pagedRows<T>(
  page: (from: number, to: number, withCount: boolean) => PromiseLike<PageResult<T>>,
  opts: { cap?: number; pageSize?: number } = {},
): Promise<PagedRows<T>> {
  const size = Math.max(1, Math.min(opts.pageSize ?? PAGE_SIZE, PAGE_SIZE));
  const cap = Math.max(size, opts.cap ?? DEFAULT_ROW_CAP);
  const first = await page(0, size - 1, true);
  if (first.error) return { data: [], error: first.error, truncated: false, total: null };
  const rows: T[] = [...(first.data ?? [])];
  const total = typeof first.count === 'number' ? first.count : null;

  // 전체 수를 알면 남은 쪽을 동시에, 모르면 짧은 쪽이 올 때까지 차례로
  if (total !== null) {
    const want = Math.min(total, cap);
    const starts: number[] = [];
    for (let s = rows.length; s < want; s += size) starts.push(s);
    const pages: T[][] = new Array(starts.length);
    let next = 0;
    let failure: { message: string } | null = null;
    const worker = async () => {
      while (next < starts.length && !failure) {
        const i = next++;
        const s = starts[i];
        const r = await page(s, Math.min(s + size, want) - 1, false);
        if (r.error) { failure = r.error; return; }
        pages[i] = r.data ?? [];
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, starts.length) }, worker));
    if (failure) return { data: [], error: failure, truncated: false, total };
    for (const p of pages) rows.push(...(p ?? []));
    return { data: rows, error: null, truncated: total > cap, total };
  }

  let last = first.data?.length ?? 0;
  while (last === size && rows.length < cap) {
    const r = await page(rows.length, rows.length + size - 1, false);
    if (r.error) return { data: [], error: r.error, truncated: false, total: null };
    const got = r.data ?? [];
    rows.push(...got);
    last = got.length;
  }
  return { data: rows.slice(0, cap), error: null, truncated: rows.length >= cap && last === size, total: null };
}
