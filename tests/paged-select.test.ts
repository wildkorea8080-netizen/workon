import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { sourceFiles } from './helpers/source-files';
import { pagedRows, PAGE_SIZE } from '@/lib/paged-select';

/**
 * Supabase API는 한 번에 최대 행 수(기본 1,000)까지만 **오류 없이** 돌려준다(2026-11-05 발견).
 * 사용 기록을 앱으로 읽어 더하는 곳은 쪽마다 끝까지 읽고(pagedRows), 매 대화마다 도는 한도 판정은 DB 함수로 센다.
 */

/** 가짜 표 — `range(from, to)`를 PostgREST처럼 1,000행 상한으로 자르고, count를 달라면 전체 수를 준다 */
function table(n: number, failAt?: number) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: i }));
  const calls: Array<[number, number, boolean]> = [];
  const page = vi.fn(async (from: number, to: number, withCount: boolean) => {
    calls.push([from, to, withCount]);
    if (failAt !== undefined && from >= failAt) return { data: null, error: { message: 'boom' } };
    const end = Math.min(to, from + PAGE_SIZE - 1);
    return { data: rows.slice(from, end + 1), error: null, count: withCount ? n : null };
  });
  return { page, calls };
}

describe('pagedRows', () => {
  it('1,000행을 넘어도 끝까지 — 첫 쪽에서 전체 수를 받고 나머지 쪽을 읽는다', async () => {
    const t = table(3_500);
    const out = await pagedRows(t.page);
    expect(out.data).toHaveLength(3_500);
    expect(out.data.map((r) => r.id)).toEqual(Array.from({ length: 3_500 }, (_, i) => i));
    expect(out).toMatchObject({ truncated: false, total: 3_500, error: null });
    expect(t.calls[0]).toEqual([0, 999, true]);
    expect(t.calls.slice(1).map((c) => c[0]).sort((a, b) => a - b)).toEqual([1000, 2000, 3000]);
    expect(t.calls.slice(1).every((c) => c[2] === false)).toBe(true);
  });
  it('적으면 한 번, 딱 1,000행이면 더 부르지 않는다', async () => {
    const small = table(10);
    expect((await pagedRows(small.page)).data).toHaveLength(10);
    expect(small.calls).toHaveLength(1);
    const exact = table(1000);
    expect((await pagedRows(exact.page)).data).toHaveLength(1000);
    expect(exact.calls).toHaveLength(1);
  });
  it('상한에서 멈추고 잘렸다고 알린다', async () => {
    const t = table(5_200);
    const out = await pagedRows(t.page, { cap: 3_000 });
    expect(out.data).toHaveLength(3_000);
    expect(out).toMatchObject({ truncated: true, total: 5_200 });
  });
  it('한 쪽이라도 실패하면 일부 합계를 내지 않고 오류', async () => {
    const t = table(3_500, 2000);
    const out = await pagedRows(t.page);
    expect(out).toMatchObject({ data: [], error: { message: 'boom' } });
    const first = table(10, 0);
    expect((await pagedRows(first.page)).error).toEqual({ message: 'boom' });
  });
  it('전체 수를 모르면 짧은 쪽이 올 때까지 차례로', async () => {
    const rows = Array.from({ length: 2_300 }, (_, i) => ({ id: i }));
    const page = vi.fn(async (from: number, to: number) => ({ data: rows.slice(from, Math.min(to, from + 999) + 1), error: null }));
    const out = await pagedRows(page);
    expect(out.data).toHaveLength(2_300);
    expect(page).toHaveBeenCalledTimes(3);
    expect(out.total).toBeNull();
  });
});

