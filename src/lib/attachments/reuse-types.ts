// 지난 파일 다시 붙이기의 꼴 — 화면도 읽으므로 아무것도 import하지 않는다(reuse.ts는 서버 전용)
// 'library' = 내 자료함(2026-11-24, 0103)
export type ReuseKind = 'attachment' | 'generated' | 'library';
export interface ReusableFile {
  kind: ReuseKind;
  id: string;
  file_name: string;
  size_bytes: number;
  created_at: string;
  /** 내 자료함의 폴더('' = 미분류) — kind 'library'일 때만 */
  folder?: string;
}
