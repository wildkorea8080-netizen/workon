// src/lib/org-api/chat-attachments.ts
// 기관 API '비서에게 묻기'의 첨부(2026-11-24, 0105) — 범위 chat.
// 기관 시스템(민원 창구·업무 봇)이 민원 첨부·보고서 같은 파일을 붙여 묻는다.
//
//   ① POST /api/v1/chat/attachments/upload-url { fileName, size }  → { attachmentId, uploadUrl, method: 'PUT', headers, expiresAt }
//   ② uploadUrl에 파일 바이트를 그대로 PUT
//   ③ POST /api/v1/chat/attachments { attachmentId }                → 읽은 결과 { attachmentId, fileName, sizeBytes, status, error, summary }
//   ④ POST /api/v1/chat { …, attachmentIds: [...] }                  → 그 파일을 붙여 묻는다
//
// 첨부의 주인은 **키를 만든 기관 전체 관리자**다(대화와 같다) — 화면 대화 첨부와 같은 함수(createUpload·confirmUpload)라
// 형식·10MB·보내지 않은 첨부 20개·10분 확인 창·스캔 PDF(NODA /parse)·사용 기록·24시간 정리가 화면과 같다.
// 붙일 수 있는지(파일 받아 읽기가 켜진 비서인지·이 사람의 보내지 않은 첨부인지)는 ④에서 대화 실행기가 다시 본다.
import { createUpload, confirmUpload } from '@/lib/attachments/store';
import { CONFIRM_WINDOW_MS } from '@/lib/attachments/limits';
import type { AttachmentRow } from '@/lib/attachments/types';
import type { OrgApiContext } from './keys';

type Out = { data: unknown } | { status: number; message: string; code?: string };

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export interface ChatAttachmentIo {
  createUpload: typeof createUpload;
  confirmUpload: typeof confirmUpload;
  now(): number;
}
const defaultIo = (): ChatAttachmentIo => ({ createUpload, confirmUpload, now: () => Date.now() });

const actorOf = (ctx: OrgApiContext) => ({ userId: ctx.creatorId, departmentId: ctx.creatorDepartmentId, organizationId: ctx.organizationId });

/** ① 올리기 주소 — 경로는 서버가 정하고(키 주인의 첨부 자리), 서명 주소는 저장소가 준다 */
export async function issueChatAttachmentUrl(ctx: OrgApiContext, raw: unknown, io: ChatAttachmentIo = defaultIo()): Promise<Out> {
  const b = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null) as Record<string, unknown> | null;
  if (!b) return { status: 400, message: '요청 몸은 JSON 객체로 보내 주세요.' };
  if (typeof b.fileName !== 'string' || !b.fileName.trim()) return { status: 400, message: 'fileName에 파일 이름(확장자 포함)을 적어 주세요.' };
  if (typeof b.size !== 'number' || !Number.isInteger(b.size) || b.size <= 0) return { status: 400, message: 'size에 파일 크기(바이트, 양의 정수)를 적어 주세요.' };
  const issued = await io.createUpload(actorOf(ctx), { fileName: b.fileName.normalize('NFC'), size: b.size });
  if (!issued.ok) return { status: issued.status, message: issued.message };
  if (!issued.signedUrl) return { status: 503, message: '올리기 주소를 만들지 못했습니다. 잠시 뒤 다시 호출해 주세요.' };
  return {
    data: {
      attachmentId: issued.id,
      uploadUrl: issued.signedUrl,
      method: 'PUT',
      headers: { 'Content-Type': issued.mimeType ?? 'application/octet-stream' },
      // 서명 주소 자체는 더 살지만 확인(③)은 발급 10분 안에만 받는다
      expiresAt: new Date(io.now() + CONFIRM_WINDOW_MS).toISOString(),
    },
  };
}

/** 첨부 → 밖에 보일 꼴(저장소 경로·사람 id 없음) */
export function attachmentView(a: AttachmentRow) {
  return {
    attachmentId: a.id,
    fileName: a.file_name,
    sizeBytes: a.size_bytes,
    status: a.status,
    error: a.error,
    summary: a.summary
      ? {
          kind: a.summary.kind,
          pages: a.summary.pages ?? null,
          sheets: a.summary.sheets ?? [],
          tables: a.summary.tables.map((t) => ({ id: t.id, title: t.title, rows: t.rows, columns: t.columns })),
          warnings: a.summary.warnings,
        }
      : null,
  };
}

/**
 * ③ 올린 파일 확인·읽기 — 읽지 못한 파일(암호·DRM·스캔을 못 읽음)은 200 + status 'failed'와 까닭(화면과 같다).
 * 이 키 주인의 첨부만(남의 것·없는 것 404), 10분 지나면 410
 */
export async function confirmChatAttachment(ctx: OrgApiContext, raw: unknown, io: ChatAttachmentIo = defaultIo()): Promise<Out> {
  const b = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null) as Record<string, unknown> | null;
  if (!b) return { status: 400, message: '요청 몸은 JSON 객체로 보내 주세요.' };
  if (!isUuid(b.attachmentId)) return { status: 400, message: 'attachmentId는 올리기 주소 응답의 attachmentId(uuid)를 그대로 넣어 주세요.' };
  const confirmed = await io.confirmUpload(actorOf(ctx), b.attachmentId.toLowerCase());
  if (!confirmed.ok) return { status: confirmed.status, message: confirmed.message };
  return { data: attachmentView(confirmed.attachment) };
}