describe('사용 기록을 읽는 곳(원본 확인)', () => {
  it('usage_logs를 읽는 select는 모두 쪽 읽기·개수만·줄 수 제한 중 하나다 — 한도 없이 읽어 합계를 내지 않는다', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles('src').filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))) {
      const src = readFileSync(file, 'utf8');
      let at = src.indexOf("from('usage_logs')");
      while (at !== -1) {
        // 이 조회가 끝나는 곳(다음 세미콜론 또는 Promise.all 원소의 쉼표 줄)까지
        const tail = src.slice(at, at + 700);
        const end = tail.search(/;\n|\),\n/);
        const chunk = tail.slice(0, end === -1 ? tail.length : end + 2);
        const before = src.slice(Math.max(0, at - 220), at);
        const isWrite = /\.insert\(|\.update\(|\.delete\(/.test(chunk.slice(0, 120));
        const bounded = /\.range\(|\.limit\(|head: true/.test(chunk) || /pagedRows/.test(before);
        if (!isWrite && !bounded) offenders.push(`${file}: ${chunk.split('\n')[0]}`);
        at = src.indexOf("from('usage_logs')", at + 1);
      }
    }
    expect(offenders).toEqual([]);
  });
  it('.limit(N)은 1,000을 넘기지 않는다 — 넘겨도 API가 1,000행에서 조용히 자른다(감사 CSV·업무 현황이 그랬다)', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles('src')) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\.limit\(([A-Za-z_][A-Za-z0-9_]*|[0-9_]+)\)/g)) {
        const arg = m[1];
        let n = /^[0-9_]+$/.test(arg) ? Number(arg.replace(/_/g, '')) : NaN;
        if (Number.isNaN(n)) {
          const def = new RegExp(`const ${arg}\\s*=\\s*([0-9_]+)`).exec(src);
          if (def) n = Number(def[1].replace(/_/g, ''));
        }
        if (n > 1000) offenders.push(`${file}: .limit(${arg}) = ${n}`);
      }
    }
    expect(offenders).toEqual([]);
  });
  it('감사 자료 CSV는 쪽마다 끝까지 읽고, 업무 현황·사용자·문서 목록도 쪽 읽기', () => {
    const audit = readFileSync('src/app/api/admin/audit-logs/route.ts', 'utf8');
    expect(audit).toContain('pagedRows<any>((a, b, withCount) => build(withCount).range(a, b), { cap: MAX_EXPORT_ROWS })');
    expect(audit).not.toContain('query.limit(MAX_EXPORT_ROWS)');
    for (const f of ['src/lib/work/store/supabase.ts', 'src/app/api/users/route.ts', 'src/app/api/documents/route.ts', 'src/app/api/my/stats/route.ts', 'src/app/api/departments/route.ts', 'src/lib/agent-documents.ts', 'src/lib/document-upload.ts']) {
      expect(readFileSync(f, 'utf8'), f).toContain('pagedRows');
    }
    // 내 통계는 대화 id 목록을 in()으로 넘기지 않는다(주소가 길어지고 1,000행에서 잘림)
    expect(readFileSync('src/app/api/my/stats/route.ts', 'utf8')).not.toContain(".in('conversation_id'");
  });
  it('월 토큰 한도 판정·예산 알림은 DB 함수로 센다(매 대화마다 도는 판정)', () => {
    const src = readFileSync('src/lib/usage-limit.ts', 'utf8');
    expect(src.match(/rpc\('organization_chat_tokens'/g)).toHaveLength(2);
    const sql = readFileSync('supabase/migrations/0057_organization_chat_tokens.sql', 'utf8');
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.organization_chat_tokens\(uuid, timestamptz\) FROM PUBLIC, anon, authenticated/);
    expect(sql).toContain("action = 'chat_message'");
    expect(sql).toContain('idx_usage_logs_org_action_created');
  });
  it('이용통계는 DB가 묶는다(0058) — 기록을 앱으로 읽지 않아 50,000행 상한도 없다', () => {
    const route = readFileSync('src/app/api/admin/usage-summary/route.ts', 'utf8');
    expect(route).toContain("supabaseAdmin.rpc('usage_summary'");
    expect(route).not.toContain("from('usage_logs')");
    expect(readFileSync('src/components/admin/UsageSummary.tsx', 'utf8')).not.toContain('50,000건');
  });
});
