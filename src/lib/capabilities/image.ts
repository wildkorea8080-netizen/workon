// src/lib/capabilities/image.ts
import type { Capability } from './types';

/** 사진 읽기 — 도구가 아니라 받을 수 있는 입력을 정한다. 꺼진 비서에 사진을 보내면 서버가 거절한다. */
export const image: Capability = {
  id: 'image',
  label: '사진 읽기',
  description: '화면 캡처·현장 사진·도표를 첨부받아 읽습니다.',
  acceptsImages: true,
  isAvailable: () => true,
};
