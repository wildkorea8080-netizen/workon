// src/lib/assistant/prompt.ts
import { imageAttachmentMarker, type ChatImage } from '@/lib/chat-images';
import type { LlmContentBlock } from '@/lib/llm/types';

export const DEFAULT_SYSTEM_PROMPT = '당신은 도움이 되는 AI 어시스턴트입니다.';

/** 비서 지시문 + 능력이 prepare에서 낸 글 */
export function buildSystemPrompt(base: string | null | undefined, addenda: (string | undefined)[]): string {
  return [base?.trim() || DEFAULT_SYSTEM_PROMPT, ...addenda.filter((a): a is string => Boolean(a))].join('\n\n');
}

/** 사진을 글보다 앞에 둔다 — Anthropic 권장. 모델이 무엇을 보고 답할지 먼저 잡는다. */
export function buildUserContent(message: string, images: ChatImage[]): string | LlmContentBlock[] {
  if (images.length === 0) return message;
  return [
    ...images.map(
      (img): LlmContentBlock => ({
        type: 'image',
        source: { type: 'base64', media_type: img.media_type, data: img.data },
      })
    ),
    { type: 'text', text: message },
  ];
}

/**
 * 사진 자체는 저장하지 않는다. 이력에 실어 되돌려 보내면 매 턴 사진 토큰이
 * 다시 청구되고(이력 20개), 현장 사진·명단 같은 개인정보를 보관하게 된다.
 * 대신 첨부가 있었다는 사실은 남긴다 — 없으면 나중에 답변의 근거를 알 수 없다.
 */
export function storedUserContent(message: string, imageCount: number): string {
  return imageCount > 0 ? `${imageAttachmentMarker(imageCount)}\n${message}` : message;
}
