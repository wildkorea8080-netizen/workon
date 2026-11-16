import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * 코드가 부르는 DB 이름 모으기(2026-11-16) — `.from('표')`, 그 사슬의 `.select('칸, 칸')`·필터(`.eq('칸'` 등), `.rpc('함수'`.
 *
 * 계기: 코드가 `users.password_hash`를 읽고 쓰는데 그 칸을 만드는 마이그레이션이 없었다(운영에도 없어 0097로 메움). 시험 DB는
 * 마이그레이션만으로 만들므로, 코드가 부르는 이름이 시험 DB에 없으면 '마이그레이션 없이 쓰는 이름'이다.
 *
 * 정규식으로 어림한다 — 틀린 경보를 내지 않는 쪽으로 좁혔다: 내장 관계 `관계(칸, …)`·`관계!inner(…)`는 떼고, `*`·별칭(`a:b`)·
 * 점 이름(`agents.organization_id`)은 보지 않으며, 사슬은 다음 `.from(`·`;`·줄 끝 쉼표에서 끊는다(insert/update 몸의 키는 안 봄).
 */

export interface CodeRef { kind: 'table' | 'column' | 'function'; name: string; file: string }

const IDENT = /^[a-z_][a-z0-9_]*$/;

export function sourceFiles(dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs)$/.test(f)) out.push(p);
    }
  };
  dirs.forEach(walk);
  return out;
}

/** select 글에서 이 표의 칸 이름만 — 괄호 묶음(내장 관계)을 통째로 뗀다 */
export function selectColumns(select: string): string[] {
  let s = select;
  // 안쪽 괄호부터 지운다(겹친 관계)
  for (let i = 0; i < 10 && /\([^()]*\)/.test(s); i++) s = s.replace(/[a-z0-9_!:]*\([^()]*\)/gi, '');
  return s.split(',').map((x) => x.trim()).filter((x) => IDENT.test(x));
}

export function extractRefs(src: string, file: string): CodeRef[] {
  const refs: CodeRef[] = [];
  for (const m of Array.from(src.matchAll(/\.rpc\(\s*'([a-z0-9_]+)'/g))) refs.push({ kind: 'function', name: m[1], file });
  for (const m of Array.from(src.matchAll(/\.from\(\s*'([a-z0-9_]+)'\s*\)/g))) {
    const table = m[1];
    refs.push({ kind: 'table', name: table, file });
    const tail = src.slice(m.index! + m[0].length, m.index! + m[0].length + 600);
    const stop = tail.search(/\.from\(|;|,\s*\n/);
    const chain = stop >= 0 ? tail.slice(0, stop) : tail;
    const names: string[] = [];
    const sel = /\.select\(\s*'([^']*)'/.exec(chain);
    if (sel) names.push(...selectColumns(sel[1]));
    for (const f of Array.from(chain.matchAll(/\.(?:eq|neq|is|in|gt|gte|lt|lte|order|not|ilike|like|contains)\(\s*'([a-z_][a-z0-9_]*)'/g))) names.push(f[1]);
    for (const n of names) refs.push({ kind: 'column', name: `${table}.${n}`, file });
  }
  return refs;
}

export function missingRefs(refs: CodeRef[], schema: { columns: Map<string, Set<string>>; functions: Set<string> }): Map<string, string[]> {
  const missing = new Map<string, string[]>();
  const add = (k: string, f: string) => missing.set(k, Array.from(new Set([...(missing.get(k) ?? []), f])));
  for (const r of refs) {
    if (r.kind === 'function' && !schema.functions.has(r.name)) add(`함수 ${r.name}`, r.file);
    if (r.kind === 'table' && !schema.columns.has(r.name)) add(`표 ${r.name}`, r.file);
    if (r.kind === 'column') {
      const [t, c] = r.name.split('.');
      if (schema.columns.has(t) && !schema.columns.get(t)!.has(c)) add(`칸 ${r.name}`, r.file);
    }
  }
  return missing;
}

export function readSource(file: string): string {
  return readFileSync(file, 'utf8');
}
