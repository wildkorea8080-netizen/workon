// src/lib/work/store/errors.ts
import { WorkError } from '../types';

/** 0034 RPC가 던지는 SQLSTATE(WK…)를 서비스 오류로 바꾼다 — 두 구현(supabase·pg)이 같은 규칙을 쓴다 */
export function mapDbError(err: { code?: string; message?: string; details?: string | null; detail?: string | null } | null | undefined): never {
  const code = err?.code ?? '';
  const message = err?.message ?? '';
  if (code === 'WK404') throw new WorkError('NOT_FOUND', '작업을 찾을 수 없습니다.', 404);
  if (code === 'WK410') throw new WorkError('SUPERSEDED', '더 새 실행이 있어 이 결과는 반영하지 않았습니다.', 409);
  if (code === 'WK423') throw new WorkError('FORBIDDEN', '보관된 작업은 바꿀 수 없습니다.', 409);
  if (code === 'WK409' && message.includes('IDEMPOTENCY')) {
    throw new WorkError('IDEMPOTENCY_CONFLICT', '같은 요청 번호로 다른 내용을 보냈습니다. 새로 시도해 주세요.', 409);
  }
  if (code === 'WK409') {
    const current = Number(err?.details ?? err?.detail);
    throw new WorkError('VERSION_CONFLICT', '그 사이 문서가 바뀌었습니다. 최신 판을 불러온 뒤 다시 저장해 주세요.', 409, {
      currentVersion: Number.isFinite(current) ? current : null,
    });
  }
  throw new Error(`업무 DB 오류(${code || '알 수 없음'}): ${message.slice(0, 200)}`);
}
