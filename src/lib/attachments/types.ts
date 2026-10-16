/** 첨부 읽기에서 오가는 타입. 표 엔진(S3-b)도 같은 형태를 받는다. */

export type Cell = string | number | null;

export interface TableMerge {
  row: number;
  col: number;
  rows: number;
  cols: number;
}

export interface ExtractedTable {
  /** 't1'… 파일 안 순서대로 */
  id: string;
  /** 시트 이름(+ ' 표 2') 또는 '표 3' */
  title: string;
  /** 병합은 주인 칸에만 값, 나머지 null */
  cells: Cell[][];
  merges: TableMerge[];
  /** 0부터 */
  header: { from: number; to: number };
  /** header로 만든 열 이름 (header.ts) */
  columns: string[];
  caption?: string;
  /** 잘린 원래 크기 */
  truncated?: { rows?: number; cols?: number };
}

export interface AttachmentExtract {
  kind: 'spreadsheet' | 'document' | 'presentation' | 'text';
  text: string;
  tables: ExtractedTable[];
  pages?: number;
  sheets?: string[];
  warnings: string[];
}

export interface AttachmentSummary {
  kind: AttachmentExtract['kind'];
  pages?: number;
  sheets?: string[];
  chars: number;
  /** rows = 머리글 아래 행 수 */
  tables: { id: string; title: string; rows: number; columns: string[] }[];
  warnings: string[];
}

export interface AttachmentRow {
  id: string;
  user_id: string;
  conversation_id: string | null;
  file_name: string;
  size_bytes: number;
  status: 'pending' | 'ready' | 'failed';
  summary: AttachmentSummary | null;
  error: string | null;
  created_at: string;
}
