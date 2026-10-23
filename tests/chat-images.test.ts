import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import {
  validateChatImages,
  base64Bytes,
  imageAttachmentMarker,
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_CHAT_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
} from '../src/lib/chat-images';
import { buildUserContent, storedUserContent } from '../src/lib/assistant/prompt';
import { buildMessageRows } from '../src/lib/assistant/persist';

/**
 * 첨부 이미지 검사.
 *
 * 여기서 놓치면 Anthropic이 400을 주는데, 그 오류로는 어느 이미지가 왜
 * 문제인지 알 수 없다. 사용자에게는 "오류가 발생했습니다"만 남는다.
 */

/** 지정한 바이트 수가 되는 base64 문자열 */
const b64OfBytes = (bytes: number) => Buffer.alloc(bytes, 0x41).toString('base64');

const okImage = (bytes = 1024) => ({
  media_type: 'image/jpeg',
  data: b64OfBytes(bytes),
});

describe('크기 계산', () => {
  it('디코딩하지 않고 바이트 수를 센다', () => {
    for (const n of [1, 2, 3, 100, 1023, 4096]) {
      expect(base64Bytes(b64OfBytes(n)), `${n}바이트`).toBe(n);
    }
  });
});

describe('첨부 검사', () => {
  it('없으면 통과한다', () => {
    expect(validateChatImages(undefined)).toBeNull();
    expect(validateChatImages(null)).toBeNull();
    expect(validateChatImages([])).toBeNull();
  });

  it('정상 이미지를 통과시킨다', () => {
    expect(validateChatImages([okImage(), okImage()])).toBeNull();
  });

  it('장수 상한을 넘으면 막는다', () => {
    const many = Array.from({ length: MAX_CHAT_IMAGES + 1 }, () => okImage());
    expect(validateChatImages(many)).toMatch(/장까지/);
  });

  it('허용하지 않는 형식을 막는다', () => {
    // 아이폰 기본 형식. canvas가 디코딩하지 못하고 Anthropic도 받지 않는다.
    expect(validateChatImages([{ media_type: 'image/heic', data: b64OfBytes(10) }])).toMatch(
      /JPG, PNG, GIF, WEBP/
    );
    expect(validateChatImages([{ media_type: 'application/pdf', data: b64OfBytes(10) }])).not.toBeNull();
  });

  it('base64가 아닌 값을 막는다', () => {
    // data: 접두사를 떼지 않고 보내는 것이 가장 흔한 실수다.
    expect(
      validateChatImages([{ media_type: 'image/png', data: 'data:image/png;base64,AAAA' }])
    ).toMatch(/손상/);
  });

  it('한 장의 크기 상한을 건다', () => {
    expect(validateChatImages([okImage(MAX_IMAGE_BYTES + 1)])).toMatch(/한 장은/);
    expect(validateChatImages([okImage(MAX_IMAGE_BYTES)])).toBeNull();
  });

  it('합계 상한을 건다', () => {
    // 각각은 통과하는데 합치면 Vercel 요청 본문 상한(4.5MB)을 넘는 경우.
    // 장당 검사만 있으면 서버 코드가 돌기도 전에 잘려 원인을 알 수 없다.
    const each = Math.floor(MAX_TOTAL_IMAGE_BYTES / 2) + 1024;
    expect(each).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    expect(validateChatImages([okImage(each), okImage(each)])).toMatch(/전체 크기/);
  });

  it('배열이 아니거나 모양이 틀리면 막는다', () => {
    expect(validateChatImages('이미지')).not.toBeNull();
    expect(validateChatImages([{ media_type: 'image/png' }])).not.toBeNull();
    expect(validateChatImages([null])).not.toBeNull();
  });
});

describe('상한 값의 근거', () => {
  it('합계가 Vercel 요청 본문 상한(4.5MB) 안에 든다', () => {
    // base64는 원본보다 약 33% 크다. 이 관계가 깨지면 상한을 올린 순간
    // 요청이 서버에 닿지 못하고 잘린다.
    const encoded = MAX_TOTAL_IMAGE_BYTES * (4 / 3);
    expect(encoded).toBeLessThan(4.5 * 1024 * 1024);
  });

  it('한 장 상한이 합계 상한을 넘지 않는다', () => {
    expect(MAX_IMAGE_BYTES).toBeLessThanOrEqual(MAX_TOTAL_IMAGE_BYTES);
  });
});

