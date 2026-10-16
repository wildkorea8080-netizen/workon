/**
 * 첨부 파일 상한과 허용 형식.
 *
 * 화면(클라이언트)도 이 파일을 읽으므로 **아무것도 import하지 않는다.**
 * 서버 검증·화면 검사·`accept` 속성이 같은 값을 봐야 어긋나지 않는다
 * (`chat-images.ts`와 같은 원칙). 화면 검사는 표시일 뿐이고 서버가 다시 검사한다.
 */

/** 파일 하나. Vercel 요청 본문 상한 때문에 올리기는 서명 주소로 직접 한다. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_SEND = 10;
export const MAX_ATTACHMENTS_PER_CONVERSATION = 30;
/**
 * 보내지 않은 첨부(대화에 안 묶인 것) 상한. 서명 업로드 주소는 크기도 개수도 막지 않으므로 발급 수를 여기서 막는다.
 * 센 것: 24시간(ORPHAN_TTL_MS) 안의 pending·ready, 그리고 서명 주소가 아직 살아 있는
 * TOMBSTONE_WINDOW_MS 안의 failed 묘비(거부·삭제로 남은 기록 — 그 주소로는 아직 올릴 수 있다).
 * 시한이 지난 failed는 세지 않는다 — 안 그러면 올리기가 실패한 사용자가 하루 동안 갇힌다.
 */
export const MAX_PENDING_ATTACHMENTS = 20;

/** 표 한 장에서 읽는 최대 크기. 넘으면 잘라 읽고 그 사실을 남긴다. */
export const MAX_TABLE_ROWS = 20_000;
export const MAX_TABLE_COLS = 200;

/** 파일 하나에서 읽는 표 수 상한. 넘으면 앞의 것만 읽고 경고한다(읽은 내용 크기·개요를 파일이 정하지 않게) */
export const MAX_TABLES_PER_FILE = 100;

/** 파일 하나에서 뽑는 본문 글자 상한. */
export const MAX_EXTRACT_CHARS = 200_000;
/** 모델이 한 번 읽을 때 돌려주는 분량. */
export const READ_TEXT_CHARS = 20_000;
export const READ_TABLE_ROWS = 200;
/** 표 한 번 읽기의 글자 상한. 넓은 표는 200행이 수십만 자가 된다 — 행 수만으로는 막지 못한다 */
export const READ_TABLE_CHARS = READ_TEXT_CHARS * 2;

/**
 * 시스템 프롬프트의 첨부 목록 상한. 이 목록은 매 턴 실리고 파일에서 온 글(이름·표 제목·열 이름)이라
 * 크기를 파일이 정하게 두면 안 된다 — 넓은 표 하나·파일 30개가 프롬프트를 채운다.
 */
export const OVERVIEW_NAME_CHARS = 40;
export const OVERVIEW_TABLES_PER_FILE = 10;
export const OVERVIEW_WARNINGS_PER_FILE = 3;
/** 넘으면 남은 파일은 ref와 이름만 적는다 */
export const OVERVIEW_TOTAL_CHARS = 8000;

/** 올린 파일을 보낼지 확인하는 유효 시간. */
export const CONFIRM_WINDOW_MS = 10 * 60 * 1000;
/** 대화에 붙지 못한 채 남은 첨부를 지우는 시한. */
export const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * 서명 업로드 주소는 2시간 살아 있다(Supabase). 거부·삭제로 failed가 된 첨부는 그 시한 + 여유 10분이 지나면
 * 더 올라올 수 없으므로 상한에서 빼고 정리한다. 그 전에는 지우면 뒤늦게 올라온 객체가 기록 없이 남는다.
 */
export const TOMBSTONE_WINDOW_MS = (2 * 60 + 10) * 60 * 1000;

export const ATTACHMENT_EXTENSIONS = [
  '.xlsx',
  '.xlsm',
  '.csv',
  '.hwpx',
  '.hwp',
  '.docx',
  '.pdf',
  '.pptx',
  '.txt',
] as const;

export const ATTACHMENT_ACCEPT = ATTACHMENT_EXTENSIONS.join(',');

function rawExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot).toLowerCase();
}

/** 소문자·점 없이. 허용 밖이면 null. */
export function attachmentExtension(fileName: string): string | null {
  const ext = rawExtension(fileName);
  return (ATTACHMENT_EXTENSIONS as readonly string[]).includes(ext) ? ext.slice(1) : null;
}

const REFUSED: Record<string, string> = {
  '.xls': '옛 엑셀(XLS)은 열 수 없습니다. 엑셀에서 XLSX로 저장해 다시 올려 주세요.',
  '.ppt': '옛 파워포인트(PPT)는 열 수 없습니다. PPTX로 저장해 다시 올려 주세요.',
  '.doc': '옛 워드(DOC)는 열 수 없습니다. DOCX로 저장해 다시 올려 주세요.',
};

/** 옛 형식은 "열 수 없다"가 아니라 어떻게 하면 되는지를 알려 준다. */
export function refusedFormatMessage(fileName: string): string | null {
  return REFUSED[rawExtension(fileName)] ?? null;
}
