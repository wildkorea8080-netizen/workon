/**
 * 운영 DB 스키마와 저장소 마이그레이션의 어긋남 찾기(2026-11-16) — 잎 파일(아무것도 import하지 않음).
 *
 * 0096 배포 뒤에 운영 DB에 `users.password_hash` 칸·`security_logs` 표가 없던 것을 찾았다(0097로 메움). 단위 시험은 가짜 DB를 쓰고
 * 시험 DB는 마이그레이션만으로 만들므로, 운영을 대시보드에서 손댔거나 마이그레이션 하나를 빠뜨리면 아무 시험도 못 잡는다.
 * `npm run db:drift`가 시험 DB(마이그레이션 전부 = 기준)와 운영 DB(대상)의 public 스키마를 읽기 전용으로 읽어 이 함수로 맞댄다.
 *
 * 보는 것: 표·뷰, 칸(형식·NULL 허용), 함수(이름 + 인자 형식), RLS가 꺼진 표. 이름만 다루고 행 값은 읽지 않는다.
 */

export interface SchemaColumn { table: string; column: string; type: string; nullable: boolean }
export interface SchemaSnapshot {
  /** 표·뷰 이름 → 'table' | 'view' */
  relations: Record<string, 'table' | 'view'>;
  columns: SchemaColumn[];
  /** `이름(인자 형식)` */
  functions: string[];
  /** RLS가 꺼진 표 이름 */
  rlsOff: string[];
}

export interface SchemaDrift {
  /** 마이그레이션이 만드는데 대상에 없는 것 — 코드가 쓰면 실패한다 */
  missingRelations: string[];
  missingColumns: string[];
  missingFunctions: string[];
  /** 같은 칸인데 형식이나 NULL 허용이 다르다 */
  columnMismatches: string[];
  /** 대상에만 있는 것(대시보드에서 만든 흔적 — 정보) */
  extraRelations: string[];
  extraColumns: string[];
  extraFunctions: string[];
  /** 대상에서 RLS가 꺼진 표(0090 원칙 위반 — 공개 키로 열릴 수 있다) */
  rlsOff: string[];
}

/**
 * 시험 DB는 pgvector가 없어 옛 `vector(N)` 칸을 text로 만든다(`scripts/work-testdb.mjs`의 shim) — 그 차이는 어긋남이 아니다.
 * 함수 인자도 같은 까닭으로 vector ↔ text가 갈린다.
 */
function sameType(ref: string, target: string): boolean {
  if (ref === target) return true;
  return ref === 'text' && target === 'vector';
}

function normalizeFunction(sig: string): string {
  return sig.replace(/\bvector\b/g, 'text').replace(/\s+/g, ' ').trim();
}

const sorted = (xs: Iterable<string>) => Array.from(new Set(xs)).sort();

export function diffSchemas(ref: SchemaSnapshot, target: SchemaSnapshot): SchemaDrift {
  const targetRelations = new Set(Object.keys(target.relations));
  const refRelations = new Set(Object.keys(ref.relations));
  const key = (c: SchemaColumn) => `${c.table}.${c.column}`;
  const targetCols = new Map(target.columns.map((c) => [key(c), c]));
  const refCols = new Map(ref.columns.map((c) => [key(c), c]));

  const missingRelations = sorted(Array.from(refRelations).filter((r) => !targetRelations.has(r)));
  const missingRelationSet = new Set(missingRelations);
  const missingColumns: string[] = [];
  const columnMismatches: string[] = [];
  for (const [k, c] of Array.from(refCols)) {
    // 표가 통째로 없으면 칸마다 다시 적지 않는다
    if (missingRelationSet.has(c.table)) continue;
    const t = targetCols.get(k);
    if (!t) { missingColumns.push(k); continue; }
    const diffs: string[] = [];
    if (!sameType(c.type, t.type)) diffs.push(`형식 ${c.type} → ${t.type}`);
    if (c.nullable !== t.nullable) diffs.push(c.nullable ? 'NULL 허용 → NOT NULL' : 'NOT NULL → NULL 허용');
    if (diffs.length) columnMismatches.push(`${k}: ${diffs.join(', ')}`);
  }

  const targetFns = new Set(target.functions.map(normalizeFunction));
  const refFns = new Set(ref.functions.map(normalizeFunction));
  const extraRelationSet = new Set(Array.from(targetRelations).filter((r) => !refRelations.has(r)));

  return {
    missingRelations,
    missingColumns: sorted(missingColumns),
    missingFunctions: sorted(Array.from(refFns).filter((f) => !targetFns.has(f))),
    columnMismatches: sorted(columnMismatches),
    extraRelations: sorted(extraRelationSet),
    extraColumns: sorted(Array.from(targetCols.keys()).filter((k) => !refCols.has(k) && !extraRelationSet.has(targetCols.get(k)!.table))),
    extraFunctions: sorted(Array.from(targetFns).filter((f) => !refFns.has(f))),
    rlsOff: sorted(target.rlsOff),
  };
}

