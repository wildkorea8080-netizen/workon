/** 화면용 크기 표시. 클라이언트에서 쓰므로 서버 모듈을 import하지 않는다 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
