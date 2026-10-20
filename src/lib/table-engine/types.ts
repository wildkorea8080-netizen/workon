/**
 * 표 계산 엔진의 입출력. AI는 CombineSpec(어떻게 합칠지)만 정하고 숫자는 엔진이 낸다.
 * Lineage(계산 근거)는 엑셀 근거 시트와 도구 결과에 그대로 실린다 — 무엇을 빼고 바꿨는지 사람이 확인할 수 있게.
 */
import type { ExtractedTable } from '@/lib/attachments/types';

export interface SourceSpec {
  file: string;
  table: string;
  /** 1부터, 화면 표기 */
  header_rows?: [number, number];
  /** 원래 열 이름 → 새 이름 */
  rename?: Record<string, string>;
  /** 열 이름 → 곱할 수(원 → 천원이면 0.001) */
  scale?: Record<string, number>;
  /** 첫 칸 글이 이것과 같으면(공백 무시) 뺀다 */
  skip_rows_matching?: string[];
}

export interface CombineSpec {
  sources: SourceSpec[];
  filter?: { column: string; op: '=' | '!=' | '>' | '>=' | '<' | '<=' | 'contains'; value: string | number }[];
  group_by?: string[];
  aggregate?: { column: string; fn: 'sum' | 'count' | 'avg' | 'min' | 'max'; as?: string }[];
  sort?: { column: string; desc?: boolean }[];
  add_source_column?: boolean;
  total_row?: boolean;
}

/** 찾아 온 표. 원천 옵션(rename·scale 등)은 여기 없고 CombineSpec.sources에서 file·table로 짝지어 읽는다 — 근원이 하나여야 어긋나지 않는다 */
export interface SourceTable {
  file: string;
  fileName: string;
  table: ExtractedTable;
}

export interface ResultColumn {
  name: string;
  unit: string | null;
  numeric: boolean;
}

export interface Lineage {
  sources: {
    file: string;
    fileName: string;
    table: string;
    title: string;
    headerRows: [number, number];
    /** 머리글 아래 빈 행을 뺀 행 수 */
    rowsIn: number;
    rowsUsed: number;
  }[];
  renamed: { file: string; from: string; to: string }[];
  /** column = 그 원천의 열 이름(이름 바꾼 뒤) */
  scaled: { file: string; column: string; factor: number }[];
  /** row: 원본 cells의 1부터 번호 — 원본 파일에서 찾을 수 있게 */
  skippedRows: { file: string; table: string; row: number; reason: string; text: string }[];
  /**
   * 숫자 열에서 값으로 쓰지 않은 칸(null로 둠 — 0이 아님). column = 원천의 열 이름.
   * reason은 숫자로는 읽혔지만 단위가 맞지 않아 뺀 칸에만 있다
   */
  unreadable: { file: string; table: string; row: number; column: string; text: string; reason?: string }[];
  /** 세로 병합 숫자 — 주인 칸(row)에서 한 번만 셈. rowEnd = 병합이 끝나는 행(1부터) */
  mergedNumbers: { file: string; table: string; row: number; rowEnd: number; column: string }[];
  /** 일부 원천에만 있는 열과 그 열이 있는 원천(a1/t1) */
  onlyIn: { column: string; files: string[] }[];
  unitWarnings: string[];
  /** 괄호 숫자 '(1,234)'를 음수로 읽은 열 — 부분 금액 표기일 수도 있어 확인을 청한다 */
  parenthesizedNegatives: string[];
  /** 열 판정 경고 — 숫자가 섞였지만 과반이 아니라 글자 열로 둔 열 등 */
  columnWarnings: string[];
  similarKeys: string[][];
  rowCounts: { stacked: number; filtered: number; result: number };
  truncated: boolean;
}

export type ResultValue = string | number | null;

export type CombineResult =
  | { ok: true; columns: ResultColumn[]; rows: ResultValue[][]; total: ResultValue[] | null; lineage: Lineage }
  | { ok: false; error: string };
