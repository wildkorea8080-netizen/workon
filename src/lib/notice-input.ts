import { addKstDays, kstDayStart } from './kst-time';

/**
 * 슈퍼관리자 공지 입력 검사(2026-11-19) — `POST /api/super/notices`·`PATCH /api/super/notices/[id]`. 잎 파일(kst-time만).
 *
 * 예전에는 꼴을 보지 않고 DB에 보냈다 —
 * - 만료일('YYYY-MM-DD')을 그대로 넣어 **그날 UTC 0시 = 한국 오전 9시**에 공지가 내려갔다(그날 하루 내내가 아니라)
 * - 중요도가 표 밖이면 공지 화면이 그 공지의 표시를 찾지 못했고, 대상 '특정 기관'에 기관이 없으면 아무에게도 안 보였다
 * - 기관 id가 uuid가 아니면 DB가 거절해 500, 제목·본문 길이 제한이 없었다
 */
export const NOTICE_IMPORTANCE = ['normal', 'important', 'urgent'] as const;
export type NoticeImportance = (typeof NOTICE_IMPORTANCE)[number];
export const MAX_NOTICE_TITLE = 200;
export const MAX_NOTICE_CONTENT = 20_000;
export const MAX_NOTICE_ORGS = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 만료일(한국 날짜) → 그날 한국 23:59:59.999. 틀린 날짜면 null */
export function noticeExpiryFromDay(day: string): string | null {
  const m = DAY.exec(day);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return new Date(kstDayStart(addKstDays(day, 1)).getTime() - 1).toISOString();
}

export interface NoticeFields {
  title?: string;
  content?: string;
  importance?: NoticeImportance;
  targetType?: 'all' | 'specific';
  targetOrgIds?: string[];
  isPublished?: boolean;
  expiresAt?: string | null;
}

/**
 * `partial`이면(고치기) 온 칸만 본다. 만들기는 제목·본문이 꼭 있어야 한다.
 * 대상이 '특정 기관'이면 기관이 하나 이상 — 대상이 '전체'면 기관 목록은 비운다.
 */
export function parseNoticeInput(body: unknown, partial: boolean): { ok: true; value: NoticeFields } | { ok: false; message: string } {
  if (!body || typeof body !== 'object') return { ok: false, message: '요청 형식이 올바르지 않습니다.' };
  const b = body as Record<string, unknown>;
  const v: NoticeFields = {};

  for (const [key, max, label] of [['title', MAX_NOTICE_TITLE, '제목'], ['content', MAX_NOTICE_CONTENT, '내용']] as const) {
    const raw = b[key];
    if (raw === undefined && partial) continue;
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return { ok: false, message: '제목, 내용 필수' };
    if (text.length > max) return { ok: false, message: `${label}은 ${max.toLocaleString('ko-KR')}자 안으로 적어 주세요.` };
    v[key] = text;
  }

  if (b.importance !== undefined) {
    if (!NOTICE_IMPORTANCE.includes(b.importance as NoticeImportance)) return { ok: false, message: '중요도 값이 올바르지 않습니다.' };
    v.importance = b.importance as NoticeImportance;
  }
  if (b.targetType !== undefined) {
    if (b.targetType !== 'all' && b.targetType !== 'specific') return { ok: false, message: '공지 대상 값이 올바르지 않습니다.' };
    v.targetType = b.targetType;
  }
  if (b.targetOrgIds !== undefined) {
    if (!Array.isArray(b.targetOrgIds) || b.targetOrgIds.length > MAX_NOTICE_ORGS || !b.targetOrgIds.every((id) => typeof id === 'string' && UUID.test(id)))
      return { ok: false, message: '대상 기관 값이 올바르지 않습니다.' };
    v.targetOrgIds = [...new Set(b.targetOrgIds as string[])];
  }
  if (v.targetType === 'all') v.targetOrgIds = [];
  if (v.targetType === 'specific' && !(v.targetOrgIds && v.targetOrgIds.length))
    return { ok: false, message: '특정 기관 공지는 대상 기관을 하나 이상 고르세요.' };

  if (b.isPublished !== undefined) {
    if (typeof b.isPublished !== 'boolean') return { ok: false, message: '발행 여부 값이 올바르지 않습니다.' };
    v.isPublished = b.isPublished;
  }
  if (b.expiresAt !== undefined) {
    if (b.expiresAt === null || b.expiresAt === '') v.expiresAt = null;
    else {
      const at = typeof b.expiresAt === 'string' ? noticeExpiryFromDay(b.expiresAt) : null;
      if (!at) return { ok: false, message: '만료일이 올바른 날짜가 아닙니다.' };
      v.expiresAt = at;
    }
  }
  return { ok: true, value: v };
}
