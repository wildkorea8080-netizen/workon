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

/** 표 한 장에서 읽는 최대 크기. 넘으면 잘라 읽고 그 사실을 남긴다. */
export const MAX_TABLE_ROWS = 20_000;
export const MAX_TABLE_COLS = 200;

/** 파일 하나에서 뽑는 본문 글자 상한. */
export const MAX_EXTRACT_CHARS = 200_000;
/** 모델이 한 번 읽을 때 돌려주는 분량. */
export const READ_TEXT_CHARS = 20_000;
export const READ_TABLE_ROWS = 200;

/** 올린 파일을 보낼지 확인하는 유효 시간. */
export const CONFIRM_WINDOW_MS = 10 * 60 * 1000;
/** 대화에 붙지 못한 채 남은 첨부를 지우는 시한. */
export const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;

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
