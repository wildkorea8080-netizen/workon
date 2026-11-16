import { logSystem } from '@/lib/logger';

/**
 * 사용 기록(`usage_logs`) 쓰기 실패를 운영 기록에 남기기(2026-11-17).
 *
 * 사용 기록은 청구·예산 판정·감사의 근거다. 예전에는 쓰기가 실패하면 `console.error` 한 줄뿐이라(Vercel 함수 출력은 금방 사라진다)
 * **쓴 토큰이 청구되지 않고 한도에도 잡히지 않는 채로** 아무도 몰랐다 — 운영 DB에 `security_logs`가 없어 보안 로그가 조용히 사라졌던 것과
 * 같은 꼴(0097). 이제 실패하면 `system_logs`에 critical(payment)로 남겨 슈퍼관리자 로그 화면에서 보이게 한다.
 * 싣는 것은 부서·활동·오류 코드·모델·토큰·원가뿐이다(질문·파일 이름·사람 없음) — 나중에 손으로 맞출 수 있을 만큼만.
 */

export interface UsageFailureRow {
  departmentId: string | null;
  action: string;
  details: Record<string, unknown>;
}

export function usageFailureDetails(row: UsageFailureRow, code: string): Record<string, unknown> {
  const d = row.details ?? {};
  const pick = (k: string) => (typeof d[k] === 'number' || typeof d[k] === 'string' ? d[k] : null);
  return {
    department_id: row.departmentId,
    action: row.action,
    code,
    model: pick('model'),
    input_tokens: pick('input_tokens'),
    output_tokens: pick('output_tokens'),
    cost_krw: pick('cost_krw'),
  };
}

/** 던지지 않는다 — 운영 기록마저 실패하면 할 수 있는 것이 없다 */
export async function reportUsageLogFailure(
  row: UsageFailureRow,
  code: string,
  log: (p: Parameters<typeof logSystem>[0]) => Promise<void> = logSystem,
): Promise<void> {
  console.error('[usage] 사용 기록 실패', row.action, code);
  await log({ level: 'critical', category: 'payment', message: '사용 기록을 남기지 못했습니다(청구·한도에서 빠짐)', details: usageFailureDetails(row, code) }).catch(() => {});
}
