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
  '.pptx',
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
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
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

/**
 * 파일 하나의 상한.
 *
 * 화면과 서버가 서로 다른 숫자를 들고 있었다 — 화면은 10MB라 안내하고
 * 서버는 20MB까지 받았다. 담당자는 12MB 문서를 올릴 수 있는데도 못 올린다고
 * 읽는다. 형식 목록을 한 곳에 모은 것과 같은 이유로 크기도 여기 둔다.
 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * 비서 하나에 붙일 수 있는 문서 수.
 *
 * 10개는 실무에서 금방 막힌다 — 복무·여비·문서관리 규정을 한 질만 올려도
 * 넘는다. 그렇다고 무제한으로 둘 수는 없다. 문서를 붙일 때마다 청킹과
 * 임베딩 비용이 선형으로 늘고, 검색 대상이 넓어질수록 엉뚱한 청크가
 * 딸려 올 확률도 함께 는다.
 *
 * **상한이 화면에만 있었다.** `/api/upload`에는 개수 검사가 아예 없어,
 * 화면을 거치지 않으면 얼마든지 붙일 수 있었다. 개인 비서 커넥터 범위와
 * 같은 원칙으로 서버가 판정한다 — 화면 검사는 표시일 뿐이다.
 */
export const MAX_AGENT_DOCUMENTS = 50;

/** 사람이 읽는 크기 표기 */
export const MAX_UPLOAD_SIZE_LABEL = `${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB`;
