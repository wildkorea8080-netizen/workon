/**
 * 업로드 허용 파일 형식 — **여기 한 곳에만 둡니다.**
 *
 * 목록이 서버 검증·파일 선택창(accept)·화면 안내 네 곳에 흩어져 있었고,
 * XLSX를 추가했을 때 서버만 바뀌어 화면이 파일을 먼저 막았습니다. 그 전에는
 * HWP를 추가했는데 오류 문구만 옛 목록으로 남아 있었습니다. 같은 종류의
 * 어긋남이 두 번 났으므로 정의를 하나로 모읍니다.
 *
 * 무거운 파서(pdf-parse·mammoth·exceljs)를 끌어오지 않도록 별도 모듈로 둡니다 —
 * 클라이언트 컴포넌트가 import 하기 때문입니다.
 */

/** 확장자 (소문자, 점 포함) */
export const ALLOWED_UPLOAD_EXTENSIONS = [
  '.pdf',
  '.docx',
  '.txt',
  '.hwp',
  '.hwpx',
  '.xlsx',
  '.xlsm',
  '.csv',
] as const;

/**
 * MIME 타입.
 *
 * HWP·DOCX는 브라우저가 MIME을 비우거나 application/octet-stream으로 보내는
 * 경우가 있어 확장자 검사와 함께 씁니다. 둘 중 하나만 맞아도 통과시킵니다.
 */
export const ALLOWED_UPLOAD_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'application/x-hwp',
  'application/haansofthwp',
  'application/hwp+zip',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
] as const;

/** `<input type="file" accept="...">`에 그대로 넣는다 */
export const UPLOAD_ACCEPT_ATTRIBUTE = ALLOWED_UPLOAD_EXTENSIONS.join(',');

/** 화면 안내와 오류 문구에 쓰는 사람이 읽는 목록 (예: "PDF, DOCX, …") */
export const UPLOAD_FORMATS_LABEL = ALLOWED_UPLOAD_EXTENSIONS.map((ext) =>
  ext.slice(1).toUpperCase()
).join(', ');

export function hasAllowedUploadExtension(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return ALLOWED_UPLOAD_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