/** 코드가 실패할 수 있는 어긋남이 있는가(대상에 없는 것·형식 다름·RLS 꺼짐) — 대상에만 있는 것은 세지 않는다 */
export function hasBlockingDrift(d: SchemaDrift): boolean {
  return d.missingRelations.length + d.missingColumns.length + d.missingFunctions.length + d.columnMismatches.length + d.rlsOff.length > 0;
}

/** 사람이 읽는 보고(이름만) */
export function formatDrift(d: SchemaDrift): string {
  const section = (title: string, xs: string[]) => (xs.length ? [`${title} (${xs.length})`, ...xs.map((x) => `  - ${x}`)] : [`${title}: 없음`]);
  return [
    ...section('마이그레이션에 있는데 대상에 없는 표·뷰', d.missingRelations),
    ...section('마이그레이션에 있는데 대상에 없는 칸', d.missingColumns),
    ...section('마이그레이션에 있는데 대상에 없는 함수', d.missingFunctions),
    ...section('형식·NULL 허용이 다른 칸', d.columnMismatches),
    ...section('RLS가 꺼진 표(대상)', d.rlsOff),
    ...section('(정보) 대상에만 있는 표·뷰', d.extraRelations),
    ...section('(정보) 대상에만 있는 칸', d.extraColumns),
    ...section('(정보) 대상에만 있는 함수', d.extraFunctions),
  ].join('\n');
}

/** 스냅숏 읽는 SQL(public만, 이름·형식만) — 스크립트와 시험이 같은 질의를 쓴다 */
export const SNAPSHOT_SQL = {
  relations: `SELECT c.relname AS name, CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END AS kind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m')`,
  columns: `SELECT c.relname AS "table", a.attname AS "column", format_type(a.atttypid, NULL) AS type, NOT a.attnotnull AS nullable
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m') AND a.attnum > 0 AND NOT a.attisdropped`,
  functions: `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
    WHERE n.nspname = 'public' AND d.objid IS NULL`,
  rlsOff: `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity`,
} as const;

export function toSnapshot(rows: {
  relations: Array<{ name: string; kind: string }>;
  columns: Array<{ table: string; column: string; type: string; nullable: boolean }>;
  functions: Array<{ sig: string }>;
  rlsOff: Array<{ name: string }>;
}, ignoreRelations: string[] = []): SchemaSnapshot {
  const ignore = new Set(ignoreRelations);
  const relations: SchemaSnapshot['relations'] = {};
  for (const r of rows.relations) if (!ignore.has(r.name)) relations[r.name] = r.kind === 'view' ? 'view' : 'table';
  return {
    relations,
    columns: rows.columns.filter((c) => !ignore.has(c.table)).map((c) => ({ table: c.table, column: c.column, type: c.type, nullable: Boolean(c.nullable) })),
    functions: rows.functions.map((f) => f.sig),
    rlsOff: rows.rlsOff.map((r) => r.name).filter((n) => !ignore.has(n)),
  };
}
