/**
 * 대화에 첨부하는 이미지 — 규칙을 **여기 한 곳에만** 둡니다.
 *
 * 업로드 파일 형식(`file-types.ts`)에서 목록이 흩어져 두 번 어긋난 적이 있어
 * 같은 실수를 반복하지 않습니다. 서버 검증·클라이언트 검사·화면 안내가
 * 모두 이 파일을 봅니다.
 *
 * 무거운 모듈을 끌어오지 않습니다 — 클라이언트 컴포넌트가 import 합니다.
 */

/**
 * Anthropic이 받는 형식.
 *
 * HEIC(아이폰 기본)는 넣지 않습니다. 브라우저 canvas가 대부분 디코딩하지 못해
 * 축소 단계에서 실패하고, Anthropic도 받지 않습니다. 사용자에게는 "JPG·PNG로
 * 저장해 올려달라"고 안내하는 편이 정확합니다.
 */
export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;

export const IMAGE_ACCEPT_ATTRIBUTE = ALLOWED_IMAGE_MIME_TYPES.join(',');

/** 한 번에 붙일 수 있는 장수 */
export const MAX_CHAT_IMAGES = 4;

/**
 * 긴 변 기준 축소 목표(px).
 *
 * Anthropic은 이보다 큰 이미지를 알아서 줄이는데, 줄이기 **전** 크기로 토큰을
 * 세지 않을 뿐 전송량은 그대로입니다. 미리 줄이면 요청 본문과 토큰이 함께
 * 작아집니다.
 */
export const IMAGE_MAX_EDGE = 1568;

/**
 * 이미지 하나의 상한(바이트, base64 디코딩 후).
 *
 * Anthropic 자체 상한은 5MB지만 여기서는 더 낮게 잡습니다. Vercel 서버리스
 * 함수의 **요청 본문 상한이 4.5MB**이고 base64는 원본보다 약 33% 커지기
 * 때문입니다. 상한을 5MB로 두면 서버 코드에 닿기도 전에 요청이 잘려
 * 원인을 알 수 없는 실패가 됩니다.
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** 전체 합계 상한. 4장을 각각 2MB로 올리면 본문 상한을 넘는다. */
export const MAX_TOTAL_IMAGE_BYTES = 3 * 1024 * 1024;

export interface ChatImage {
  /** ALLOWED_IMAGE_MIME_TYPES 중 하나 */
  media_type: string;
  /** base64 (data: 접두사 없이) */
  data: string;
}

/** base64 문자열이 디코딩되면 몇 바이트인지. 실제로 디코딩하지 않는다. */
export function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

/** 사람이 읽는 크기 */
function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
    : `${Math.ceil(bytes / 1024)}KB`;
}

/**
 * 첨부 이미지를 검사한다. 문제가 없으면 null.
 *
 * **서버가 반드시 다시 부릅니다.** 클라이언트 검사는 편의일 뿐이고, 화면을
 * 거치지 않고 API를 직접 부르는 경로가 언제나 있습니다 — 개인 비서 커넥터
 * 범위와 같은 원칙입니다.
 */
export function validateChatImages(images: unknown): string | null {
  if (images == null) return null;

  if (!Array.isArray(images)) {
    return '이미지 형식이 올바르지 않습니다.';
  }

  if (images.length > MAX_CHAT_IMAGES) {
    return `이미지는 한 번에 ${MAX_CHAT_IMAGES}장까지 첨부할 수 있습니다.`;
  }

  let total = 0;

  for (const image of images) {
    if (!image || typeof image !== 'object') {
      return '이미지 형식이 올바르지 않습니다.';
    }

    const { media_type: mediaType, data } = image as Partial<ChatImage>;

    if (typeof mediaType !== 'string' || typeof data !== 'string' || !data) {
      return '이미지 형식이 올바르지 않습니다.';
    }

    if (!(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(mediaType)) {
      return 'JPG, PNG, GIF, WEBP 형식만 첨부할 수 있습니다.';
    }

    // base64 이외의 글자가 섞여 있으면 Anthropic이 400으로 거부한다.
    // 여기서 막으면 어디가 잘못됐는지 알 수 있다.
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      return '이미지 데이터가 손상되었습니다. 다시 첨부해주세요.';
    }

    const bytes = base64Bytes(data);
    if (bytes > MAX_IMAGE_BYTES) {
      return `이미지 한 장은 ${formatBytes(MAX_IMAGE_BYTES)}까지 첨부할 수 있습니다.`;
    }
    total += bytes;
  }

  if (total > MAX_TOTAL_IMAGE_BYTES) {
    return `이미지 전체 크기는 ${formatBytes(MAX_TOTAL_IMAGE_BYTES)}를 넘을 수 없습니다.`;
  }

  return null;
}

/**
 * 대화 이력에 남길 표시.
 *
 * **이미지 자체는 저장하지 않습니다.** 이유가 둘입니다.
 *
 * 하나는 비용입니다. 이력을 되돌려 보낼 때 이미지를 함께 보내면 **매 턴마다
 * 이미지 토큰이 다시 청구됩니다.** 이력 20개를 쓰는 구조라 한 장이 스무 번
 * 계산될 수 있습니다.
 *
 * 다른 하나는 공공기관 사정입니다. 이미지에는 현장 사진·신분증·명단처럼
 * 개인정보가 담기기 쉬운데, 보관하면 파기 정책과 열람 통제 대상이 하나
 * 늘어납니다. 감사 화면에서 질문 원문을 가린 것과 같은 판단입니다.
 *
 * 대신 **다음 턴에서 모델은 그 이미지를 다시 보지 못합니다.** 화면에서 그
 * 사실을 알려야 담당자가 "아까 그 사진 다시 봐"가 왜 안 되는지 압니다.
 */
export function imageAttachmentMarker(count: number): string {
  return `[첨부 이미지 ${count}장]`;
}
