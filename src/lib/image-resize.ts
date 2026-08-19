'use client';

import {
  IMAGE_MAX_EDGE,
  MAX_IMAGE_BYTES,
  ALLOWED_IMAGE_MIME_TYPES,
  type ChatImage,
} from '@/lib/chat-images';

/**
 * 첨부 이미지를 보내기 전에 브라우저에서 줄인다.
 *
 * 서버로 그대로 보내면 두 군데서 막힌다.
 *
 * - **Vercel 서버리스 함수의 요청 본문 상한이 4.5MB**다. 요즘 휴대폰 사진은
 *   한 장에 3~5MB이고 base64는 33% 더 커지므로 한 장으로도 넘긴다. 상한을
 *   넘으면 서버 코드가 돌기도 전에 잘려 원인을 알 수 없는 실패가 된다.
 * - Anthropic은 긴 변 1568px보다 큰 이미지를 어차피 줄인다. 미리 줄이면
 *   전송량과 토큰이 함께 작아진다 — 줄이지 않을 이유가 없다.
 *
 * 브라우저 전용이다(canvas). 서버는 이 파일을 import 하지 않는다.
 */

/** 파일 하나를 Anthropic이 받는 형태로 바꾼다. */
export async function fileToChatImage(file: File): Promise<ChatImage> {
  if (!(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
    // 아이폰 기본 형식(HEIC)이 여기 걸린다. canvas가 디코딩하지 못해
    // 축소 단계에서 실패하므로, 그 전에 무엇을 해야 하는지 알려준다.
    throw new Error('JPG, PNG, GIF, WEBP 형식만 첨부할 수 있습니다.');
  }

  const bitmap = await loadBitmap(file);

  try {
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));

    // GIF는 줄이면 첫 프레임만 남아 움직임이 사라진다. 상한 안에 들면 원본을
    // 그대로 보낸다 — 화면 녹화를 붙이는 경우가 실제로 있다.
    if (file.type === 'image/gif' && file.size <= MAX_IMAGE_BYTES) {
      return { media_type: file.type, data: await fileToBase64(file) };
    }

    // 줄일 필요가 없고 크기도 괜찮으면 다시 인코딩하지 않는다.
    // JPEG를 재인코딩하면 화질만 떨어진다.
    if (scale === 1 && file.size <= MAX_IMAGE_BYTES) {
      return { media_type: file.type, data: await fileToBase64(file) };
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('이미지를 처리할 수 없습니다. 다른 브라우저에서 시도해주세요.');

    // 투명 PNG를 JPEG로 바꾸면 투명한 부분이 검게 나온다. 흰 바탕을 깔아 둔다.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    // 화면 캡처·문서 사진 모두 JPEG로 충분하고, PNG는 사진에서 몇 배 커진다.
    let quality = 0.85;
    let data = await canvasToBase64(canvas, quality);

    // 그래도 크면 화질을 낮춘다. 여기서 못 줄이면 서버가 거절하는데,
    // 사용자는 왜 안 되는지 알 수 없다.
    while (approxBytes(data) > MAX_IMAGE_BYTES && quality > 0.4) {
      quality -= 0.15;
      data = await canvasToBase64(canvas, quality);
    }

    return { media_type: 'image/jpeg', data };
  } finally {
    // ImageBitmap은 명시적으로 닫지 않으면 메모리를 붙들고 있다
    bitmap.close?.();
  }
}

function approxBytes(base64: string): number {
  return Math.floor((base64.length * 3) / 4);
}

async function loadBitmap(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    throw new Error('이미지를 읽을 수 없습니다. 파일이 손상되었는지 확인해주세요.');
  }
}

function canvasToBase64(canvas: HTMLCanvasElement, quality: number): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('이미지를 변환하지 못했습니다.'));
          return;
        }
        blobToBase64(blob).then(resolve, reject);
      },
      'image/jpeg',
      quality
    );
  });
}

function fileToBase64(file: File): Promise<string> {
  return blobToBase64(file);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('이미지를 읽지 못했습니다.'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      // data:image/jpeg;base64,XXXX 에서 뒤쪽만 쓴다.
      // 접두사를 붙인 채 보내면 Anthropic이 400으로 거부한다.
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}