describe('이력 표시', () => {
  it('첨부 사실을 남긴다', () => {
    // 이미지 자체는 저장하지 않는다. 표시까지 없으면 나중에 대화를 봤을 때
    // 답변의 근거가 무엇이었는지 알 수 없다.
    expect(imageAttachmentMarker(2)).toContain('2장');
  });
});

describe('대화 실행기 연결', () => {
  const prepare = readFileSync('src/lib/assistant/prepare.ts', 'utf8');

  it('서버가 검사를 다시 한다', () => {
    // 화면 검사는 표시일 뿐이다. API를 직접 부르는 경로가 언제나 있다.
    expect(prepare).toContain('validateChatImages(images)');
  });

  it('사진 읽기가 꺼진 비서는 사진을 거절한다', () => {
    expect(prepare).toContain('acceptsImages');
  });

  it('이미지를 텍스트보다 앞에 둔다', () => {
    const content = buildUserContent('질문', [{ media_type: 'image/png', data: 'AAAA' } as never]);
    expect((content as { type: string }[]).map((b) => b.type)).toEqual(['image', 'text']);
  });

  it('이미지 바이트를 DB에 저장하지 않는다', () => {
    // 사진이 있는 턴의 메시지 행을 그대로 만들어 본다. 실행기가 실제로 DB에
    // 넣는 행은 tests/stream-turn.test.ts가 가짜 DB로 확인한다.
    const data = Buffer.from('사진 바이트는 남기면 안 된다').toString('base64');
    const images = [{ media_type: 'image/png', data }] as never;
    expect(JSON.stringify(buildUserContent('질문', images))).toContain(data); // 모델에는 간다
    const rows = buildMessageRows({
      conversationId: 'c', userId: 'u', userContent: storedUserContent('질문', 1),
      assistantText: '답', chunks: [], links: [], files: [], attachments: [], agentVersion: 1, documentsSkipped: false,
    });
    expect(JSON.stringify(rows)).not.toContain(data);
    expect(rows[0].content).toContain('1장');
  });
});

describe('사진 첨부 버튼 (화면 표시)', () => {
  it('사진 읽기가 켜진 비서만 사진을 받는다', async () => {
    const { acceptsChatImages } = await import('../src/lib/capabilities/settings');
    expect(acceptsChatImages({ image: {} })).toBe(true);
    expect(acceptsChatImages({ image: {}, doc_search: {} })).toBe(true);
    expect(acceptsChatImages({ doc_search: {} })).toBe(false);
    expect(acceptsChatImages({})).toBe(false);
    expect(acceptsChatImages(null)).toBe(false);
    expect(acceptsChatImages(undefined)).toBe(false);
    expect(acceptsChatImages({ image: true })).toBe(false); // 깨진 값은 닫는다
    expect(acceptsChatImages('image')).toBe(false);
  });

  it('꺼진 비서에서는 첨부 버튼을 내지 않는다', () => {
    // 서버가 거절하므로(prepare.ts acceptsImages) 버튼을 두면 보낸 뒤에야 실패를 안다
    const ui = readFileSync('src/components/chat/ChatInterface.tsx', 'utf8');
    expect(ui).toMatch(/const canAttachImages =[\s\S]{0,120}acceptsChatImages\(selectedAgent\.capabilities\)/);
    // 첨부 단추 하나가 사진과 파일을 함께 받는다. 둘 다 꺼진 비서에서만 단추가 없다
    expect(ui).toMatch(/const canAttachAnything = canAttachImages \|\| canAttachFiles/);
    expect(ui).toMatch(/\{canAttachAnything && \(\s*<input/);
    // 사진 형식은 사진이 켜진 비서에서만 accept에 든다
    expect(ui).toMatch(/\.\.\.\(canAttachImages \? \[IMAGE_ACCEPT_ATTRIBUTE\] : \[\]\)/);
  });
});

describe('형식 목록은 한 곳에만', () => {
  it('클라이언트가 같은 목록을 쓴다', () => {
    // 업로드 파일 형식에서 목록이 흩어져 두 번 어긋난 적이 있다.
    const ui = readFileSync('src/components/chat/ChatInterface.tsx', 'utf8');
    expect(ui).toContain('IMAGE_ACCEPT_ATTRIBUTE');
    expect(ui).not.toMatch(/accept="image\//);
  });

  it('축소 모듈도 같은 목록을 본다', () => {
    const resize = readFileSync('src/lib/image-resize.ts', 'utf8');
    expect(resize).toContain('ALLOWED_IMAGE_MIME_TYPES');
    expect(ALLOWED_IMAGE_MIME_TYPES).toContain('image/jpeg');
  });
});
